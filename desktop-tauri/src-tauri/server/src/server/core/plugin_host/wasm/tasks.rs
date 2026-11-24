use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use crate::server::core::{account_store::AccountStore, task_state::{self, Claim, ManualBackoff}};
use crate::server::{config, logging};
use super::super::{Host, registry};
mod settings;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Definition {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub times: Vec<String>,
    #[serde(default)]
    pub interval_ms: Option<i64>,
    #[serde(default = "zone")]
    pub utc_offset_minutes: i32,
    #[serde(default)]
    pub checkin: bool,
    #[serde(default)]
    pub legacy_config: Option<String>,
}
fn zone() -> i32 { 480 }

fn definitions() -> &'static Mutex<HashMap<String, Vec<Definition>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Vec<Definition>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RunningOperation { id: String, cancel: CancellationToken, finished: CancellationToken }

fn operations() -> &'static Mutex<HashMap<String, RunningOperation>> {
    static TABLE: OnceLock<Mutex<HashMap<String, RunningOperation>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn operation_key(provider: &str, id: &str) -> String {
    format!("pluginTaskOperation:{provider}:{id}")
}

fn operation_snapshot(state: &task_state::TaskState) -> Value {
    json!({ "running": state.running(), "startedAt": state.last_attempt_at,
        "finishedAt": state.last_run_at, "error": state.last_error,
        "message": state.last_result, "result": state.value })
}

pub(crate) async fn load(host: &Host, provider: &str) -> Result<(), String> {
    if host.options.wasm.as_ref().is_none_or(|options| !options.allows("tasks.v1")) {
        return Err("插件未声明任务能力".into());
    }
    let declared = host.call_coded("tasks.list", json!({ "provider": provider }), Duration::from_secs(10)).await
        .map_err(|error| error.message)?;
    let mut tasks: Vec<Definition> = serde_json::from_value(declared).map_err(|_| "插件任务声明格式无效")?;
    if tasks.len() > 32 { return Err("插件任务数量超过上限".into()); }
    let mut ids = std::collections::HashSet::new();
    let mut checkin = false;
    for task in &mut tasks {
        if task.checkin && (checkin || task.interval_ms.is_some() || task.times.len() != 1) {
            return Err("签到窗口只能声明一条每日时刻".into());
        }
        checkin |= task.checkin;
        if task.legacy_config.as_deref().is_some_and(|key| key != "growthSchedule") {
            return Err("任务不允许读取其他主程序配置".into());
        }
        if task.id.is_empty() || task.id.len() > 64 || !task.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            || !ids.insert(task.id.clone()) || task.label.is_empty() || task.label.len() > 256
            || !(-720..=840).contains(&task.utc_offset_minutes) || task.times.len() > 24
            || task.interval_ms.is_some_and(|ms| !(60_000..=30 * 86_400_000).contains(&ms))
            || task.interval_ms.is_some() == !task.times.is_empty() {
            return Err("插件任务名称或排程无效".into());
        }
        for time in &mut task.times { *time = super::super::schedules::normalize_time(time).ok_or("插件任务时刻无效")?; }
        task.times.sort(); task.times.dedup();
    }
    definitions().lock().map_err(|_| "插件任务列表不可用")?.insert(provider.into(), tasks);
    Ok(())
}

pub(crate) fn forget(provider: &str) {
    if let Ok(mut table) = definitions().lock() { table.remove(provider); }
    if let Ok(table) = operations().lock() {
        let prefix = format!("pluginTaskOperation:{provider}:");
        for (_, operation) in table.iter().filter(|(key, _)| key.starts_with(&prefix)) {
            operation.cancel.cancel();
        }
    }
}

pub(crate) fn checkin_time(provider: &str) -> Option<String> {
    let table = definitions().lock().ok()?;
    let task = table.get(provider)?.iter().find(|task| task.checkin)?;
    let time = chrono::NaiveTime::parse_from_str(task.times.first()?, "%H:%M").ok()?;
    let minutes = (time.num_seconds_from_midnight() as i32 / 60 + 480 - task.utc_offset_minutes).rem_euclid(1440);
    Some(format!("{:02}:{:02}", minutes / 60, minutes % 60))
}

