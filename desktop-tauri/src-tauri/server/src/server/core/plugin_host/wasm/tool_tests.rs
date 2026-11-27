//! Original signed guests, real Key capture, SQLite and normal routing groups.
//! Only the external HTTPS transport is replaced by the local fixture server.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::StreamExt;
use serde_json::{json, Value};

use crate::server::{config, core::{account_store::AccountStore, api_keys,
    auth::AuthService, key_scope::KeyScope, plugin_host::{self, bootstrap, install,
        registry, Host, RpcAdapter, wasm::test_support::{isolated_store, LocalHttp, RecordedRequest, Reply}},
    providers::adapter::ProviderAdapter, routing_groups::{self, RequestNeeds},
    upstream::{ForwardOutcome, ForwardRequest, UpstreamService, usage::RequestTelemetry}}};

const RACCOON_CHAT: &str = "/api/web/llm/v2/chat/completions";
const CHATGLM_CHAT: &str = "/chatglm/mainchat-api/engine/stream";
const GLM: &str = "sn-glm-5-3-flash";
const DEEPSEEK: &str = "sn-deepseek-v4-1-flash-1017";

struct Fixture {
    provider: &'static str,
    store: AccountStore,
    host: Arc<Host>,
    adapter: Option<RpcAdapter>,
    account: String,
    token: String,
    key: api_keys::ApiKeyEntry,
    headers: HeaderMap,
    http: LocalHttp,
}

