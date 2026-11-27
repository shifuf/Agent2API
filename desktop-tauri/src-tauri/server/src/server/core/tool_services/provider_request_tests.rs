use std::sync::{Arc, Mutex};

use axum::{http::{HeaderMap, StatusCode}, routing::post, Json, Router};
use serde_json::{json, Value};

use super::{provider_keys, provider_request::ProviderRequest, search::SearchErrorCode};

#[tokio::test]
async fn search_key_rotation_local_fixture() {
    const FIRST: &str = "fixture-search-first-credential";
    const SECOND: &str = "fixture-search-backup-credential";
    let Some(home) = std::env::var_os("AGENT2API_SEARCH_FIXTURE_CHILD") else {
        let home = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["search_key_rotation_local_fixture", "--test-threads=1", "--nocapture"])
            .env("AGENT2API_SEARCH_FIXTURE_CHILD", home.path())
            .env("AGENT2API_PROXY_HOME", home.path()).env("AGENT2API_ACCOUNT_KEY", "4".repeat(64))
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    };
    let db = crate::server::db::Db::open(&std::path::PathBuf::from(home).join("agent2api.db")).unwrap();
    crate::server::config::init(Some(db));
    let keys = [FIRST, SECOND].map(|secret| provider_keys::ProviderKeyUpdate { id: None, api_key: Some(secret.into()) });
    let updates = provider_keys::prepare_updates(&keys).unwrap();
    super::try_update(move |config| {
        let entry = config.providers.entry("tavily".into()).or_default();
        entry.enabled = true;
        provider_keys::apply_updates(entry, updates)
    }).unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let received = calls.clone();
    let upstream = Router::new().route("/", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let received = received.clone();
        async move {
            let key = headers["authorization"].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            let first = key == FIRST;
            assert!(first || key == SECOND);
            received.lock().unwrap().push(if first { 1 } else { 2 });
            let status = match body["case"].as_str().unwrap() {
                "invalid" => StatusCode::BAD_REQUEST,
                "rate" if first => StatusCode::TOO_MANY_REQUESTS,
                "quota" => StatusCode::from_u16(432).unwrap(),
                _ => StatusCode::OK,
            };
            let response = if status.is_success() { json!({"ok": true}) }
                else { json!({"message": format!("bad request: {FIRST} {SECOND}")}) };
            (status, [("retry-after", "3600")], Json(response))
        }
    }));
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let request = |operation| ProviderRequest::new("tavily", operation, 5);
    let snapshot = || provider_keys::provider_row("tavily", &super::load().providers["tavily"]);
    let invalid = request("search").post_json(&url, json!({"case":"invalid"})).await.unwrap_err();
    assert_eq!(invalid.code, SearchErrorCode::InvalidInput);
    assert!(!invalid.message.contains(FIRST) && !invalid.message.contains(SECOND));
    assert_eq!(std::mem::take(&mut *calls.lock().unwrap()), [1]);
    request("search").post_json(&url, json!({"case":"rate"})).await.unwrap();
    assert_eq!(std::mem::take(&mut *calls.lock().unwrap()), [1, 2]);
    assert_eq!(snapshot()["keys"][0]["search"]["status"], "rate_limited");
    assert_eq!(snapshot()["keys"][0]["fetch"]["status"], "ready");
    request("fetch").post_json(&url, json!({"case":"ok"})).await.unwrap();
    assert_eq!(std::mem::take(&mut *calls.lock().unwrap()), [1]);
    let all = request("fetch").post_json(&url, json!({"case":"quota"})).await.unwrap_err();
    assert_eq!(all.code, SearchErrorCode::QuotaExhausted);
    assert_eq!(std::mem::take(&mut *calls.lock().unwrap()), [1, 2]);
    crate::server::config::reload();
    let view = snapshot();
    assert_eq!(view["available_key_count"], 0);
    assert!(!view.to_string().contains(FIRST) && !view.to_string().contains(SECOND));
    assert!(request("search").post_json(&url, json!({"case":"ok"})).await.is_err());
    assert!(calls.lock().unwrap().is_empty());
    server.abort();
}
