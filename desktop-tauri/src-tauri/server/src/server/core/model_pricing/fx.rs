//! 美元兑人民币（USD → CNY）实时汇率获取与本地缓存（12 小时 TTL，离线回落 7.2）。

use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::server::core::egress;
use crate::server::db::Db;
use crate::server::logging;

const FX_URL: &str = "https://open.er-api.com/v6/latest/USD";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
pub const FX_CACHE_KV_KEY: &str = "fxRateCache";
pub const FX_TTL_MS: i64 = 12 * 3600 * 1000;
pub const FX_FALLBACK: f64 = 7.2;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FxRateSnapshot {
    pub rate: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

impl FxRateSnapshot {
    pub fn is_stale(&self, now_ms: i64) -> bool {
        self.updated_at <= 0 || now_ms.saturating_sub(self.updated_at) >= FX_TTL_MS
    }

    pub fn to_json(&self, now_ms: i64) -> Value {
        serde_json::json!({
            "rate": self.rate,
            "updatedAt": self.updated_at,
            "stale": self.is_stale(now_ms),
            "fallback": self.updated_at <= 0,
        })
    }
}

#[derive(Default)]
struct FxState {
    cached: Option<FxRateSnapshot>,
    generation: u64,
}

impl FxState {
    fn reload(&mut self, conn: &Connection) {
        self.generation = self.generation.wrapping_add(1);
        self.cached = read_db_cache(conn);
    }
}

static DB: OnceLock<Option<Db>> = OnceLock::new();
static STATE: OnceLock<Mutex<FxState>> = OnceLock::new();

pub fn install(db: Option<Db>) {
    if let Some(db) = DB.get_or_init(|| db) {
        db.with(database_replaced);
    }
}

pub(crate) fn database_replaced(conn: &Connection) {
    state().lock().unwrap_or_else(|error| error.into_inner()).reload(conn);
}

fn state() -> &'static Mutex<FxState> {
    STATE.get_or_init(|| Mutex::new(FxState::default()))
}

fn read_db_cache(conn: &Connection) -> Option<FxRateSnapshot> {
    let raw: String = conn.query_row(
            "SELECT value FROM kv WHERE key = ?1",
            params![FX_CACHE_KV_KEY],
            |row| row.get(0),
        )
        .ok()?;
    let parsed: FxRateSnapshot = serde_json::from_str(&raw).ok()?;
    (parsed.rate.is_finite() && parsed.rate > 0.0 && parsed.updated_at > 0).then_some(parsed)
}

pub fn current_rate() -> FxRateSnapshot {
    state().lock().unwrap_or_else(|error| error.into_inner()).cached.clone().unwrap_or(FxRateSnapshot { rate: FX_FALLBACK, updated_at: 0 })
}

/// 主动向汇率接口拉取最新 USD → CNY 汇率。
pub async fn refresh_live() -> Result<FxRateSnapshot, String> {
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _refresh = REFRESH.try_lock().map_err(|_| "汇率刷新正在进行")?;
    let db = DB.get().and_then(Option::as_ref).ok_or("汇率缓存不可用")?;
    refresh_from(db, state(), &egress::client_for_system_proxy(), FX_URL).await
}

async fn refresh_from(db: &Db, state: &Mutex<FxState>, client: &reqwest::Client, url: &str) -> Result<FxRateSnapshot, String> {
    let generation = state.lock().unwrap_or_else(|error| error.into_inner()).generation;
    let snapshot = FxRateSnapshot { rate: fetch_from_network(client, url).await?, updated_at: logging::now_ms() };
    let encoded = serde_json::to_string(&snapshot).map_err(|_| "无法保存汇率")?;
    db.with(|conn| {
        let mut guard = state.lock().unwrap_or_else(|error| error.into_inner());
        if guard.generation != generation { return Err("数据库已更换，已忽略旧汇率刷新".into()); }
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![FX_CACHE_KV_KEY, encoded],
        ).map_err(|_| "无法保存汇率")?;
        guard.cached = Some(snapshot.clone());
        Ok(snapshot)
    }).ok_or("汇率缓存不可用")?
}