fn current(provider: &str, task: &Definition) -> Definition {
    config::with_raw(|raw| settings::from_raw(raw, provider, task)).unwrap_or_else(|| {
        let mut task = task.clone(); task.enabled = false; task
    })
}

pub(crate) fn snapshot() -> Value {
    let table = definitions().lock().map(|table| table.clone()).unwrap_or_default();
    let states = task_state::read_all().unwrap_or_default();
    json!(table.into_iter().filter(|(provider, _)| registry::serves(provider)).flat_map(|(provider, tasks)| {
        let states = &states;
        tasks.into_iter().filter(|task| !task.checkin).map(move |task| {
            let task = current(&provider, &task);
            let prefix = format!("pluginTask:{provider}:{}:", task.id);
            let runs: Vec<_> = states.iter().filter(|(key, _)| key.starts_with(&prefix))
                .map(|(key, state)| json!({ "account": key.strip_prefix(&prefix), "running": state.running(),
                    "lastRunAt": state.last_run_at, "nextRunAt": state.next_run_at, "error": state.last_error, "result": state.last_result })).collect();
            let operation = states.get(&operation_key(&provider, &task.id)).map(operation_snapshot);
            json!({ "provider": provider, "task": task, "runs": runs, "operation": operation })
        }).collect::<Vec<_>>()
    }).collect::<Vec<_>>())
}

pub(crate) fn configure(provider: &str, id: &str, patch: &Value) -> Result<bool, String> {
    if !super::has_capability(provider, "tasks.v1") || !registry::serves(provider) { return Err("插件任务当前不可用".into()); }
    let task = definitions().lock().map_err(|_| "任务列表不可用")?.get(provider)
        .and_then(|tasks| tasks.iter().find(|task| task.id == id && !task.checkin)).cloned().ok_or("任务不存在")?;
    if !patch.is_object() || patch.as_object().is_some_and(|map| map.keys().any(|key| !matches!(key.as_str(), "enabled" | "times")))
        || patch.get("enabled").is_some_and(|value| !value.is_boolean()) { return Err("任务设置无效".into()); }
    if let Some(times) = patch.get("times") {
        let times = times.as_array().ok_or("任务时刻必须是数组")?;
        if task.interval_ms.is_some() || times.is_empty() || times.len() > if task.legacy_config.is_some() { super::super::schedules::MAX_TIMES } else { 24 }
            || times.iter().any(|time| time.as_str().and_then(super::super::schedules::normalize_time).is_none()) {
            return Err("任务时刻无效".into());
        }
    }
    settings::save(provider, &task, patch)?;
    if patch["enabled"] == false {
        if let Ok(table) = operations().lock() {
            if let Some(operation) = table.get(&operation_key(provider, id)) { operation.cancel.cancel(); }
        }
    }
    super::super::schedules::wake();
    Ok(true)
}

fn interval(task: &Definition, now: i64) -> (bool, i64, i64) {
    if let Some(interval) = task.interval_ms { return (true, interval, 0); }
    let offset = i64::from(task.utc_offset_minutes) * 60_000;
    let local = now + offset;
    let day = local.div_euclid(86_400_000) * 86_400_000 - offset;
    let times: Vec<i64> = task.times.iter().filter_map(|time| {
        let parsed = chrono::NaiveTime::parse_from_str(time, "%H:%M").ok()?;
        Some(day + i64::from(parsed.num_seconds_from_midnight()) * 1000)
    }).collect();
    let due = times.iter().copied().filter(|at| *at <= now).max().unwrap_or(0);
    let next = times.iter().copied().filter(|at| *at > now).min()
        .or_else(|| times.iter().min().map(|at| at + 86_400_000)).unwrap_or(now + 86_400_000);
    (due > 0, (next - now).max(1000), due)
}