impl Fixture {
    async fn open(provider: &'static str,
        handler: impl Fn(&RecordedRequest) -> Reply + Send + Sync + 'static) -> Self {
        let http = LocalHttp::open(move |request| {
            if provider == "chatglm" && request.path == "/chatglm/agent-api/operation/detail" {
                // The original guest must acquire the selected account's online catalog.
                // Use its real business envelope; do not seed host permission state directly.
                Reply::json(200,json!({"code":0,"result":{"models":[
                    {"id":"glm-5.3-flash","name":"GLM-Flash"}, {"id":"glm-5.3","name":"GLM-5.3"}
                ]}}))
            } else { handler(request) }
        }).await;
        let (_, store) = isolated_store();
        let variable = if provider == "raccoon" { "AGENT2API_TEST_RACCOON_ZIP" }
            else { "AGENT2API_TEST_CHATGLM_ZIP" };
        let package = std::env::var_os(variable).map(PathBuf::from)
            .expect("supply the unchanged original signed guest ZIP");
        let installed = install::install_zip(&std::fs::read(package).unwrap()).unwrap();
        assert!(installed.signed, "acceptance must use the production official-signature verifier");
        install::set_pack_enabled(&installed.id, true).unwrap();
        install::set_provider_enabled(&installed.id, provider, true).unwrap();
        let host = bootstrap::start(store.clone()).await.expect("start the installed official host");
        let adapter = registry::acquire(provider).await.unwrap().unwrap();
        assert!(!adapter.is_stateful());
        let token = format!("fixture.{}.signature", URL_SAFE_NO_PAD.encode(
            json!({"sub":"wasm-tools-user", "uid":"wasm-tools-user", "exp":4102444800_i64}).to_string()));
        let secret = json!({"accessToken":token, "userId":"wasm-tools-user", "uid":"wasm-tools-user",
            "officeIdentity":"personal", "isGuest":false,
            "deviceId":"8d944dcc-c3a6-4e4d-af9c-627311fd7b05"});
        let saved = store.plugin_upsert_account("wasm-tools-user", provider, "Tools acceptance",
            &secret, &json!({"uid":"wasm-tools-user", "hasSession":true}), false).unwrap();
        let account = saved["id"].as_str().unwrap().to_string();
        if provider == "chatglm" {
            let refreshed = adapter.refresh_models(&store, &account, true).await;
            assert!(refreshed.refreshed, "refresh the official guest's account catalog: {:?}; requests: {:?}",
                refreshed.message, http.requests.lock().unwrap());
        }
        let key = api_keys::add("official-tools-acceptance", None, vec![provider.into()], Vec::new()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {}", key.key).parse().unwrap());
        headers.insert("x-session-id", "official-tools-acceptance-session".parse().unwrap());
        Self {provider, store, host, adapter:Some(adapter), account, token, key, headers, http}
    }

    fn request(&self, mut body: Value, stream: bool, telemetry: &Arc<RequestTelemetry>) -> ForwardRequest {
        let model = body["model"].as_str().unwrap().to_string();
        let id = format!("official-tools-{}-{}", self.provider, if stream {"stream"} else {"aggregate"});
        let group: config::RoutingGroup = serde_json::from_value(json!({
            "id":id,"name":id,"model":id,"kind":"chat","strategy":"order","sticky":"off",
            "members":[{"id":"official-guest","provider":self.provider,"model":model,
                "included":true,"accounts":[self.account]}]
        })).unwrap();
        let profiles = config::routing_profiles();
        let revision = config::routing_groups::revision(profiles.groups.get(&id));
        config::routing_groups::save(&id, Some(group.clone()), &revision).unwrap();
        body["model"] = id.clone().into();
        let accounts = self.store.routing_snapshot().accounts.iter().map(|row| row.as_ref().clone()).collect::<Vec<_>>();
        let scope = KeyScope::from_entry(&self.key);
        let projection = routing_groups::project(&group, &accounts, &RequestNeeds::from_body(&body), Some(&scope));
        assert_eq!(projection.accounts.len(), 1,
            "the real guest must be usable through normal tool routing: {:?}", projection.blocked);
        ForwardRequest {body,stream,dedupe_key:String::new(),client_headers:self.headers.clone(),
            telemetry:telemetry.clone(),allowed_providers:Some(scope),pinned_account:None,
            ignore_model_gate:false,proxy_override:None}
    }

    async fn forward(&self, body: Value, stream: bool) -> (Value, Value, String) {
        let telemetry = Arc::new(RequestTelemetry::with_id());
        let request = self.request(body, stream, &telemetry);
        let public = request.body["model"].as_str().unwrap().to_string();
        let service = UpstreamService::new(self.store.clone(), AuthService::new(self.store.clone()));
        let outcome = service.forward(request).await.expect("the official guest must finish the original call");
        assert!(matches!((&outcome, stream), (ForwardOutcome::Stream {..}, true) | (ForwardOutcome::Completion {..}, false)),
            "the final gateway outcome must match the client's stream choice");
        read_outcome(outcome, &public).await
    }

    fn requests(&self, path: &str) -> Vec<RecordedRequest> {
        self.http.requests.lock().unwrap().iter().filter(|request| request.path == path).cloned().collect()
    }

    fn add_candidate(&self, request: &ForwardRequest) {
        let user = "wasm-tools-second-user";
        let token = format!("fixture.{}.signature", URL_SAFE_NO_PAD.encode(
            json!({"sub":user,"uid":user,"exp":4102444800_i64}).to_string()));
        let secret = json!({"accessToken":token,"userId":user,"uid":user,
            "deviceId":"8d944dcc-c3a6-4e4d-af9c-627311fd7b05"});
        let row = self.store.plugin_upsert_account(user,self.provider,"Second candidate",&secret,
            &json!({"uid":user,"hasSession":true}),false).unwrap();
        let id = request.body["model"].as_str().unwrap();
        let profiles = config::routing_profiles();
        let mut group = profiles.groups.get(id).unwrap().clone();
        let revision = config::routing_groups::revision(Some(&group));
        group.members[0].accounts.push(row["id"].as_str().unwrap().to_string());
        config::routing_groups::save(id,Some(group.clone()),&revision).unwrap();
        let accounts = self.store.routing_snapshot().accounts.iter().map(|row| row.as_ref().clone()).collect::<Vec<_>>();
        let scope = KeyScope::from_entry(&self.key);
        assert_eq!(routing_groups::project(&group,&accounts,&RequestNeeds::from_body(&request.body),Some(&scope)).accounts.len(),2);
    }

    async fn close(mut self) {
        self.adapter.take();
        plugin_host::shutdown_all().await;
        assert!(self.host.local_shutdown_complete(), "complete tools must release the actual host lease");
        registry::remove(self.provider);
    }
}

fn tool_body(model: &str) -> Value {
    json!({"model":model,"messages":[{"role":"user","content":"Call get_test_number once; use its actual result."}],
        "tools":[{"type":"function","function":{"name":"get_test_number","description":"Read the client test number",
            "parameters":{"type":"object","properties":{},"additionalProperties":false}}}],
        "tool_choice":"required","parallel_tool_calls":false})
}

fn native_reply(request: &RecordedRequest) -> Reply {
    let model = &request.body["model"];
    let followup = request.body["messages"].as_array().unwrap().iter().any(|row| row["role"] == "tool");
    let delta = if followup { json!({"content":"7"}) } else {
        json!({"tool_calls":[{"index":0,"id":"call-native-test","type":"function",
            "function":{"name":"get_test_number","arguments":"{}"}}]})
    };
    let first = json!({"id":"chatcmpl-native-tools","object":"chat.completion.chunk","model":model,
        "choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let terminal = json!({"id":"chatcmpl-native-tools","object":"chat.completion.chunk","model":model,
        "choices":[{"index":0,"delta":{},"finish_reason":if followup {"stop"} else {"tool_calls"}}],
        "usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}});
    Reply::sse(format!("data: {first}\n\ndata: {terminal}\n\ndata: [DONE]\n\n"))
}

fn emulated_reply(request: &RecordedRequest) -> Reply {
    let prompt = request.body["messages"][0]["content"][0]["text"].as_str().expect("actual ChatGLM flattened prompt");
    let followup = prompt.contains("\"tool_call_id\"");
    let text = if followup {
        assert!(prompt.contains("value") && prompt.contains('7'), "client result must reach the guest");
        "7".to_string()
    } else {
        let pattern = regex::Regex::new(r#""nonce":"([0-9a-f]{48})""#).unwrap();
        let captures = pattern.captures(prompt).expect("the actual host must supply a fresh tool nonce");
        let payload = json!({"nonce":&captures[1],"calls":[{"name":"get_test_number","arguments":{}}]});
        format!("<agent2api_tool_calls>{payload}</agent2api_tool_calls>")
    };
    let frame = json!({"status":"finish","parts":[{"logic_id":"fixture-answer","content":[{"type":"text","text":text}]}],
        "usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}});
    Reply::sse(format!("data: {frame}\n\n"))
}

async fn read_outcome(outcome: ForwardOutcome, public: &str) -> (Value, Value, String) {
    match outcome {
        ForwardOutcome::Native(_) => panic!("official tool fixture must produce the standard chat protocol"),
        ForwardOutcome::Completion {body} => {
            assert_eq!(body["model"], public);
            assert!(body.get("error").is_none());
            (body["choices"][0]["message"].clone(),body["usage"].clone(),
                body["choices"][0]["finish_reason"].as_str().unwrap().to_string())
        }
        ForwardOutcome::Stream {status,mut stream} => {
            assert_eq!(status, 200);
            let mut raw = Vec::new();
            while let Some(item) = stream.next().await { raw.extend_from_slice(&item.expect("complete stream")); }
            let text = String::from_utf8(raw).unwrap();
            assert_eq!(text.lines().filter(|line| *line == "data: [DONE]").count(), 1);
            let mut message = json!({"role":"assistant","content":""});
            let mut calls = BTreeMap::<usize,Value>::new();
            let mut usage = Value::Null;
            let mut finish = String::new();
            for line in text.lines().filter_map(|line| line.strip_prefix("data: ")).filter(|line| *line != "[DONE]") {
                let frame: Value = serde_json::from_str(line).unwrap();
                assert!(frame.get("error").is_none(), "unexpected error frame: {frame}");
                assert_eq!(frame["model"], public);
                if frame.get("usage").is_some() { usage = frame["usage"].clone(); }
                for choice in frame["choices"].as_array().unwrap() {
                    if let Some(reason) = choice["finish_reason"].as_str() {
                        assert!(finish.is_empty()); finish = reason.to_string();
                    }
                    if let Some(piece) = choice["delta"]["content"].as_str() {
                        let mut content = message["content"].as_str().unwrap().to_string(); content.push_str(piece);
                        message["content"] = content.into();
                    }
                    for piece in choice["delta"]["tool_calls"].as_array().into_iter().flatten() {
                        let index = piece["index"].as_u64().unwrap() as usize;
                        let call = calls.entry(index).or_insert_with(|| json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
                        for (target,key) in [("id","id"),("name","name"),("arguments","arguments")] {
                            let source = if target == "id" {piece} else {&piece["function"]};
                            if let Some(part) = source[key].as_str() {
                                let slot = if target == "id" {&mut call[target]} else {&mut call["function"][target]};
                                let mut value = slot.as_str().unwrap().to_string(); value.push_str(part); *slot = value.into();
                            }
                        }
                    }
                }
            }
            if !calls.is_empty() { message["tool_calls"] = json!(calls.into_values().collect::<Vec<_>>()); }
            (message,usage,finish)
        }
    }
}

async fn roundtrips(fixture: &Fixture, model: &str, path: &str) {
    for stream in [false,true] {
        let mut body = tool_body(model);
        let (message,usage,finish) = fixture.forward(body.clone(),stream).await;
        assert_eq!(finish,"tool_calls");
        assert_eq!(usage["prompt_tokens"],3); assert_eq!(usage["completion_tokens"],5);
        let calls = message["tool_calls"].as_array().unwrap(); assert_eq!(calls.len(),1);
        assert_eq!(calls[0]["function"]["name"],"get_test_number");
        assert_eq!(serde_json::from_str::<Value>(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap(),json!({}));
        let id = calls[0]["id"].as_str().unwrap().to_string(); assert!(!id.is_empty());
        body["messages"].as_array_mut().unwrap().extend([
            message,json!({"role":"tool","tool_call_id":id,"content":"{\"value\":7}"})]);
        body["tool_choice"] = "auto".into();
        let (message,usage,finish) = fixture.forward(body,stream).await;
        assert_eq!(finish,"stop"); assert_eq!(message["content"],"7");
        assert!(message.get("tool_calls").is_none_or(|calls| calls.as_array().is_some_and(Vec::is_empty)));
        assert_eq!(usage["total_tokens"],8);
    }
    let requests = fixture.requests(path);
    for request in &requests {
        assert_eq!(request.headers["authorization"],format!("Bearer {}",fixture.token));
        assert!(!String::from_utf8_lossy(&request.bytes).contains(&fixture.key.key), "client Key must not leave the host");
    }
}

#[tokio::test(flavor="multi_thread",worker_threads=3)]
#[ignore="requires the unchanged signed Raccoon ZIP and a separate process with an empty temporary home"]
async fn official_raccoon_tools_route_and_roundtrip() {
    let fixture = Fixture::open("raccoon",|request| match request.path.as_str() {
        RACCOON_CHAT => native_reply(request),_ => Reply::json(404,json!({"error":"unexpected request"})),
    }).await;
    roundtrips(&fixture,GLM,RACCOON_CHAT).await;
    roundtrips(&fixture,DEEPSEEK,RACCOON_CHAT).await;
    let requests = fixture.requests(RACCOON_CHAT); assert_eq!(requests.len(),8,"one upstream call per logical request");
    for request in requests { assert_eq!(request.body["tools"][0]["function"]["name"],"get_test_number"); }
    let raw = plugin_host::rpc_cache::models_for("raccoon").unwrap();
    for id in [GLM, DEEPSEEK] {
        assert_eq!(raw.iter().find(|model| model["id"] == id).unwrap()["supportsToolCall"], false,
            "the signed guest's cached declaration must remain unchanged");
    }
    let patch = json!({"supportsToolCall": false});
    crate::server::core::model_rules::set_capabilities("raccoon", DEEPSEEK, patch.as_object().unwrap()).unwrap();
    let models = crate::server::core::providers::catalog::manifest_for_provider("raccoon");
    assert_eq!(models.iter().find(|model| model["id"] == DEEPSEEK).unwrap()["supportsToolCall"], false);
    let profiles = config::routing_profiles();
    let group = profiles.groups.get("official-tools-raccoon-stream").unwrap();
    let accounts = fixture.store.routing_snapshot().accounts.iter().map(|row| row.as_ref().clone()).collect::<Vec<_>>();
    let scope = KeyScope::from_entry(&fixture.key);
    let projection = routing_groups::project(group, &accounts, &RequestNeeds::from_body(&tool_body(DEEPSEEK)), Some(&scope));
    assert!(projection.accounts.is_empty(), "an explicit user false must continue to exclude tool requests");
    assert_eq!(fixture.requests(RACCOON_CHAT).len(), 8, "capability checks must not submit another request");
    fixture.close().await;
}

#[tokio::test(flavor="multi_thread",worker_threads=3)]
#[ignore="requires the unchanged signed ChatGLM ZIP and a separate process with an empty temporary home"]
async fn official_chatglm_tools_route_and_roundtrip() {
    let fixture = Fixture::open("chatglm",|request| match request.path.as_str() {
        CHATGLM_CHAT => emulated_reply(request),_ => Reply::json(404,json!({"error":"unexpected request"})),
    }).await;
    roundtrips(&fixture,"glm-5.3-flash",CHATGLM_CHAT).await;
    assert_eq!(fixture.requests(CHATGLM_CHAT).len(),4,"one upstream call per logical request");
    let before = crate::server::core::providers::catalog::validation_snapshot(&fixture.store);
    config::web_tools::save(false).unwrap();
    let after = crate::server::core::providers::catalog::validation_snapshot(&fixture.store);
    assert!(!Arc::ptr_eq(&before, &after), "changing the switch must invalidate the live catalog snapshot");
    let models = crate::server::core::providers::catalog::manifest_for_provider("chatglm");
    let model = models.iter().find(|model| model["id"] == "glm-5.3-flash").unwrap();
    assert_eq!(model["supportsToolCall"], false); assert_eq!(model["toolCallingMode"], "disabled");
    let profiles = config::routing_profiles();
    let group = profiles.groups.get("official-tools-chatglm-stream").unwrap();
    let accounts = fixture.store.routing_snapshot().accounts.iter().map(|row| row.as_ref().clone()).collect::<Vec<_>>();
    let scope = KeyScope::from_entry(&fixture.key);
    let needs = RequestNeeds::from_body(&tool_body("glm-5.3-flash"));
    assert!(routing_groups::project(group, &accounts, &needs, Some(&scope)).accounts.is_empty());
    config::web_tools::save(true).unwrap();
    assert_eq!(routing_groups::project(group, &accounts, &needs, Some(&scope)).accounts.len(), 1);
    let patch = json!({"supportsToolCall":false});
    crate::server::core::model_rules::set_capabilities("chatglm","glm-5.3-flash",patch.as_object().unwrap()).unwrap();
    assert!(routing_groups::project(group, &accounts, &needs, Some(&scope)).accounts.is_empty(),
        "the gateway advertisement must not override a saved user false");
    assert_eq!(fixture.requests(CHATGLM_CHAT).len(),4);
    fixture.close().await;
}

#[tokio::test(flavor="multi_thread",worker_threads=3)]
#[ignore="requires the unchanged signed ChatGLM ZIP and a separate process with an empty temporary home"]
async fn official_chatglm_invalid_tool_response_preserves_no_retry() {
    let fixture = Fixture::open("chatglm",|request| match request.path.as_str() {
        CHATGLM_CHAT => {
            let frame = json!({"status":"finish","parts":[{"logic_id":"invalid-nonce","content":[{
                "type":"text","text":"<agent2api_tool_calls>{\"nonce\":\"wrong\",\"calls\":[{\"name\":\"get_test_number\",\"arguments\":{}}]}</agent2api_tool_calls>"
            }]}]});
            Reply::sse(format!("data: {frame}\n\n"))
        }
        _ => Reply::json(404,json!({"error":"unexpected request"})),
    }).await;
    let body = tool_body("glm-5.3-flash");
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let source = config::model_key_source::capture(&fixture.headers).unwrap();
    telemetry.install_model_key_source(Ok(source));
    let outcome = fixture.adapter.as_ref().unwrap()
        .forward_conversation(&fixture.store,&fixture.account,&body,&fixture.headers,None,false,&telemetry).await;
    let error = match outcome {Err(error) => error,Ok(_) => panic!("wrong nonce must not become executable tools")};
    assert_eq!(error.status_code,502,"the guest request must reach the actual response validator: {error:?}");
    assert_eq!(error.code.as_deref(),Some("web_tools_invalid_response"));
    assert!(error.retry_forbidden,"a committed malformed tool response must never be automatically resent");
    assert_eq!(fixture.requests(CHATGLM_CHAT).len(),1);
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let request = fixture.request(tool_body("glm-5.3-flash"),false,&telemetry);
    fixture.add_candidate(&request);
    let service = UpstreamService::new(fixture.store.clone(),AuthService::new(fixture.store.clone()));
    let error = match service.forward(request).await {Err(error) => error,Ok(_) => panic!("malformed tools must fail through the normal gateway")};
    assert_eq!(error.code.as_deref(),Some("web_tools_invalid_response")); assert!(error.retry_forbidden);
    assert_eq!(fixture.requests(CHATGLM_CHAT).len(),2,"two logical requests must submit once each, despite the second available account");
    assert_eq!(telemetry.snapshot().attempts_detail.len(),1,"the committed malformed response must not rotate accounts");
    let mut body = tool_body("glm-5.3-flash");
    body["tools"][0]["function"]["parameters"] = json!({"$ref":"https://untrusted.invalid/schema.json"});
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let request = fixture.request(body,false,&telemetry); fixture.add_candidate(&request);
    let error = match service.forward(request).await {Err(error) => error,Ok(_) => panic!("invalid schema must fail locally")};
    assert_eq!(error.status_code,400); assert_eq!(error.code.as_deref(),Some("web_tools_invalid_request"));
    assert!(error.retry_forbidden); assert_eq!(telemetry.snapshot().attempts_detail.len(),1);
    assert_eq!(fixture.requests(CHATGLM_CHAT).len(),2,"local parameter errors must not contact the upstream or rotate accounts");
    fixture.close().await;
}

#[tokio::test(flavor="multi_thread",worker_threads=3)]
#[ignore="requires the unchanged signed ChatGLM ZIP and a separate process with an empty temporary home"]
async fn original_rpc_stream_final_error_overrides_the_preliminary_public_frame() {
    use agent2api_provider_protocol as proto;
    use std::sync::Mutex;
    let fixture = Fixture::open("chatglm", |_| Reply::json(404,json!({"error":"unexpected request"}))).await;
    for (status, code) in [(429, "provider_http:{\"status\":429,\"code\":\"quota_business\",\"upstreamCode\":6029}"),
        (499, proto::WireError::ABORTED), (504, "timeout"),
        (502, "provider_http:{\"status\":502,\"code\":\"cleanup_failed\",\"upstreamCode\":6029}")] {
        let (tx, events) = tokio::sync::mpsc::unbounded_channel();
        let failure = Arc::new(Mutex::new(None));
        tx.send(plugin_host::StreamEvent::Chunk(b"data: {\"error\":{\"message\":\"preliminary public error\"}}\n\n".to_vec())).unwrap();
        tx.send(plugin_host::StreamEvent::Done(Err(proto::WireError::with_code("original terminal failure", code)))).unwrap();
        drop(tx);
        let source = plugin_host::RpcStream::with_pending("chatglm", fixture.host.clone(), -1, events.into(), None,
            Arc::new(RequestTelemetry::new()), Some(failure.clone()), None, fixture.host.activity.acquire().unwrap());
        let _: Vec<_> = source.collect().await;
        let guard = failure.lock().unwrap();
        let actual = guard.as_ref().expect("the original stream must retain its terminal error");
        assert_eq!(actual.status_code,status,"the public frame cannot replace the real terminal failure");
        assert_eq!(actual.message,"original terminal failure");
        assert_eq!(actual.code.as_deref(),Some(match status {429 => "quota_business",499 => proto::WireError::ABORTED,
            504 => "timeout",_ => "cleanup_failed"}));
        if matches!(status,429 | 502) { assert_eq!(actual.upstream_code,Some(6029)); }
    }
    fixture.close().await;
}
