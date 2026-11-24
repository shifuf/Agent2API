use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

use serde_json::json;

use super::super::test_support::{OfficialCatPaw, Reply, catalog_reply, complete_reply};
use crate::server::core::upstream::{usage::RequestTelemetry, ForwardOutcome};
use crate::server::core::providers::adapter::ProviderAdapter;

const CATALOG: &str = "/api/agent/maas/model-types";
const ROUND: &str = "/api/agent/conversation/round";
const EVENT: &str = "/api/agent/conversation/event";
const TURN: &str = "/api/agent/conversation/turn";
const STOP: &str = "/api/agent/conversation/turn/stop";

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_fixed_turn_flow() {
    let fixture = OfficialCatPaw::open(|request| match request.path.as_str() {
        CATALOG => catalog_reply(),
        ROUND | EVENT | STOP => Reply::json(200, json!({ "code": 0 })),
        TURN => complete_reply(request, "fixture complete answer"),
        _ => Reply::json(404, json!({ "code": 404 })),
    }).await;
    let refreshed = fixture.adapter.as_ref().expect("real adapter").refresh_models(&fixture.store, &fixture.account, true).await;
    assert!(refreshed.refreshed, "official catalog refresh failed: {:?}; actual requests: {:?}", refreshed.message, fixture.requests());
    let body = OfficialCatPaw::body("produce a complete answer");
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let outcome = fixture.forward(&body, false, &telemetry).await
        .unwrap_or_else(|error| panic!("real official CatPaw turn failed: {error:?}; actual requests: {:?}", fixture.requests()));
    let ForwardOutcome::Completion { body } = outcome else { panic!("expected genuine gateway aggregation") };
    assert_eq!(body["choices"][0]["message"]["content"], "fixture complete answer");
    crate::server::core::upstream::internal_output::verify_completion(&body, &telemetry)
        .expect("actual internal completion observer accepts the original complete output");
    assert_eq!(fixture.count(ROUND), 1);
    assert_eq!(fixture.count(TURN), 1);
    let requests = fixture.requests();
    let round = requests.iter().find(|request| request.path == ROUND).expect("real round request");
    assert_eq!(round.method, axum::http::Method::POST);
    assert_eq!(round.headers["cookie"], "X-Passport-Token=fixture-catpaw-passport-token");
    assert_eq!(round.headers["user-uid"], "fixture-catpaw-user");
    assert!(requests.iter().any(|request| request.path == EVENT && request.body["data"]["status"] == "running"));
    assert!(requests.iter().any(|request| request.path == EVENT && request.body["data"]["status"] == "completed"));
    assert_eq!(fixture.count(STOP), 0, "completed original turn needs no guessed stop");
    assert!(fixture.close().await, "original completed worker ownership is genuinely released");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_round_failures_remain_single_submission() {
    let mode = Arc::new(AtomicUsize::new(0));
    let handler_mode = mode.clone();
    let created_rounds = Arc::new(AtomicUsize::new(0));
    let handler_created_rounds = created_rounds.clone();
    let fixture = OfficialCatPaw::open(move |request| match request.path.as_str() {
        CATALOG => catalog_reply(),
        ROUND => match handler_mode.load(Ordering::Acquire) {
            0 => {
                // The real local endpoint commits its round before returning 500.
                handler_created_rounds.fetch_add(1, Ordering::AcqRel);
                Reply::json(500, json!({ "code": 500, "message": "round server failure after creation" }))
            },
            1 => Reply::json(200, json!({ "code": 7001, "message": "business rejection" })),
            2 => Reply::json(200, json!({ "code": 0, "payload": { "accepted": true } })),
            _ => Reply::text(200, "{malformed round response"),
        },
        EVENT | STOP => Reply::json(200, json!({ "code": 0 })),
        TURN => complete_reply(request, "must never be reached"),
        _ => Reply::json(404, json!({ "code": 404 })),
    }).await;
    let body = OfficialCatPaw::body("one original request must not create another round");
    for scenario in 0..4 {
        mode.store(scenario, Ordering::Release);
        let account = fixture.save_account(&format!("fixture-catpaw-failure-{scenario}"));
        let telemetry = Arc::new(RequestTelemetry::with_id());
        let before = fixture.count(ROUND);
        let result = fixture.forward_for(&account, &body, false, &telemetry).await;
        let error = match result { Err(error) => error, Ok(_) => panic!("invalid round response became success") };
        if scenario == 0 {
            assert_eq!(error.status_code, 500, "retain the actual round HTTP500 for original routing classification: {error:?}");
        }
        assert_eq!(fixture.count(ROUND), before + 1, "the real round must be sent exactly once");
        let result = fixture.forward_for(&account, &body, false, &telemetry).await;
        let blocked = match result { Err(error) => error, Ok(_) => panic!("the original request was replayed") };
        assert!(blocked.retry_forbidden, "original ReplayGuard must forbid outer retry: {blocked:?}");
        assert_eq!(fixture.count(ROUND), before + 1, "failure response must not reopen round creation");
    }
    assert_eq!(fixture.count(TURN), 0);
    assert_eq!(created_rounds.load(Ordering::Acquire), 1, "real endpoint committed one round before its HTTP500");
    assert_eq!(fixture.count(STOP), 0, "an unconfirmed round is not permission to guess cleanup");
    assert_eq!(fixture.count(EVENT), 0, "unconfirmed round IDs must not invent terminal events");
    let host = fixture.host.clone();
    assert!(!fixture.close().await, "unknown remote submission retains actual runtime ownership");
    assert!(Arc::ptr_eq(&host, &super::super::super::host_for_pack("agent2api-wasm-catpaw").expect("retained original host")));
}