fn definition(provider: &str, id: &str) -> Result<Definition, String> {
    if !super::has_capability(provider, "tasks.v1") || !registry::serves(provider) { return Err("插件任务当前不可用".into()); }
    let task = definitions().lock().map_err(|_| "任务列表不可用")?.get(provider)
        .and_then(|tasks| tasks.iter().find(|task| task.id == id && !task.checkin)).cloned().ok_or("任务不存在")?;
    Ok(current(provider, &task))
}

pub(crate) fn legacy_definition(provider: &str, id: &str) -> Option<Definition> {
    definition(provider, id).ok().filter(|task| task.legacy_config.as_deref() == Some("growthSchedule"))
}

pub(crate) fn operation_running(provider: &str, id: &str) -> bool {
    task_state::read(&operation_key(provider, id)).is_ok_and(|state| state.running())
}

struct Operation {
    key: String,
    id: String,
    cancel: CancellationToken,
    finished: CancellationToken,
    lease: Option<task_state::RunGuard>,
    manual: bool,
    results: Vec<Value>,
}

impl Operation {
    fn claim(provider: &str, id: &str, manual: bool) -> Result<Option<Self>, String> {
        // Serialize admission with shutdown, so the stop snapshot cannot miss a
        // just-admitted manual operation. This lock never crosses an await.
        let lifecycle = scheduler().lock().map_err(|_| "插件任务生命周期不可用")?;
        if matches!(*lifecycle, Scheduler::Stopping(_) | Scheduler::Stopped) { return Err("插件任务正在关闭".into()); }
        let key = operation_key(provider, id);
        // Account claims retain their real schedules and backoff. This outer
        // claim prevents manual/scheduled rounds from overlapping one task.
        let lease = match task_state::claim(&key, 1000, true, ManualBackoff::Respect, 1000)? {
            Claim::Acquired(lease) => lease,
            Claim::Deferred(_) => return Ok(None),
        };
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|_| "无法生成任务运行标识")?;
        let id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let cancel = CancellationToken::new();
        let finished = CancellationToken::new();
        let operation = Self { key: key.clone(), id: id.clone(), cancel: cancel.clone(),
            finished: finished.clone(), lease: Some(lease), manual, results: Vec::new() };
        operations().lock().map_err(|_| "任务运行状态不可用")?.insert(key, RunningOperation { id, cancel, finished });
        operation.progress("running")?;
        Ok(Some(operation))
    }

    fn value(&self, status: &str) -> Value {
        json!({ "id": self.id, "status": status, "manual": self.manual, "results": self.results })
    }

    fn progress(&self, status: &str) -> Result<(), String> {
        self.lease.as_ref().ok_or("任务执行权已释放")?.store_progress(self.value(status))
    }

    fn finish(&mut self, result: &Result<(), String>) -> Result<Value, String> {
        let success = result.is_ok() && self.results.iter().all(|entry| entry["success"] == true);
        let status = if self.cancel.is_cancelled() { "canceled" } else { "finished" };
        let value = self.value(status);
        let summary = match result {
            Err(error) => super::super::process::redact(error),
            Ok(()) if self.results.is_empty() => "当前没有可执行的账号任务".into(),
            Ok(()) if success => format!("已完成 {} 个账号的任务", self.results.len()),
            Ok(()) => "部分账号任务执行失败".into(),
        };
        let state = self.lease.take().ok_or("任务执行权已释放")?
            .finish(success, summary, Some(value), 0, 1000)?;
        Ok(operation_snapshot(&state))
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.cancel.cancel();
        drop(self.lease.take());
        if let Ok(mut table) = operations().lock() {
            if table.get(&self.key).is_some_and(|operation| operation.id == self.id) { table.remove(&self.key); }
        }
        self.finished.cancel();
    }
}

