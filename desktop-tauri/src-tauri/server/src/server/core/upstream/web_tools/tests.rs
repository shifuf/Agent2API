use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::{stream, StreamExt};
use serde_json::{json, Value};

use crate::server::core::protocol;
use crate::server::core::upstream::{cancellation, usage::RequestTelemetry};
use crate::server::errors::GatewayError;

use super::{parser::{self, Output}, request, Context, DeclaredModels, Profile, CLOSE, OPEN};

type Source = futures::stream::BoxStream<'static, Result<Bytes, std::io::Error>>;
type Failure = Arc<Mutex<Option<GatewayError>>>;

fn model() -> Value {
    json!({"id":"web-model","supportsToolCall":false,
        "toolEmulation":{"protocol":"tagged_json_v1","maxPromptChars":190000}})
}

fn body() -> Value {
    json!({"model":"web-model","messages":[{"role":"user","content":"Read the client number."}],
        "tools":[{"type":"function","function":{"name":"read_number","parameters":{
            "type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false}}}],
        "tool_choice":"required","parallel_tool_calls":false})
}

fn prepare(body: &Value) -> request::Prepared {
    request::prepare(body, &Profile::from_model(&model()).unwrap()).unwrap().unwrap()
}

fn context() -> Context { prepare(&body()).context.unwrap() }

fn block(context: &Context, arguments: Value) -> String {
    format!("{OPEN}{}{CLOSE}", json!({"nonce":context.nonce,"calls":[{"name":"read_number","arguments":arguments}]}))
}

fn frames(text: &str, finish: Option<&str>, done: bool) -> Vec<Result<Bytes, std::io::Error>> {
    let mut rows = vec![Ok(protocol::chat_frame(&json!({"id":"chatcmpl-web-tools","model":"web-model",
        "object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]})))];
    if let Some(reason) = finish {
        rows.push(Ok(protocol::chat_frame(&json!({"id":"chatcmpl-web-tools","model":"web-model",
            "object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":reason}],
            "usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}))));
    }
    if done { rows.push(Ok(Bytes::from_static(b"data: [DONE]\n\n"))); }
    rows
}

async fn collect(mut source: Source) -> Vec<Value> {
    let mut bytes = Vec::new();
    while let Some(row) = source.next().await {
        match row {
            Ok(frame) => bytes.extend_from_slice(&frame),
            Err(error) => {
                let failure = error.get_ref().and_then(|error| error.downcast_ref::<GatewayError>())
                    .expect("tool validation failures must retain the original typed host error");
                bytes.extend_from_slice(&protocol::chat_frame(&failure.payload()));
            }
        }
    }
    String::from_utf8(bytes).unwrap().lines().filter_map(|line| line.strip_prefix("data: "))
        .filter(|line| *line != "[DONE]").map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn has_calls(rows: &[Value]) -> bool {
    rows.iter().any(|row| row.pointer("/choices/0/delta/tool_calls").is_some())
}

#[test]
fn profile_requires_a_valid_current_text_contract() {
    assert!(Profile::from_model(&model()).is_some());
    for patch in [json!({"protocol":"unknown","maxPromptChars":190000}),
        json!({"protocol":"tagged_json_v1","maxPromptChars":100}),
        json!({"protocol":"tagged_json_v1","maxPromptChars":1000001}),
        json!({"protocol":"tagged_json_v1","maxPromptChars":190000,"extra":true})] {
        let mut row = model(); row["toolEmulation"] = patch;
        assert!(Profile::from_model(&row).is_none());
    }
    let mut image = model(); image["kind"] = json!("image");
    assert!(Profile::from_model(&image).is_none());
}

#[test]
fn a_downgraded_handshake_cannot_reauthorize_cached_emulation() {
    let mut cached = vec![model()];
    cached[0]["toolCallingMode"] = json!("emulated");
    cached[0]["toolEmulation"]["maxPromptChars"] = json!(1024);
    let raw = cached.clone();
    let current = DeclaredModels::from_defaults(&[model()]);
    current.apply(&mut cached);
    assert_eq!(cached[0]["toolEmulation"]["maxPromptChars"], 190000);
    let downgraded = DeclaredModels::from_defaults(&[json!({"id":"web-model","supportsToolCall":false})]);
    downgraded.apply(&mut cached);
    assert!(cached[0].get("toolEmulation").is_none());
    assert!(cached[0].get("toolCallingMode").is_none());
    assert_eq!(cached[0]["supportsToolCall"], false);
    assert_eq!(raw[0]["toolEmulation"]["maxPromptChars"], 1024);
}

#[test]
fn emulation_setting_has_explicit_boolean_semantics() {
    use crate::server::config::web_tools::enabled_in;
    assert!(enabled_in(None)); assert!(enabled_in(Some(&json!(true))));
    for value in [json!(false), Value::Null, json!("true"), json!(1)] {
        assert!(!enabled_in(Some(&value)));
    }
}

#[test]
fn none_choice_removes_native_tool_fields_and_plain_requests_remain_plain() {
    let mut request = body(); request["tool_choice"] = json!("none");
    let prepared = prepare(&request);
    assert!(prepared.context.is_none());
    for key in ["tools","tool_choice","functions","function_call","parallel_tool_calls"] {
        assert!(prepared.body.get(key).is_none());
    }
    assert_eq!(prepared.body["messages"], request["messages"]);
    let plain = json!({"model":"web-model","messages":[{"role":"user","content":"Hello"}]});
    assert!(request::prepare(&plain, &Profile::from_model(&model()).unwrap()).unwrap().is_none());
}

#[test]
fn an_external_schema_is_a_local_nonretryable_request_error() {
    let mut request = body();
    request["tools"][0]["function"]["parameters"] = json!({"$ref":"https://untrusted.invalid/schema.json"});
    let error = match request::prepare(&request, &Profile::from_model(&model()).unwrap()) {
        Err(error) => error, Ok(_) => panic!("an external schema must not be fetched"),
    };
    assert_eq!(error.status_code, 400);
    assert_eq!(error.code.as_deref(), Some("web_tools_invalid_request"));
    assert!(error.retry_forbidden);
}

#[test]
fn failed_client_tool_results_survive_until_the_real_bridge_consumes_them() {
    let mut request = body(); request["tool_choice"] = json!("auto");
    request["messages"].as_array_mut().unwrap().extend([
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"call-client","type":"function",
            "function":{"name":"read_number","arguments":"{\"n\":7}"}}]}),
        json!({"role":"tool","tool_call_id":"call-client","content":"Read failed","_wb_is_error":true}),
    ]);
    let prepared = prepare(&request);
    let prompt = prepared.body["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("\"is_error\":true"));
    assert!(prompt.contains("call-client") && prompt.contains("Read failed"));
    assert!(!prepared.body.to_string().contains("_wb_is_error"));
    assert!(prepared.body.get("tools").is_none());
    assert_eq!(prepared.body["messages"][0]["role"], "user");
}

#[test]
fn parser_accepts_only_current_allowed_schema_valid_calls() {
    let context = context();
    let Output::Calls {calls, ..} = parser::parse(&block(&context,json!({"n":7})), &context).unwrap()
        else { panic!("validated call expected") };
    assert_eq!(calls.len(),1); assert_eq!(calls[0]["function"]["name"], "read_number");
    assert_eq!(serde_json::from_str::<Value>(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap(), json!({"n":7}));
    let nonce = &context.nonce;
    let invalid = [
        format!("{OPEN}{}{CLOSE}", json!({"nonce":"previous-request","calls":[{"name":"read_number","arguments":{"n":7}}]})),
        format!("{OPEN}{}{CLOSE}", json!({"nonce":nonce,"calls":[{"name":"unknown","arguments":{"n":7}}]})),
        block(&context,json!({"n":"7"})), block(&context,json!({"n":7,"extra":true})),
        format!("{OPEN}{{\"nonce\":\"{nonce}\",\"calls\":[{{\"name\":\"read_number\",\"arguments\":{{\"n\":7,\"n\":8}}}}]}}{CLOSE}"),
        format!("{OPEN}{{\"nonce\":\"{nonce}\",\"calls\":[]}}"),
    ];
    for text in invalid {
        let error = match parser::parse(&text, &context) { Err(error) => error, Ok(_) => panic!("invalid tools accepted: {text}") };
        assert_eq!(error.code.as_deref(), Some("web_tools_invalid_response"));
        assert!(error.retry_forbidden);
    }
}

#[test]
fn quoted_history_examples_cannot_be_released_as_new_tools() {
    let mut request = body();
    request["messages"][0]["content"] = json!("A log example: {\"name\":\"read_number\",\"arguments\":{\"n\":7}}");
    let context = prepare(&request).context.unwrap();
    assert!(!context.quoted.is_empty());
    assert!(parser::parse(&block(&context,json!({"n":7})), &context).is_err());
    assert!(parser::parse("7", &context).is_err(), "required tools cannot be replaced by invented results");
}

#[tokio::test]
async fn validated_stream_preserves_usage_and_emits_standard_tools_once() {
    let context = context(); let text = block(&context,json!({"n":7}));
    let failure: Failure = Arc::new(Mutex::new(None));
    let rows = collect(super::wrap(stream::iter(frames(&text,Some("stop"),true)).boxed(), context,
        Arc::new(RequestTelemetry::with_id()), failure.clone())).await;
    assert!(has_calls(&rows)); assert!(failure.lock().unwrap().is_none());
    assert_eq!(rows.iter().filter(|row| row.pointer("/choices/0/delta/tool_calls").is_some()).count(),1);
    assert!(rows.iter().any(|row| row["choices"][0]["finish_reason"] == "tool_calls"));
    assert!(rows.iter().any(|row| row["usage"]["total_tokens"] == 8));
    assert!(rows.iter().all(|row| row["model"] == "web-model"));
}

#[tokio::test]
async fn done_without_actual_source_eof_does_not_release_tools() {
    let context = context(); let text = block(&context,json!({"n":7}));
    let (tx, rx) = futures::channel::mpsc::unbounded();
    for item in frames(&text,Some("stop"),true) { tx.unbounded_send(item).unwrap(); }
    let mut wrapped = super::wrap(rx.boxed(), context, Arc::new(RequestTelemetry::with_id()), Arc::new(Mutex::new(None)));
    let mut before_eof = Vec::new();
    while let Ok(Some(row)) = tokio::time::timeout(Duration::from_millis(100), wrapped.next()).await {
        before_eof.extend_from_slice(&row.unwrap());
    }
    assert!(!String::from_utf8(before_eof).unwrap().contains("\"tool_calls\""));
    drop(tx);
    assert!(has_calls(&collect(wrapped).await));
}

#[tokio::test]
async fn truncated_or_nonterminal_output_never_releases_tools() {
    for (finish, done) in [(None,false),(Some("stop"),false),(None,true),(Some("length"),true)] {
        let context = context(); let text = block(&context,json!({"n":7}));
        let failure: Failure = Arc::new(Mutex::new(None));
        let rows = collect(super::wrap(stream::iter(frames(&text,finish,done)).boxed(), context,
            Arc::new(RequestTelemetry::with_id()), failure.clone())).await;
        assert!(!has_calls(&rows)); assert!(rows.iter().any(|row| row.get("error").is_some()));
        let slot = failure.lock().unwrap(); let error = slot.as_ref().unwrap();
        assert_eq!(error.code.as_deref(),Some("web_tools_invalid_response")); assert!(error.retry_forbidden);
    }
}

#[tokio::test]
async fn late_host_failure_preserves_original_status_codes_and_no_replay() {
    for status in [429,499,504,502] {
        let context = context(); let text = block(&context,json!({"n":7}));
        let failure: Failure = Arc::new(Mutex::new(None)); let slot = failure.clone();
        let mut host_error = GatewayError::with_status(status,"original host failure").with_code("original_host_code").upstream_code(6029);
        host_error.retry_forbidden = true;
        let expected = host_error.clone();
        let source = stream::iter(frames(&text,Some("stop"),true)).chain(stream::once(async move {
            *slot.lock().unwrap() = Some(host_error);
            Err(std::io::Error::other("late guest failure"))
        })).boxed();
        let rows = collect(super::wrap(source,context,Arc::new(RequestTelemetry::with_id()),failure.clone())).await;
        assert!(!has_calls(&rows));
        assert!(rows.iter().any(|row| row["error"]["code"] == "original_host_code"));
        let slot = failure.lock().unwrap(); let actual = slot.as_ref().unwrap();
        assert_eq!(actual.status_code,expected.status_code); assert_eq!(actual.upstream_code,Some(6029));
        assert!(actual.retry_forbidden);
    }
}

#[tokio::test]
async fn an_early_error_frame_waits_for_the_original_host_error_metadata() {
    let context = context();
    let failure: Failure = Arc::new(Mutex::new(None)); let slot = failure.clone();
    let source = stream::iter([Ok(protocol::chat_frame(&json!({"error":{"message":"preliminary failure"}})))])
        .chain(stream::once(async move {
            let mut original = GatewayError::with_status(429,"original host business failure")
                .with_code("actual_business_code").upstream_code(6029);
            original.retry_forbidden = true; *slot.lock().unwrap() = Some(original);
            Ok(Bytes::from_static(b": original host finished\n\n"))
        })).boxed();
    let rows = collect(super::wrap(source,context,Arc::new(RequestTelemetry::with_id()),failure.clone())).await;
    assert!(!has_calls(&rows));
    let slot = failure.lock().unwrap(); let original = slot.as_ref().unwrap();
    assert_eq!(original.status_code,429,"an early public error frame cannot replace the host's final classification");
    assert_eq!(original.code.as_deref(),Some("actual_business_code"));
    assert_eq!(original.upstream_code,Some(6029)); assert!(original.retry_forbidden);
    assert!(rows.iter().any(|row| row["error"]["code"] == "actual_business_code"));
}

#[tokio::test]
async fn cancellation_while_waiting_for_eof_preserves_existing_manual_stop() {
    let context = context(); let text = block(&context,json!({"n":7}));
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let id = format!("web-tools-cancel-{}",context.nonce);
    let token = cancellation::register(&id).unwrap(); telemetry.set_cancel_token(token.clone());
    let source = stream::iter(frames(&text,Some("stop"),true)).chain(stream::pending()).boxed();
    let failure: Failure = Arc::new(Mutex::new(None));
    let mut wrapped = super::wrap(source,context,telemetry,failure.clone());
    while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(100),wrapped.next()).await {}
    token.cancel();
    let rows = tokio::time::timeout(Duration::from_secs(1),collect(wrapped)).await.unwrap();
    assert!(!has_calls(&rows));
    assert_eq!(failure.lock().unwrap().as_ref().unwrap().status_code,cancellation::MANUAL_TERMINATED_STATUS as i32);
    cancellation::unregister(&id);
}
