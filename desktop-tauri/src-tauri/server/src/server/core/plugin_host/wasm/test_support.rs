//! Acceptance helpers using an installed official guest, real callbacks and SQLite.
//! Fixture tests run in a separate process with an explicit temporary proxy home.
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::{body::Bytes, extract::State, http::{HeaderMap, Method, StatusCode, Uri}, response::Response, Router};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::server::{config, db::{Db, test_temp::TempDb}, errors::GatewayError};
use crate::server::core::{account_store::{AccountStore, plugin_accounts}, api_keys,
    providers::adapter::ProviderAdapter, upstream::{usage::RequestTelemetry, ForwardOutcome}};
use super::super::{bootstrap, install, registry, Host, RpcAdapter};

const CATPAW_ORIGIN: &str = "https://ai.catpaw.meituan.com";
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TRANSPORT: Mutex<Option<String>> = Mutex::new(None);

/// Transport substitution is compiled only for tests. Origin authorization,
/// original Key/row stamps and selected proxy clients still use the real URL.
pub(crate) fn transport_url(original: &str) -> String {
    let Ok(parsed) = url::Url::parse(original) else { return original.to_string() };
    if !matches!(parsed.origin().ascii_serialization().as_str(), CATPAW_ORIGIN
        | "https://copilot.tencent.com" | "https://www.codebuddy.cn"
        | "https://www.workbuddy.ai" | "https://xiaohuanxiong.com"
        | "https://chatglm.cn") { return original.to_string(); }
    let Ok(mapping) = TRANSPORT.lock() else { return original.to_string() };
    let Some(origin) = mapping.as_ref() else { return original.to_string() };
    let mut mapped = format!("{origin}{}", parsed.path());
    if let Some(query) = parsed.query() { mapped.push('?'); mapped.push_str(query); }
    mapped
}

pub(crate) fn reported_url(actual: &url::Url, original: &url::Url) -> String {
    if actual.as_str() == transport_url(original.as_str()) { original.to_string() }
    else { actual.to_string() }
}

struct Database {
    db: Db,
    store: AccountStore,
    _guard: TempDb,
}

fn database() -> &'static Database {
    static DATABASE: OnceLock<Database> = OnceLock::new();
    DATABASE.get_or_init(|| {
        let expected = std::env::var_os("AGENT2API_TEST_HOME").map(PathBuf::from)
            .expect("fixture requires AGENT2API_TEST_HOME and AGENT2API_PROXY_HOME");
        let actual = crate::paths::config_dir();
        assert!(expected.is_absolute() && expected == actual && expected.starts_with(std::env::temp_dir()),
            "fixture proxy home must be the explicitly supplied temporary directory");
        std::fs::create_dir_all(&expected).expect("create fixture proxy home");
        let (db, guard) = TempDb::open("official-wasm-acceptance");
        config::init(Some(db.clone()));
        crate::server::core::task_state::install(Some(db.clone()));
        let store = AccountStore::with_db(Some(db.clone()));
        assert!(plugin_accounts::shared().is_none(), "fixture must initialize the actual shared store first");
        plugin_accounts::install_shared(store.clone());
        Database { db, store, _guard: guard }
    })
}

pub(crate) fn isolated_store() -> (Db, AccountStore) {
    let database = database();
    (database.db.clone(), database.store.clone())
}

#[derive(Clone, Debug)]
pub(crate) struct RecordedRequest {
    pub method: Method,
    pub path: String,
    pub headers: HeaderMap,
    pub bytes: Bytes,
    pub body: Value,
}

pub(crate) struct Reply {
    pub status: StatusCode,
    pub content_type: &'static str,
    pub body: String,
    pub delay: Duration,
}

impl Reply {
    pub(crate) fn json(status: u16, body: Value) -> Self {
        Self { status: StatusCode::from_u16(status).expect("fixture status"),
            content_type: "application/json", body: body.to_string(), delay: Duration::ZERO }
    }
    pub(crate) fn text(status: u16, body: impl Into<String>) -> Self {
        Self { status: StatusCode::from_u16(status).expect("fixture status"),
            content_type: "application/json", body: body.into(), delay: Duration::ZERO }
    }
    pub(crate) fn sse(body: impl Into<String>) -> Self {
        Self { status: StatusCode::OK, content_type: "text/event-stream", body: body.into(), delay: Duration::ZERO }
    }
}

