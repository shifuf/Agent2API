use std::sync::atomic::{AtomicBool, Ordering};

use futures::{FutureExt, StreamExt};
use serde_json::json;

use super::*;

const ALIAS: &str = "public-route-alias";

// Only the identity reservation is substituted here. Parsing, original message
// evidence, both output observers and all output state transitions are real.
struct Reservation(Arc<AtomicBool>);
impl Original for Reservation {
    fn matches(&self, _: &SourceRef, _: &Record, _: u64) -> bool { false }
    fn verify(&self, observation: &OutputObservation) -> Result<(), proto::WireError> {
        if self.0.load(Ordering::Acquire) && observation.matches_identity("chatcmpl-original", "kimi-k3", 1_700_000_000) {
            Ok(())
        } else { Err(unconfirmed()) }
    }
}

fn slot() -> (Arc<OutputSlot>, Arc<AtomicBool>) {
    let slot = OutputSlot::new();
    slot.select().unwrap();
    let current = Arc::new(AtomicBool::new(true));
    slot.state.lock().unwrap().binding = Some(Binding {
        original: Box::new(Reservation(current.clone())),
        expected: ExpectedOutput::from_message(&json!({"type":"assistant", "finished":true,
            "content":[{"type":"text", "text":"original answer"}]})).unwrap(),
    });
    (slot, current)
}