async fn run_accounts(store: &AccountStore, provider: &str, id: &str, declared: &Definition,
    operation: &mut Operation) -> Result<(), String> {
    let manual = operation.manual;
    let mut results = Vec::new();
    for account in store.accounts_for_provider(provider) {
        if !registry::serves(provider) || !super::has_capability(provider, "tasks.v1") { return Err("插件任务已停用".into()); }
        if operation.cancel.is_cancelled() { return Err("任务已停止".into()); }
        if !operation.lease.as_ref().ok_or("任务执行权已释放")?.is_current()? { return Err("任务执行权已失效".into()); }
        let Some(account) = account["id"].as_str() else { continue };
        let adapter = tokio::select! {
            biased;
            _ = operation.cancel.cancelled() => return Err("任务已停止".into()),
            result = registry::acquire(provider) => result.map_err(|error| error.message)?,
        };
        let Some(adapter) = adapter else { break };
        let host = adapter.host();
        if host.options.wasm.as_ref().is_none_or(|options| !options.allows("tasks.v1")) { break; }
        let task = current(provider, declared);
        if !manual && !task.enabled { break; }
        let now = logging::now_ms();
        let (due, delay, planned_at) = interval(&task, now);
        let key = format!("pluginTask:{provider}:{id}:{account}");
        let previous = if task.interval_ms.is_none() {
            task_state::calendar::align(&key, now, planned_at, now.saturating_add(delay), 1000)?
        } else { task_state::read(&key)? };
        if !manual && (!due || planned_at > 0 && previous.failures == 0 && settings::legacy_fired(&task, planned_at)
            || planned_at > 0 && previous.last_attempt_at >= planned_at && previous.failures == 0) { continue; }
        let guard = match task_state::claim(&key, delay, manual, ManualBackoff::Respect, 1000)? {
            Claim::Acquired(guard) => guard, Claim::Deferred(_) => continue,
        };
        if !guard.is_current()? { return Err("账号任务执行权已失效".into()); }
        let result = tokio::select! {
            biased;
            _ = operation.cancel.cancelled() => return Err("任务已停止".into()),
            result = host.call_coded("tasks.run", json!({ "provider": provider, "account": account,
                "task": id, "manual": manual, "scheduled_at": planned_at }), Duration::from_secs(600)) => result,
        };
        let (success, message) = match result {
            Ok(value) if value["success"].is_boolean() => (value["success"] == true,
                value["message"].as_str().unwrap_or("任务已结束").chars().take(1000).collect::<String>()),
            Ok(_) => (false, "插件未返回有效的任务结果".into()),
            Err(error) => (false, super::super::process::redact(&error.message)),
        };
        // A save which completed while the guest was running wins. Keep CONFIG
        // readable until the absolute next slot is committed to the actual DB.
        config::with_raw(|raw| {
            let latest = settings::from_raw(raw, provider, declared);
            let ended = logging::now_ms();
            let (_, delay, _) = interval(&latest, ended);
            let next = latest.interval_ms.is_none().then_some(ended.saturating_add(delay));
            guard.finish_scheduled(success, message.clone(), None, 0, delay, next)
        }).ok_or("任务设置暂不可读，原排程已保留")??;
        results.push(json!({ "account": account, "success": success, "message": message }));
        operation.results = results.clone();
        operation.progress("running")?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if declared.legacy_config.is_some() && !operation.results.is_empty() {
        let (_, _, planned_at) = interval(&current(provider, declared), logging::now_ms());
        settings::remember_legacy(declared, if manual { 0 } else { planned_at }, &json!({ "results": operation.results }))?;
    }
    Ok(())
}

pub(crate) async fn run(store: &AccountStore, provider: &str, id: &str, manual: bool) -> Result<Value, String> {
    let task = definition(provider, id)?;
    if !manual && !task.enabled { return Ok(json!({ "skipped": true })); }
    let Some(mut operation) = Operation::claim(provider, id, manual)? else {
        return Ok(json!({ "skipped": true, "operation": operation_snapshot(&task_state::read(&operation_key(provider, id))?) }));
    };
    let result = run_accounts(store, provider, id, &task, &mut operation).await;
    let snapshot = operation.finish(&result)?;
    result?;
    Ok(json!({ "results": operation.results, "operation": snapshot }))
}

/// Claims and records an operation before returning to the UI. The actual
/// invocation runs in the server, independently of the request's lifetime.
pub(crate) fn launch(store: AccountStore, provider: &str, id: &str) -> Result<Value, String> {
    let task = definition(provider, id)?;
    let Some(mut operation) = Operation::claim(provider, id, true)? else {
        return Ok(json!({ "started": false, "operation": operation_snapshot(&task_state::read(&operation_key(provider, id))?) }));
    };
    let snapshot = operation_snapshot(&task_state::read(&operation.key)?);
    let provider = provider.to_string();
    let id = id.to_string();
    crate::spawn_task(async move {
        let result = run_accounts(&store, &provider, &id, &task, &mut operation).await;
        if let Err(error) = operation.finish(&result) { logging::verbose("[PluginTask]", &error); }
    });
    Ok(json!({ "started": true, "operation": snapshot }))
}

struct RunningProvider {
    provider: String,
    running: Arc<Mutex<std::collections::HashSet<String>>>,
}
impl Drop for RunningProvider {
    fn drop(&mut self) { if let Ok(mut running) = self.running.lock() { running.remove(&self.provider); } }
}

enum Scheduler {
    Idle,
    Stopped,
    Running { cancel: CancellationToken, join: tokio::task::JoinHandle<()> },
    Stopping(CancellationToken),
}

fn scheduler() -> &'static Mutex<Scheduler> {
    static RUNNER: OnceLock<Mutex<Scheduler>> = OnceLock::new();
    RUNNER.get_or_init(|| Mutex::new(Scheduler::Idle))
}

