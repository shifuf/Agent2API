//! These acceptance cases execute the published, signed CatPaw guest through
//! the normal routing service. Each case needs its own isolated test process.
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

use serde_json::{json, Value};

use crate::server::{config, core::{api_keys, auth::AuthService, key_scope::KeyScope,
    plugin_host::wasm::test_support::{OfficialCatPaw, Reply, catalog_reply, complete_reply},
    upstream::{ForwardOutcome, ForwardRequest, UpstreamService, usage::RequestTelemetry}}};

const CATALOG: &str = "/api/agent/maas/model-types";
const ROUND: &str = "/api/agent/conversation/round";
const EVENT: &str = "/api/agent/conversation/event";
const TURN: &str = "/api/agent/conversation/turn";
const STOP: &str = "/api/agent/conversation/turn/stop";

fn request(fixture: &OfficialCatPaw, id: &str, prompt: &str,
    telemetry: &Arc<RequestTelemetry>) -> ForwardRequest {
    let group: config::RoutingGroup = serde_json::from_value(json!({
        "id": id, "name": "Official CatPaw classifier acceptance", "model": id,
        "strategy": "order", "sticky": "off", "classifier": "catpaw/kimi-k3",
        "classifierTimeout": 20,
        "members": [{"id":"source", "provider":"catpaw", "model":"kimi-k3",
            "included":true, "accounts":[fixture.account]}],
        "rules": [{"use":"source", "intent":"coding"}]
    })).expect("real routing group shape");
    config::routing_groups::save(id, Some(group), &config::routing_groups::revision(None))
        .expect("save actual classifier routing group");
    let mut body = OfficialCatPaw::body(prompt);
    body["model"] = id.into();
    let key = api_keys::list().into_iter().find(|entry| entry.name == "official-catpaw-acceptance")
        .expect("actual configured model Key");
    ForwardRequest { body, stream:false, dedupe_key:String::new(), client_headers:fixture.headers.clone(),
        telemetry:telemetry.clone(), allowed_providers:Some(KeyScope::from_entry(&key)),
        pinned_account:None, ignore_model_gate:false, proxy_override:None }
}

fn completed(outcome: ForwardOutcome, telemetry: &RequestTelemetry) -> Value {
    let ForwardOutcome::Completion { body } = outcome else { panic!("expected the normal service aggregation") };
    super::super::internal_output::verify_completion(&body, telemetry)
        .expect("use only the fully verified original output");
    body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_classifier_and_main_reply_use_distinct_rounds() {
    let turns = Arc::new(AtomicUsize::new(0));
    let local_turns = turns.clone();
    let fixture = OfficialCatPaw::open(move |request| match request.path.as_str() {
        CATALOG => catalog_reply(),
        ROUND | EVENT | STOP => Reply::json(200, json!({"code":0})),
        TURN => if local_turns.fetch_add(1, Ordering::AcqRel) == 0 {
            complete_reply(request, r#"{"intent":"coding","effort":"none"}"#)
        } else { complete_reply(request, "complete original user answer") },
        _ => Reply::json(404, json!({"code":404})),
    }).await;
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let service = UpstreamService::new(fixture.store.clone(), AuthService::new(fixture.store.clone()));
    let request = request(&fixture, "fixture-classifier-success", "write a safe parser", &telemetry);
    let body = completed(service.forward(request).await.expect("classifier followed by main reply succeeds"), &telemetry);
    assert_eq!(body["choices"][0]["message"]["content"], "complete original user answer");
    let route = telemetry.snapshot().route.expect("the actual selected route is recorded");
    let rule = route["configSnapshot"]["rules"].as_array().expect("real rule trace")
        .iter().find(|rule| rule["groupId"] == "fixture-classifier-success")
        .expect("the classifier group's decision is recorded");
    assert_eq!(rule["classifier"]["state"], "classified", "a fail-open route does not prove classification succeeded");
    assert_eq!(rule["classifier"]["source"], "catpaw/kimi-k3");
    assert_eq!(rule["classifier"]["result"]["intent"], "coding");
    assert_eq!(rule["classifier"]["result"]["effort"], "", "this intent-only rule does not infer effort");
    assert_eq!(rule["decision"]["preferred"], json!(["source"]));
    assert_eq!(rule["decision"]["matched"][0]["index"], 0);
    assert_eq!(body["model"], "fixture-classifier-success", "keep the public model identity after original output verification");
    assert_eq!(fixture.count(ROUND), 2, "one fixed classifier and one original user intent");
    assert_eq!(fixture.count(TURN), 2);
    let requests = fixture.requests();
    let rounds: Vec<_> = requests.iter().filter(|request| request.path == ROUND).collect();
    assert_ne!(rounds[0].body["conversationId"], rounds[1].body["conversationId"],
        "the host classifier cannot impersonate the user's conversation");
    let first = rounds[0].body.to_string();
    assert!(first.contains("Classify the user's task"), "execute the actual fixed host classifier");
    assert!(first.contains("coding"));
    assert!(rounds[1].body.to_string().contains("write a safe parser"));
    assert_eq!(fixture.count(STOP), 0);
    assert!(fixture.close().await, "both completed workers release their actual ownership");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_classifier_500_is_not_replayed_and_main_reply_still_runs() {
    let rounds = Arc::new(AtomicUsize::new(0));
    let local_rounds = rounds.clone();
    let fixture = OfficialCatPaw::open(move |request| match request.path.as_str() {
        CATALOG => catalog_reply(),
        ROUND => if local_rounds.fetch_add(1, Ordering::AcqRel) == 0 {
            Reply::json(500, json!({"code":500, "message":"classifier round failure"}))
        } else { Reply::json(200, json!({"code":0})) },
        EVENT | STOP => Reply::json(200, json!({"code":0})),
        TURN => complete_reply(request, "original answer after classifier failure"),
        _ => Reply::json(404, json!({"code":404})),
    }).await;
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let service = UpstreamService::new(fixture.store.clone(), AuthService::new(fixture.store.clone()));
    let request = request(&fixture, "fixture-classifier-failure", "explain a parser failure", &telemetry);
    let body = completed(service.forward(request).await.expect("bounded classifier failure remains fail-open"), &telemetry);
    assert_eq!(body["choices"][0]["message"]["content"], "original answer after classifier failure");
    let route = telemetry.snapshot().route.expect("the fallback route is recorded");
    let rule = route["configSnapshot"]["rules"].as_array().expect("real fallback rule trace")
        .iter().find(|rule| rule["groupId"] == "fixture-classifier-failure")
        .expect("the failed classifier group's decision is recorded");
    assert_eq!(rule["classifier"]["state"], "fail-open");
    assert_eq!(rule["classifier"]["reason"], "classifier-request-failed");
    assert_eq!(body["model"], "fixture-classifier-failure");
    assert_eq!(fixture.count(ROUND), 2, "the already submitted classifier round must not be retried");
    assert_eq!(fixture.count(TURN), 1, "only the main round reaches output consumption");
    assert_eq!(fixture.count(STOP), 0, "no cleanup guess for the unconfirmed classifier round");
    assert!(!fixture.close().await, "the unconfirmed submitted classifier retains its original host ownership");
}