type Handler = dyn Fn(&RecordedRequest) -> Reply + Send + Sync;
#[derive(Clone)]
struct LocalState {
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handler: Arc<Handler>,
}

async fn respond(State(state): State<LocalState>, method: Method, uri: Uri,
    headers: HeaderMap, bytes: Bytes) -> Response {
    let request = RecordedRequest { method, path: uri.path().to_string(), headers,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), bytes };
    let reply = (state.handler)(&request);
    state.requests.lock().expect("fixture request ledger").push(request);
    if !reply.delay.is_zero() { tokio::time::sleep(reply.delay).await; }
    Response::builder().status(reply.status).header("content-type", reply.content_type)
        .body(axum::body::Body::from(reply.body)).expect("fixture response")
}

pub(crate) struct LocalHttp {
    pub requests: Arc<Mutex<Vec<RecordedRequest>>>,
    cancel: CancellationToken,
    server: tokio::task::JoinHandle<()>,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl LocalHttp {
    pub(crate) async fn open(handler: impl Fn(&RecordedRequest) -> Reply + Send + Sync + 'static) -> Self {
        let serial = SERIAL.lock().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = LocalState { requests: requests.clone(), handler: Arc::new(handler) };
        assert!(TRANSPORT.lock().unwrap().replace(format!("http://{}", listener.local_addr().unwrap())).is_none());
        let cancel = CancellationToken::new();
        let closing = cancel.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(respond).with_state(state))
                .with_graceful_shutdown(closing.cancelled_owned()).await.unwrap();
        });
        Self { requests, cancel, server, _serial: serial }
    }
}

impl Drop for LocalHttp {
    fn drop(&mut self) {
        self.cancel.cancel(); self.server.abort();
        TRANSPORT.lock().unwrap_or_else(|error| error.into_inner()).take();
    }
}