pub(crate) fn spawn(store: AccountStore) {
    let mut state = scheduler().lock().unwrap_or_else(|error| error.into_inner());
    if !matches!(*state, Scheduler::Idle | Scheduler::Stopped) { return; }
    #[cfg(test)]
    SCHEDULER_STARTS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let cancel = CancellationToken::new();
    let stopping = cancel.clone();
    let join = crate::spawn_task(async move {
        let mut workers = tokio::task::JoinSet::new();
        let running = Arc::new(Mutex::new(std::collections::HashSet::new()));
        loop {
            if stopping.is_cancelled() { break; }
            while workers.try_join_next().is_some() {}
            let table = definitions().lock().map(|table| table.clone()).unwrap_or_default();
            for (provider, tasks) in table {
                if !registry::serves(&provider) || !super::has_capability(&provider, "tasks.v1") { continue; }
                if !running.lock().is_ok_and(|mut running| running.insert(provider.clone())) { continue; }
                let store = store.clone();
                let running = running.clone();
                workers.spawn(async move {
                    let _active = RunningProvider { provider: provider.clone(), running };
                    for task in tasks.into_iter().filter(|task| !task.checkin) {
                        if let Err(error) = run(&store, &provider, &task.id, false).await {
                            logging::verbose("[PluginTask]", &error);
                        }
                    }
                });
            }
            tokio::select! {
                biased;
                _ = stopping.cancelled() => break,
                _ = super::super::schedules::changed() => {},
                _ = tokio::time::sleep(Duration::from_secs(30)) => {},
            }
        }
        // Account and manual operations are canceled by stop() before join.
        // All child futures must actually return before this owner exits.
        while workers.join_next().await.is_some() {}
    });
    *state = Scheduler::Running { cancel, join };
}

async fn cancel_operations(prefix: Option<&str>) {
    let finished: Vec<_> = operations().lock().map(|table| table.iter()
        .filter(|(key, _)| prefix.is_none_or(|prefix| key.starts_with(prefix)))
        .map(|(_, operation)| { operation.cancel.cancel(); operation.finished.clone() }).collect())
        .unwrap_or_default();
    for finished in finished { finished.cancelled().await; }
}

pub(crate) async fn stop_provider(provider: &str) {
    cancel_operations(Some(&format!("pluginTaskOperation:{provider}:"))).await;
}

