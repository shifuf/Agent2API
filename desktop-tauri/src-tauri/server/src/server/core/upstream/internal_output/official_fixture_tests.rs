//! Real installed guest output, observed by the same consumer used for titles
//! and model tests. These cases require an explicit isolated process per test.
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use futures::StreamExt;
use serde_json::json;

use crate::server::core::{plugin_host::wasm::test_support::{OfficialCatPaw, Reply,
    catalog_reply, complete_reply}, upstream::{ForwardOutcome, usage::RequestTelemetry}};

const CATALOG: &str = "/api/agent/maas/model-types";
const ROUND: &str = "/api/agent/conversation/round";
const EVENT: &str = "/api/agent/conversation/event";
const TURN: &str = "/api/agent/conversation/turn";
const STOP: &str = "/api/agent/conversation/turn/stop";

async fn fixture() -> OfficialCatPaw {
    OfficialCatPaw::open(|request| match request.path.as_str() {
        CATALOG => catalog_reply(),
        ROUND | EVENT | STOP => Reply::json(200, json!({"code":0})),
        TURN => complete_reply(request, "original verified answer"),
        _ => Reply::json(404, json!({"code":404})),
    }).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_external_fixed_parameters_remain_rejected() {
    let mut fixture = fixture().await;
    fixture.headers.insert("user-agent", "agent2api-router/1".parse().unwrap());
    for parameters in [json!({"temperature":0, "max_tokens":192}),
        json!({"max_tokens":120}), json!({"max_tokens":8192})] {
        for spoofed_metadata in [false, true] {
            let mut body = OfficialCatPaw::body("ordinary external request");
            body.as_object_mut().unwrap().extend(parameters.as_object().unwrap().clone());
            if spoofed_metadata {
                body["metadata"] = json!({"classifier":true, "hostRequestDefaults":"Classifier"});
            }
            let telemetry = Arc::new(RequestTelemetry::with_id());
            let error = match fixture.forward(&body, false, &telemetry).await {
                Err(error) => error, Ok(_) => panic!("a client acquired private host parameter adaptation"),
            };
            // The original-material gate rejects these parameters before a guest
            // can obtain an execution permit. Its fixed WireError contract is
            // a 502 projection error, not the guest's later 400 validation.
            assert_eq!(error.status_code, 502, "normal external parameters retain strict original-material validation: {error:?}");
            assert_eq!(error.code.as_deref(), Some("catpaw_call_projection_unexpressed"),
                "reject unsupported original material at the real gate, not an unrelated condition: {error:?}");
            assert!(error.message.contains("原请求") && error.message.contains("未忽略或替换原材料"));
            assert_eq!(fixture.count(ROUND), 0, "unsupported external parameters cannot create a remote round");
        }
    }
    assert!(fixture.close().await, "rejected external input did not retain remote ownership");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_host_title_and_model_test_defaults_are_accepted() {
    let fixture = fixture().await;
    for (model_test, max_tokens) in [(false, 120), (true, 8192)] {
        let telemetry = Arc::new(RequestTelemetry::with_id());
        if model_test { telemetry.mark_anthropic_model_test_defaults(); }
        else { telemetry.mark_title_defaults(); }
        let mut body = OfficialCatPaw::body(if model_test {"test the model"} else {"give a short title"});
        body["max_tokens"] = max_tokens.into();
        let outcome = fixture.forward(&body, false, &telemetry).await
            .expect("genuine fixed host request is adapted before the original material is sealed");
        let ForwardOutcome::Completion { body:output } = outcome else { panic!("expected complete host result") };
        super::verify_completion(&output, &telemetry).expect("complete host output is verified");
        assert_eq!(output["choices"][0]["message"]["content"], "original verified answer");
        assert_eq!(body["max_tokens"], max_tokens, "host adaptation does not mutate the original body");
    }
    assert_eq!(fixture.count(ROUND), 2);
    assert!(fixture.close().await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_internal_stream_is_verified_only_at_eof() {
    let fixture = fixture().await;
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let outcome = fixture.forward(&OfficialCatPaw::body("stream the complete original answer"), true, &telemetry)
        .await.expect("actual signed guest produces a stream");
    let ForwardOutcome::Stream {stream, status} = outcome else {panic!("expected actual guest stream")};
    assert_eq!(status, 200);
    let mut stream = super::observe_stream(stream, &telemetry);
    let mut received = Vec::new();
    while let Some(chunk) = stream.next().await { received.extend_from_slice(&chunk.expect("valid original stream frame")); }
    let received = String::from_utf8(received).expect("actual stream is UTF-8");
    assert!(received.contains("original verified answer"));
    assert!(received.contains("[DONE]"));
    assert_eq!(fixture.count(ROUND), 1);
    assert_eq!(fixture.count(TURN), 1);
    assert!(fixture.close().await, "EOF verification releases the genuine completed worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_internal_completion_rejects_changed_output() {
    let fixture = fixture().await;
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let body = OfficialCatPaw::body("keep the original completion");
    let outcome = fixture.forward(&body, false, &telemetry).await.expect("actual original output exists");
    let ForwardOutcome::Completion {mut body} = outcome else {panic!("expected genuine completion")};
    body["choices"][0]["message"]["content"] = "altered consumer output".into();
    let error = super::verify_completion(&body, &telemetry).expect_err("changed output cannot become a successful title/test");
    assert_eq!(error.status_code, 502);
    assert!(error.retry_forbidden);
    assert!(!error.message.contains("altered consumer output"));
    assert_eq!(fixture.count(ROUND), 1, "verification never resubmits the original turn");
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires official CatPaw ZIP and explicit isolated test proxy home; run in a separate process"]
async fn official_catpaw_internal_stream_rejects_changed_output() {
    let fixture = fixture().await;
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let outcome = fixture.forward(&OfficialCatPaw::body("keep the original stream"), true, &telemetry)
        .await.expect("actual original stream exists");
    let ForwardOutcome::Stream {stream, ..} = outcome else {panic!("expected genuine stream")};
    let changed = Arc::new(AtomicBool::new(false));
    let marker = changed.clone();
    let changed_stream = stream.map(move |chunk| chunk.map(|bytes| {
        let original = std::str::from_utf8(&bytes).expect("actual guest stream UTF-8");
        let output = original.replace("original verified answer", "altered consumer output");
        if output != original {marker.store(true, Ordering::Release);}
        bytes::Bytes::from(output)
    }));
    let mut stream = super::observe_stream(Box::new(changed_stream), &telemetry);
    let mut rejected = false;
    while let Some(chunk) = stream.next().await {
        if let Err(error) = chunk {
            assert!(!error.to_string().contains("altered consumer output"));
            rejected = true;
            break;
        }
    }
    assert!(changed.load(Ordering::Acquire), "the test changed real guest output before observation");
    assert!(rejected, "fully read changed output must fail final verification");
    assert_eq!(fixture.count(ROUND), 1);
    fixture.close().await;
}
