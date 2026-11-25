//! Test gateway linked to the unchanged production server library.
//! Used by test-sticky-prepare.mjs to exercise real RPC preparation and HTTP routing.
use std::{net::{IpAddr, Ipv4Addr}, sync::Arc, time::Duration};
use agent2api_server::server::{start, ServerState};
use agent2api_server::server::core::{plugin_host::{Host, HostOptions, RpcAdapter, StoreCallbacks, install_provider}, providers::{ProviderKind, adapter::ProviderAdapter}};
use agent2api_provider_protocol::{ErrorClass, ProviderInfo};
use serde_json::json;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let provider = arguments.get(5).map(String::as_str).unwrap_or("timing-fixture");
    let runtime_cases = ["runtime-524", "runtime-503", "runtime-cleanup"];
    let preparation_cases = ["quota-switch", "quota-headers", "quota-timeout"];
    let phases = if provider == "qwenwork" { runtime_cases } else { preparation_cases };
    let port = std::env::var("AGENT2API_PROXY_PORT").unwrap().parse().unwrap();
    let state = ServerState::bootstrap(port, IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
    let shutdown = start(&state).unwrap();
    // Let the ordinary empty installed-pack bootstrap complete first.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let default_models: Vec<_> = phases.into_iter().flat_map(|phase|
        ["a", "b", "c"].map(move |channel| json!({ "id": format!("{phase}-{channel}"), "context": 32768 }))).collect();
    let info: ProviderInfo = serde_json::from_value(json!({
        "id": provider, "label": "Timing fixture", "capabilities": { "chat": true, "refresh": true, "model_refresh": true, "stateful": provider == "qwenwork" },
        "default_models": default_models,
        "login_methods": [], "refusal_finishes": [], "refusal_markers": [],
    })).unwrap();
    let accounts: std::collections::BTreeMap<_, _> = ["a", "b", "c"].into_iter().map(|channel| {
        let saved = state.store().plugin_upsert_account(&format!("timing-{channel}"), provider, channel,
            &json!({ "token": channel }), &json!({ "name": channel }), false).unwrap();
        (channel, saved["id"].clone())
    }).collect();
    std::fs::write(&arguments[2], serde_json::to_vec(&json!({
        "providers": [info], "accounts": accounts, "upstream": arguments[3], "control": arguments[4],
        "quota": ErrorClass::QuotaLimited { status: 429, message: "fixture quota exhausted".into(), upstream_code: None, reset_at: None },
        "fatal": ErrorClass::Fatal { status: 503, message: "fixture temporarily unavailable".into(), upstream_code: None },
    })).unwrap()).unwrap();
    let mut options = HostOptions::new(&arguments[0]);
    options.args = vec![arguments[1].clone(), arguments[2].clone()];
    let host = Arc::new(Host::new(options, Arc::new(StoreCallbacks::new(state.store().clone()))));
    for info in host.ensure().await.unwrap() {
        let kind = agent2api_server::server::core::providers::kind_from_id(provider).unwrap_or(ProviderKind::WorkBuddy);
        let adapter = Arc::new(RpcAdapter::new(info.id.0.clone(), kind, host.clone(), info));
        install_provider(provider.into(), adapter.clone());
        let refreshed = adapter.refresh_models(state.store(), accounts["a"].as_str().unwrap(), true).await;
        assert!(refreshed.refreshed, "fixture directory must load: {:?}", refreshed.message);
    }
    println!("TIMING_FIXTURE_READY");
    tokio::signal::ctrl_c().await.unwrap();
    let _ = shutdown.send(());
    host.shutdown().await;
}