/// Owns the real installed CatPaw host and the local HTTP server. Holding this
/// serial guard prevents worker transport mappings and global stores racing.
pub(crate) struct OfficialCatPaw {
    pub db: Db,
    pub store: AccountStore,
    pub host: Arc<Host>,
    pub adapter: Option<RpcAdapter>,
    pub account: String,
    pub headers: HeaderMap,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    cancel: CancellationToken,
    server: Option<tokio::task::JoinHandle<()>>,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl OfficialCatPaw {
    pub(crate) async fn open(handler: impl Fn(&RecordedRequest) -> Reply + Send + Sync + 'static) -> Self {
        let serial = SERIAL.lock().await;
        let database = database();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = LocalState { requests: requests.clone(), handler: Arc::new(handler) };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("fixture HTTP listener");
        let origin = format!("http://{}", listener.local_addr().expect("fixture HTTP address"));
        assert!(TRANSPORT.lock().expect("fixture mapping").replace(origin).is_none());
        let cancel = CancellationToken::new();
        let closing = cancel.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(respond).with_state(state))
                .with_graceful_shutdown(closing.cancelled_owned()).await.expect("fixture HTTP server");
        });
        let fixture = std::env::var_os("AGENT2API_TEST_CATPAW_ZIP").map(PathBuf::from)
            .expect("supply the downloaded official CatPaw ZIP with AGENT2API_TEST_CATPAW_ZIP");
        let bytes = std::fs::read(fixture).expect("read official CatPaw ZIP");
        let installed = install::install_zip(&bytes).expect("install and verify official CatPaw ZIP");
        assert_eq!(installed.id, "agent2api-wasm-catpaw");
        assert!(installed.signed, "fixture must pass the production official-signature verifier");
        install::set_pack_enabled(&installed.id, true).expect("enable actual CatPaw pack");
        install::set_provider_enabled(&installed.id, "catpaw", true).expect("enable actual CatPaw provider");
        let host = bootstrap::start(database.store.clone()).await.expect("start actual installed CatPaw host");
        assert!(host.ready());
        assert_eq!(super::super::provider_pack("catpaw").as_deref(), Some(installed.id.as_str()));
        let adapter = registry::acquire("catpaw").await.expect("acquire actual CatPaw adapter")
            .expect("official CatPaw adapter registered");
        let account = database.store.plugin_upsert_account("fixture-catpaw-user", "catpaw", "CatPaw acceptance",
            &json!({ "provider": "catpaw", "uid": "fixture-catpaw-user", "userId": "fixture-catpaw-user",
                "accessToken": "fixture-catpaw-passport-token", "loginType": "passport" }),
            &json!({ "userAgent": "Agent2API-CatPaw-Acceptance/1.0" }), false).expect("save real CatPaw account");
        let account = account["id"].as_str().expect("saved account ID").to_string();
        let entry = api_keys::list().into_iter().find(|entry| entry.name == "official-catpaw-acceptance")
            .unwrap_or_else(|| api_keys::add("official-catpaw-acceptance", None,
                vec!["catpaw".into()], Vec::new()).expect("save real encrypted model Key"));
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {}", entry.key).parse().expect("fixture model Key header"));
        headers.insert("x-session-id", "fixture-catpaw-session".parse().expect("fixture session header"));
        config::model_key_source::capture(&headers).expect("original model Key capture");
        Self { db: database.db.clone(), store: database.store.clone(), host,
            adapter: Some(adapter), account, headers, requests, cancel, server: Some(server), _serial: serial }
    }

    pub(crate) fn body(prompt: &str) -> Value {
        json!({ "model": "kimi-k3", "messages": [{ "role": "user", "content": prompt }] })
    }

    pub(crate) async fn forward(&self, body: &Value, stream: bool,
        telemetry: &Arc<RequestTelemetry>) -> Result<ForwardOutcome, GatewayError> {
        self.forward_for(&self.account, body, stream, telemetry).await
    }

    pub(crate) fn save_account(&self, identity: &str) -> String {
        let saved = self.store.plugin_upsert_account(identity, "catpaw", "CatPaw acceptance",
            &json!({ "provider": "catpaw", "uid": identity, "userId": identity,
                "accessToken": "fixture-catpaw-passport-token", "loginType": "passport" }),
            &json!({ "userAgent": "Agent2API-CatPaw-Acceptance/1.0" }), false).expect("save real CatPaw account");
        saved["id"].as_str().expect("saved account ID").to_string()
    }

    pub(crate) async fn forward_for(&self, account: &str, body: &Value, stream: bool,
        telemetry: &Arc<RequestTelemetry>) -> Result<ForwardOutcome, GatewayError> {
        let source = config::model_key_source::capture(&self.headers)?;
        config::model_key_source::scope(source, self.adapter.as_ref().expect("fixture adapter retained")
            .forward_conversation(&self.store, account, body, &self.headers, None, stream, telemetry)).await
    }

    pub(crate) fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("fixture request ledger").clone()
    }

    pub(crate) fn count(&self, path: &str) -> usize {
        self.requests.lock().expect("fixture request ledger").iter().filter(|request| request.path == path).count()
    }

    pub(crate) async fn close(mut self) -> bool {
        self.adapter.take();
        super::super::shutdown_all().await;
        let released = self.host.wasm_shutdown_complete();
        if released { registry::remove("catpaw"); }
        self.cancel.cancel();
        if let Some(server) = self.server.take() {
            tokio::time::timeout(Duration::from_secs(10), server).await.expect("fixture HTTP shutdown")
                .expect("fixture HTTP worker");
        }
        TRANSPORT.lock().expect("fixture mapping").take();
        released
    }
}

impl Drop for OfficialCatPaw {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(server) = self.server.take() { server.abort(); }
        TRANSPORT.lock().unwrap_or_else(|error| error.into_inner()).take();
    }
}

pub(crate) fn catalog_reply() -> Reply {
    Reply::json(200, json!({ "code": 0, "data": [
        { "modelTypeId": 83, "modelTypeName": "Kimi-K3", "provider": "CATPAW", "supportImage": true }
    ] }))
}

pub(crate) fn complete_reply(request: &RecordedRequest, text: &str) -> Reply {
    let conversation = request.body["conversationId"].as_str().expect("actual turn conversation ID");
    let event = json!({ "code": 0, "data": { "conversationId": conversation, "message": {
        "conversationId": conversation, "messageId": "fixture-catpaw-assistant", "type": "assistant",
        "content": [{ "type": "text", "text": text }], "finished": true
    } } });
    Reply::sse(format!("data: {event}\n\ndata: [DONE]\n\n"))
}