fn body() -> Value {
    json!({"id":"chatcmpl-original", "object":"chat.completion", "created":1_700_000_000,
        "model":"kimi-k3", "choices":[{"index":0,
            "message":{"role":"assistant", "content":"original answer"}, "finish_reason":"stop"}],
        "usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})
}

fn frames(raw: &Value) -> bytes::Bytes {
    let identity = |delta: Value, finish: Value| json!({"id":raw["id"],"object":"chat.completion.chunk",
        "created":raw["created"],"model":raw["model"],"choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
    let chunks = [identity(json!({"role":"assistant"}), Value::Null),
        identity(json!({"content":raw["choices"][0]["message"]["content"]}), Value::Null),
        identity(json!({}), json!("stop")),
        json!({"id":raw["id"],"object":"chat.completion.chunk","created":raw["created"],
            "model":raw["model"],"choices":[],"usage":raw["usage"]})];
    let mut output = chunks.into_iter().map(|chunk| format!("data: {chunk}\n\n")).collect::<String>();
    output.push_str("data: [DONE]\n\n");
    bytes::Bytes::from(output)
}

fn pending(slot: &OutputSlot) {
    let state = slot.state.lock().unwrap();
    assert!(state.output == OutputState::Pending);
    assert!(!state.body_ended, "raw source proof cannot confirm delivery or permit continuation");
}

fn finish(slot: &Arc<OutputSlot>, body: &Value) -> Result<(), proto::WireError> {
    let mut guard = slot.take()?.ok_or_else(unconfirmed)?;
    guard.observe_json(&serde_json::to_vec(body).unwrap())?;
    guard.prepare()?;
    assert!(!slot.state.lock().unwrap().body_ended, "prepare alone cannot permit continuation");
    guard.finish()
}

#[test]
fn trusted_alias_json_needs_original_proof_and_final_completion() {
    let (slot, _) = slot();
    let original = body();
    slot.project_completion(&original, ALIAS).unwrap();
    pending(&slot);
    let mut projected = original;
    projected["model"] = ALIAS.into();
    finish(&slot, &projected).unwrap();
    let state = slot.state.lock().unwrap();
    assert!(state.output == OutputState::Observed && state.body_ended);
}

#[test]
fn trusted_alias_rejects_raw_identity_and_message_tampering() {
    for field in ["model", "id", "created", "content"] {
        let (slot, _) = slot();
        let mut raw = body();
        match field {
            "created" => raw[field] = json!(1_700_000_001),
            "content" => raw["choices"][0]["message"][field] = "changed".into(),
            _ => raw[field] = "changed".into(),
        }
        assert!(slot.project_completion(&raw, ALIAS).is_err(), "raw {field}");
        assert!(!slot.state.lock().unwrap().body_ended);
    }
}

#[test]
fn trusted_alias_rejects_final_identity_message_and_usage_tampering() {
    for field in ["model", "id", "created", "content", "usage"] {
        let (slot, _) = slot();
        let mut projected = body();
        slot.project_completion(&projected, ALIAS).unwrap();
        projected["model"] = ALIAS.into();
        match field {
            "created" => projected[field] = json!(1_700_000_001),
            "content" => projected["choices"][0]["message"][field] = "changed".into(),
            "usage" => projected[field] = json!({"prompt_tokens":1,"completion_tokens":4,"total_tokens":5}),
            _ => projected[field] = "changed".into(),
        }
        assert!(finish(&slot, &projected).is_err(), "final {field}");
        assert!(!slot.state.lock().unwrap().body_ended);
    }
}

#[test]
fn trusted_alias_rechecks_original_reservation_and_disallows_rebinding() {
    let (slot, current) = slot();
    let mut projected = body();
    slot.project_completion(&projected, ALIAS).unwrap();
    current.store(false, Ordering::Release);
    projected["model"] = ALIAS.into();
    assert!(finish(&slot, &projected).is_err(), "the raw proof cannot outlive its original reservation");
    let (slot, _) = self::slot();
    slot.project_completion(&body(), ALIAS).unwrap();
    assert!(slot.project_completion(&body(), "different-alias").is_err());
    assert!(slot.take().is_err(), "failed rebinding poisons the original output too");
}

#[tokio::test]
async fn trusted_alias_stream_eof_proves_raw_output_without_confirming_final_output() {
    let (slot, _) = slot();
    let raw = frames(&body());
    let source = Box::new(futures::stream::iter([Ok(raw.clone())]));
    let mut source = slot.project_stream(source, ALIAS).unwrap();
    assert_eq!(source.next().await.unwrap().unwrap(), raw);
    pending(&slot);
    assert!(source.next().await.is_none());
    pending(&slot);
    let mut projected = body();
    projected["model"] = ALIAS.into();
    finish(&slot, &projected).unwrap();
}

#[tokio::test]
async fn trusted_alias_stream_done_without_eof_and_drop_cannot_confirm_output() {
    let (slot, _) = slot();
    let source = futures::stream::iter([Ok(frames(&body()))]).chain(futures::stream::pending());
    let mut source = slot.project_stream(Box::new(source), ALIAS).unwrap();
    source.next().await.unwrap().unwrap();
    assert!(source.next().now_or_never().is_none(), "DONE is not source EOF");
    pending(&slot);
    drop(source);
    assert!(slot.take().is_err());
    assert!(!slot.state.lock().unwrap().body_ended);
}

#[tokio::test]
async fn trusted_alias_stream_rejects_raw_tamper_truncation_and_transport_failure() {
    for mode in 0..6 {
        let (slot, _) = slot();
        let mut raw = body();
        match mode {
            0 => raw["model"] = ALIAS.into(),
            1 => raw["id"] = "different-response".into(),
            2 => raw["created"] = json!(1_700_000_001),
            _ => {},
        }
        let bytes = frames(&raw);
        let source: ChatStream = match mode {
            3 => Box::new(futures::stream::iter([Ok(bytes.slice(..bytes.len() - 14))])),
            4 => Box::new(futures::stream::iter([Ok(bytes), Err(std::io::Error::other("transport failed"))])),
            5 => Box::new(futures::stream::iter([Ok(bytes), Ok(bytes::Bytes::from_static(b": after DONE\n\n"))])),
            _ => Box::new(futures::stream::iter([Ok(bytes)])),
        };
        let mut source = slot.project_stream(source, ALIAS).unwrap();
        let mut rejected = false;
        while let Some(item) = source.next().await { rejected |= item.is_err(); }
        assert!(rejected, "raw stream mode {mode}");
        assert!(!slot.state.lock().unwrap().body_ended);
    }
}

#[tokio::test]
async fn trusted_alias_final_guard_still_rejects_missing_eof_and_drop() {
    let (slot, _) = slot();
    let mut source = slot.project_stream(Box::new(futures::stream::iter([Ok(frames(&body()))])), ALIAS).unwrap();
    while let Some(item) = source.next().await { item.unwrap(); }
    pending(&slot);
    let mut projected = body();
    projected["model"] = ALIAS.into();
    let mut guard = slot.take().unwrap().unwrap();
    guard.push(&frames(&projected)).unwrap();
    assert!(guard.terminal_seen());
    pending(&slot);
    drop(guard);
    assert!(!slot.state.lock().unwrap().body_ended);
    assert!(slot.take().is_err());
}

#[tokio::test]
async fn trusted_alias_final_completion_cannot_skip_the_original_eof() {
    let (slot, _) = slot();
    let source = futures::stream::iter([Ok(frames(&body()))]).chain(futures::stream::pending());
    let mut source = slot.project_stream(Box::new(source), ALIAS).unwrap();
    source.next().await.unwrap().unwrap();
    let mut projected = body();
    projected["model"] = ALIAS.into();
    assert!(finish(&slot, &projected).is_err(), "a complete projected body cannot fabricate original EOF");
    assert!(!slot.state.lock().unwrap().body_ended);
    drop(source);
}

#[tokio::test]
async fn trusted_alias_final_stream_keeps_exact_identity_and_projection() {
    for field in ["valid", "model", "id", "created", "content", "usage"] {
        let (slot, _) = slot();
        let raw = body();
        let mut source = slot.project_stream(Box::new(futures::stream::iter([Ok(frames(&raw))])), ALIAS).unwrap();
        while let Some(item) = source.next().await { item.unwrap(); }
        let mut projected = raw;
        projected["model"] = ALIAS.into();
        match field {
            "valid" => {},
            "created" => projected[field] = json!(1_700_000_001),
            "content" => projected["choices"][0]["message"][field] = "changed".into(),
            "usage" => projected[field] = json!({"prompt_tokens":1,"completion_tokens":4,"total_tokens":5}),
            _ => projected[field] = "changed".into(),
        }
        let mut guard = slot.take().unwrap().unwrap();
        for part in frames(&projected).chunks(7) { guard.push(part).unwrap(); }
        assert!(guard.terminal_seen());
        pending(&slot);
        let prepared = guard.prepare();
        if field == "valid" {
            prepared.unwrap();
            assert!(!slot.state.lock().unwrap().body_ended);
            guard.finish().unwrap();
        } else {
            assert!(prepared.is_err(), "final stream {field}");
            assert!(!slot.state.lock().unwrap().body_ended);
        }
    }
}
