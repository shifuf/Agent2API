//! Daily backup worker: debounce account changes and check the calendar every minute.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{channel, Receiver, Sender};

use crate::server::core::crypto::{self, SecretScope};
use crate::server::db::Db;
use crate::server::logging;

use super::{policy, settings, snapshot};

/// 第一个信号之后的等待窗口（合并窗口内到达的信号不再单独上传）
const DEBOUNCE_MS: u64 = 1_000;
/// 连续信号下的最长等待：到点必须传一次
const MAX_WAIT_MS: u64 = 10_000;

static CHANGE_TX: OnceLock<Sender<()>> = OnceLock::new();
static SUPPRESS_DEPTH: AtomicUsize = AtomicUsize::new(0);

/// 抑制守卫：作用域内不触发自动上传（下载应用期间用）。
///
/// 用计数而不是布尔：将来若有嵌套场景，布尔会让内层的 `drop` 提前解除抑制。
pub(crate) struct SuppressionGuard;

impl SuppressionGuard {
    pub(crate) fn new() -> Self {
        SUPPRESS_DEPTH.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for SuppressionGuard {
    fn drop(&mut self) {
        let _ = SUPPRESS_DEPTH.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            Some(value.saturating_sub(1))
        });
    }
}

fn is_suppressed() -> bool {
    SUPPRESS_DEPTH.load(Ordering::SeqCst) > 0
}

/// 这个表名要不要触发自动同步（唯一判定，钩子与测试共用）
pub(crate) fn should_trigger_for_table(table: &str) -> bool {
    snapshot::SYNCED_TABLES.contains(&table)
}

/// 发一个「本地数据变了」的信号。非阻塞：通道满（已有待处理信号）时直接丢弃 ——
/// 我们要的是「脏了」这件事，不是每一次变化。
///
/// **可以在持有数据库连接锁的钩子里调用**：不做 IO、不打日志、不取锁。
pub(crate) fn notify_change() {
    if is_suppressed() {
        return;
    }
    let Some(tx) = CHANGE_TX.get() else {
        return;
    };
    match tx.try_send(()) {
        Ok(()) => {}
        // 缓冲 1：满了说明已有一个待处理信号，本次合并进去即可
        Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => {}
    }
}

/// SQLite `update_hook` 的回调入口。
///
/// ── 硬约束：这里必须极快 ────────────────────────────────────
/// 钩子在语句执行期间被调用（连接锁已被持有）。因此只做一次数组查找 + 一次
/// 非阻塞 send，**绝不**查库、不打日志（`logging::log` 要写同一个库 → 死锁）。
pub(crate) fn on_table_change(table: &str) {
    if should_trigger_for_table(table) {
        notify_change();
    }
}

/// 启动自动同步工作线程（`bootstrap` 里调一次）。
///
/// ── 为什么线程里现读设置 ────────────────────────────────────
/// 用户在设置页改开关后要立刻生效，不必重启。工作线程每轮都从
/// `settings::load()` 读最新值（一次 kv 查询，频率是「有信号时」）。
pub(crate) fn spawn_worker(db: Db) {
    if CHANGE_TX.get().is_some() {
        return;
    }
    let (tx, rx) = channel::<()>(1);
    if CHANGE_TX.set(tx).is_err() {
        return;
    }
    crate::spawn_task(async move {
        run_worker(db, rx).await;
    });
}

async fn run_worker(db: Db, mut rx: Receiver<()>) {
    let mut timer = tokio::time::interval(Duration::from_secs(60));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut retry: Option<(String, Instant)> = None;
    loop {
        tokio::select! {
            value = rx.recv() => if value.is_none() { return; },
            _ = timer.tick() => {},
        }
        let started = Instant::now();
        // 防抖：等到「安静 1 秒」或「总共 10 秒」，以先到者为准
        loop {
            let elapsed = started.elapsed();
            if elapsed >= Duration::from_millis(MAX_WAIT_MS) {
                break;
            }
            let remaining = Duration::from_millis(MAX_WAIT_MS) - elapsed;
            let wait = Duration::from_millis(DEBOUNCE_MS).min(remaining);
            match tokio::time::timeout(wait, rx.recv()).await {
                Ok(Some(())) => continue,
                // 通道关闭 = 进程在退出
                Ok(None) => return,
                // 安静窗口到了
                Err(_) => break,
            }
        }
        let scope = policy::target_scope(&settings::load());
        if retry.as_ref().is_some_and(|(target, until)| target == &scope && Instant::now() < *until) { continue; }
        match run_once(&db).await {
            Err(error) => {
                retry = Some((scope, Instant::now() + Duration::from_secs(300)));
                super::record_failure(&error, "auto");
            }
            Ok(_) => retry = None,
        }
    }
}

static RECENT_UPLOADS: OnceLock<Mutex<BTreeMap<String, policy::UploadState>>> = OnceLock::new();
/// Keep a successful commit in memory too, so failed status persistence cannot cause a loop.
pub(crate) fn note_upload(state: policy::UploadState) {
    let mut recent = RECENT_UPLOADS.get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock().unwrap_or_else(|error| error.into_inner());
    recent.insert(state.scope.clone(), state);
}
fn upload_due(settings: &settings::CloudSyncSettings, ids: &BTreeSet<String>, now: i64) -> bool {
    let scope = policy::target_scope(settings);
    let recent = RECENT_UPLOADS.get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock().unwrap_or_else(|error| error.into_inner());
    let persisted = settings.status.sync_baselines.get(&scope)
        .or_else(|| settings.status.last_upload.as_ref().filter(|state| state.scope == scope));
    let memory = recent.get(&scope);
    let state = match (persisted, memory) {
        (Some(a), Some(b)) => Some(if a.uploaded_at >= b.uploaded_at { a } else { b }),
        (a, b) => a.or(b),
    };
    policy::should_upload(state, &scope, now, ids, &crypto::key_fingerprint(SecretScope::Accounts))
}
async fn run_once(db: &Db) -> Result<bool, String> {
    let _guard = super::sync_lock().lock().await;
    let settings = settings::load();
    if !settings.enabled || !settings.auto_sync || is_suppressed() { return Ok(false); }
    settings.validate()?;
    let ids = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM accounts ORDER BY id").map_err(|e|e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_,String>(0)).map_err(|e|e.to_string())?;
        rows.collect::<Result<BTreeSet<_>,_>>().map_err(|e|e.to_string())
    }).ok_or_else(|| "数据库连接不可用".to_string())??;
    if !upload_due(&settings, &ids, logging::now_ms()) { return Ok(false); }
    super::upload_locked(db, &settings).await?;
    logging::verbose("[CloudSync]", "自动备份：每日或新增账号快照已上传");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_business_tables_trigger() {
        assert!(should_trigger_for_table("accounts"));
        assert!(should_trigger_for_table("checkin_records"));
        assert!(should_trigger_for_table("account_usage_records"));
        assert!(!should_trigger_for_table("logs"));
        assert!(!should_trigger_for_table("requests"));
        assert!(!should_trigger_for_table("debug_traffic"));
        assert!(!should_trigger_for_table("kv"));
    }

    #[test]
    fn suppression_guard_is_scoped() {
        assert!(!is_suppressed());
        {
            let _guard = SuppressionGuard::new();
            assert!(is_suppressed());
            {
                let _nested = SuppressionGuard::new();
                assert!(is_suppressed());
            }
            assert!(is_suppressed(), "内层释放后外层仍应抑制");
        }
        assert!(!is_suppressed());
    }
}