async fn fetch_from_network(client: &reqwest::Client, url: &str) -> Result<f64, String> {
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "Agent2API")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|err| format!("获取汇率失败: {}", egress::describe_error_detail(&err)))?;
    if !response.status().is_success() {
        return Err(format!("汇率接口返回 HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) {
        return Err("汇率响应超出大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取汇率响应失败")? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() { return Err("汇率响应超出大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "解析汇率响应失败")?;
    let rate = body
        .pointer("/rates/CNY")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| "汇率响应缺少有效 CNY 汇率".to_string())?;
    let rounded = (rate * 10_000.0).round() / 10_000.0;
    if !rounded.is_finite() || rounded <= 0.0 { return Err("无效的 CNY 汇率".into()); }
    Ok(rounded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get, Router};
    use bytes::Bytes;
    use std::{convert::Infallible, sync::Arc};
    use tokio::sync::Notify;

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn review_fx_limits_declared_and_chunked_bodies_before_parsing() {
        let bounded = |size: usize| {
            let mut body = br#"{"rates":{"CNY":7.12346}}"#.to_vec();
            body.resize(size, b' ');
            body
        };
        let app = Router::new()
            .route("/limit", get(async move || bounded(MAX_RESPONSE_BYTES)))
            .route("/declared", get(async move || bounded(MAX_RESPONSE_BYTES + 1)))
            .route("/chunked", get(async move || {
                Body::from_stream(futures::stream::iter([
                    Ok::<_, Infallible>(Bytes::from(bounded(MAX_RESPONSE_BYTES))),
                    Ok(Bytes::from_static(b" ")),
                ]))
            }));
        let (url, task) = serve(app).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(fetch_from_network(&client, &format!("{url}/limit")).await.unwrap(), 7.1235);
        for endpoint in ["declared", "chunked"] {
            assert_eq!(fetch_from_network(&client, &format!("{url}/{endpoint}")).await.unwrap_err(), "汇率响应超出大小限制");
        }
        task.abort();
    }

    #[tokio::test]
    async fn review_fx_inflight_refresh_cannot_overwrite_replaced_db_or_cache() {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("target.db")).unwrap();
        let state = Mutex::new(FxState::default());
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let request_started = started.clone();
        let resume = release.clone();
        let (url, server) = serve(Router::new().route("/", get(move || {
            let request_started = request_started.clone();
            let resume = resume.clone();
            async move {
                request_started.notify_one();
                resume.notified().await;
                r#"{"rates":{"CNY":6.99}}"#
            }
        }))).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let refresh = refresh_from(&db, &state, &client, &url);
        let restore = async {
            tokio::time::timeout(std::time::Duration::from_secs(5), started.notified()).await.unwrap();
            db.with(|conn| {
                conn.execute("INSERT OR REPLACE INTO kv (key,value) VALUES (?1,?2)", [FX_CACHE_KV_KEY, r#"{"rate":8.03,"updatedAt":15}"#]).unwrap();
                state.lock().unwrap().reload(conn);
            }).unwrap();
            release.notify_one();
        };
        let (result, ()) = tokio::join!(refresh, restore);
        assert_eq!(result.unwrap_err(), "数据库已更换，已忽略旧汇率刷新");
        assert_eq!(state.lock().unwrap().cached.as_ref().unwrap().rate, 8.03);
        assert_eq!(db.with(read_db_cache).flatten().unwrap().rate, 8.03);
        release.notify_one();
        assert_eq!(refresh_from(&db, &state, &client, &url).await.unwrap().rate, 6.99);
        assert_eq!(db.with(read_db_cache).flatten().unwrap().rate, 6.99);
        server.abort();
    }
}