pub(crate) async fn stop() {
    let done = CancellationToken::new();
    let previous = {
        let mut state = scheduler().lock().unwrap_or_else(|error| error.into_inner());
        match &*state {
            Scheduler::Stopping(existing) => Err(existing.clone()),
            _ => Ok(std::mem::replace(&mut *state, Scheduler::Stopping(done.clone()))),
        }
    };
    let previous = match previous { Ok(previous) => previous, Err(done) => { done.cancelled().await; return; } };
    if let Scheduler::Running { cancel, .. } = &previous { cancel.cancel(); }
    let finished = done.clone();
    crate::spawn_task(async move {
        cancel_operations(None).await;
        if let Scheduler::Running { join, .. } = previous {
            if let Err(error) = join.await { logging::verbose("[PluginTask]", &format!("任务调度器已退出：{error}")); }
        }
        *scheduler().lock().unwrap_or_else(|error| error.into_inner()) = Scheduler::Stopped;
        finished.cancel();
    });
    done.cancelled().await;
}

#[cfg(test)]
static SCHEDULER_STARTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scheduler_repeated_spawn_owns_one_background_loop() {
        let before = SCHEDULER_STARTS.load(std::sync::atomic::Ordering::Acquire);
        let store = AccountStore::with_db(None);
        spawn(store.clone());
        spawn(store);
        tokio::task::yield_now().await;
        assert_eq!(SCHEDULER_STARTS.load(std::sync::atomic::Ordering::Acquire), before + 1,
            "duplicate bootstrap must share one scheduler instead of polling tasks twice");
        stop().await;
        assert!(matches!(*scheduler().lock().unwrap(), Scheduler::Stopped), "stop joins the original loop");
        spawn(AccountStore::with_db(None));
        assert_eq!(SCHEDULER_STARTS.load(std::sync::atomic::Ordering::Acquire), before + 2);
        stop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires official WorkBuddy ZIP and an explicit isolated temporary home"]
    async fn official_workbuddy_task_settings_share_legacy_calendar() {
        let (_, store) = super::super::test_support::isolated_store();
        let catpaw = std::path::PathBuf::from(std::env::var_os("AGENT2API_TEST_CATPAW_ZIP").unwrap());
        let bytes = std::fs::read(catpaw.parent().unwrap().join("agent2api-wasm-workbuddy-0.1.0-beta.3-wasm32-unknown-unknown.zip")).unwrap();
        let pack = super::super::super::install::install_zip(&bytes).unwrap();
        assert!(pack.signed);
        super::super::super::bootstrap::start(store.clone()).await.expect("official WorkBuddy loaded");
        let old = crate::server::core::growth_scheduler::state();
        assert_eq!(old["available"], true, "retained travel API recognizes the actual tasks.v1 guest");
        crate::server::core::growth_scheduler::configure(&json!({"times":["18:00","8:00"],"enabled":true})).unwrap();
        let task = definition("workbuddy", "travel").unwrap();
        assert_eq!(task.times, ["08:00", "18:00"]);
        configure("workbuddy", "travel", &json!({"times":["08:00"],"enabled":false})).unwrap();
        let old = crate::server::core::growth_scheduler::state();
        assert_eq!(old["enabled"], false);
        assert_eq!(old["times"], json!(["08:00"]));
        let mut operation = Operation::claim("workbuddy", "travel", true).unwrap().unwrap();
        let key = operation.key.clone();
        let finished = operation.finished.clone();
        let worker = tokio::spawn(async move {
            operation.cancel.cancelled().await;
            operation.finish(&Err("canceled fixture operation".into())).unwrap();
        });
        stop_provider("workbuddy").await;
        assert!(finished.is_cancelled(), "stop waits for the actual operation owner to drop");
        worker.await.unwrap();
        assert!(!task_state::read(&key).unwrap().running());
        spawn(store.clone()); spawn(store);
        stop().await;
        super::super::super::shutdown_all().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    #[ignore = "requires official WorkBuddy ZIP and an explicit isolated temporary home"]
    async fn official_workbuddy_task_run_preserves_saved_calendar_and_backoff() {
        use super::super::test_support::{LocalHttp, Reply};
        let (_, store) = super::super::test_support::isolated_store();
        let http = LocalHttp::open(|_| {
            let mut reply = Reply::json(503, json!({"code":503,"message":"fixture temporary failure"}));
            reply.delay = Duration::from_millis(750); reply
        }).await;
        let path = std::path::PathBuf::from(std::env::var_os("AGENT2API_TEST_CATPAW_ZIP").unwrap());
        let bytes = std::fs::read(path.parent().unwrap().join("agent2api-wasm-workbuddy-0.1.0-beta.3-wasm32-unknown-unknown.zip")).unwrap();
        assert!(super::super::super::install::install_zip(&bytes).unwrap().signed);
        super::super::super::bootstrap::start(store.clone()).await.unwrap();
        let account = store.plugin_upsert_account("fixture-workbuddy-task", "workbuddy", "WorkBuddy task fixture",
            &json!({"uid":"fixture-workbuddy-task","accessToken":"fixture-workbuddy-token",
                "refreshToken":"fixture-workbuddy-refresh","expiresAt":logging::now_ms() + 86_400_000,
                "domain":"copilot.tencent.com","realm":"cn"}), &json!({}), false).unwrap();
        configure("workbuddy", "travel", &json!({"times":["18:00"],"enabled":true})).unwrap();
        let worker_store = store.clone();
        let worker = tokio::spawn(async move { crate::server::core::growth_scheduler::run_now(&worker_store).await });
        tokio::time::timeout(Duration::from_secs(20), async {
            while http.requests.lock().unwrap().is_empty() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.expect("actual official tasks.run issues a controlled HTTP request");
        configure("workbuddy", "travel", &json!({"times":["08:00"]})).unwrap();
        match worker.await.unwrap() {
            crate::server::core::growth_scheduler::RunOutcome::Completed(value) => {
                assert_eq!(value["results"][0]["success"], false, "real guest reports the actual endpoint failure");
            }
            _ => panic!("legacy run API did not return the genuine task operation receipt"),
        }
        let key = format!("pluginTask:workbuddy:travel:{}", account["id"].as_str().unwrap());
        let state = task_state::read(&key).unwrap();
        assert_eq!(state.failures, 1);
        assert!(state.retry_at > state.last_run_at);
        assert!(!state.running());
        let latest = definition("workbuddy", "travel").unwrap();
        let (_, delay, _) = interval(&latest, state.last_run_at);
        assert_eq!(state.next_run_at, (state.last_run_at + delay).max(state.retry_at),
            "the saved 08:00 definition and real failure backoff both survive completion");
        let sent = http.requests.lock().unwrap().len();
        super::super::super::shutdown_all().await;
        super::super::super::bootstrap::start(store.clone()).await.unwrap();
        assert_eq!(definition("workbuddy", "travel").unwrap().times, ["08:00"]);
        let restored = task_state::read(&key).unwrap();
        assert_eq!(restored.last_attempt_at, state.last_attempt_at);
        assert_eq!(restored.retry_at, state.retry_at);
        spawn(store.clone());
        assert!(matches!(crate::server::core::growth_scheduler::run_now(&store).await,
            crate::server::core::growth_scheduler::RunOutcome::Busy), "restart cannot bypass the original operation backoff");
        assert_eq!(http.requests.lock().unwrap().len(), sent);
        // A different genuine declared task has no failed operation backoff.
        // Do not clear travel's cooldown merely to force a background request.
        configure("workbuddy", "growth-daily", &json!({"times":["00:00"],"enabled":true})).unwrap();
        spawn(store.clone());
        tokio::time::timeout(Duration::from_secs(20), async {
            while http.requests.lock().unwrap().len() == sent { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.expect("the actual background scheduler invokes the official tasks.run without a manual API request");
        stop().await;
        assert_eq!(http.requests.lock().unwrap().len(), sent + 1, "one scheduler owns the automatic request; stop cancels before another request");
        let automatic_key = format!("pluginTask:workbuddy:growth-daily:{}", account["id"].as_str().unwrap());
        assert!(task_state::read(&automatic_key).unwrap().last_attempt_at > 0);
        assert!(!task_state::read(&automatic_key).unwrap().running(), "scheduler stop waits for the actual account lease to return");
        super::super::super::shutdown_all().await;
    }
}
