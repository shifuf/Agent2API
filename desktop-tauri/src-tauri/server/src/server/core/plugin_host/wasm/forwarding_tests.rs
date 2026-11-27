//! Execute the installed signed WorkBuddy Intl guest through normal routing.
//! Each case requires a separate process and an explicitly empty temporary home.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::http::HeaderMap;
use futures::StreamExt;
use serde_json::{json, Value};

use crate::server::{config, core::{account_store::AccountStore, api_keys,
    auth::AuthService, key_scope::KeyScope,
    plugin_host::{self, bootstrap, install, registry, Host, RpcAdapter,
        wasm::test_support::{isolated_store, LocalHttp, RecordedRequest, Reply}},
    providers::adapter::ProviderAdapter}};
use crate::server::core::upstream::{ForwardOutcome, ForwardRequest, UpstreamService, usage::RequestTelemetry};

const PROVIDER: &str = "workbuddy-intl";
const CHAT: &str = "/v2/chat/completions";
const GENERATE: &str = "/v2/images/generations";
const EDIT: &str = "/v2/images/edits";
const IMAGE: &str = "gpt-image-1";
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";

struct Fixture {
    store: AccountStore,
    host: Arc<Host>,
    adapter: Option<RpcAdapter>,
    account: String,
    headers: HeaderMap,
    http: LocalHttp,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires an explicitly isolated temporary home and a signed WorkBuddy Intl fixture"]
async fn scheduled_checkin_sends_one_sanitized_round_notification() {
    use crate::server::core::{auto_checkin::{self, AutoCheckin}, billing::BillingService,
        checkin_schedules, notifications};
    let fixture = Fixture::open(|request| {
        if request.path == "/notify-fixture" { Reply::json(200, json!({})) }
        else { Reply::json(403, json!({"error":"synthetic-checkin-private-upstream"})) }
    }).await;
    fixture.store.plugin_upsert_account("user-wasm-second-local", PROVIDER, "synthetic-checkin-private-name",
        &json!({"uid":"second-local", "accessToken":"synthetic-checkin-private-token", "edition":"intl", "platform":"workbuddy-ai", "endpoint":"https://www.workbuddy.ai", "prefixPath":"/plugin"}),
        &json!({"uid":"second-local", "name":"synthetic-checkin-private-name"}), false).unwrap();
    let target = super::test_support::transport_url("https://www.workbuddy.ai/notify-fixture");
    assert!(target.starts_with("http://127.0.0.1:"));
    notifications::save(json!({"enabled":true,"events":{"checkinFailure":true},"channels":{"webhook":{"enabled":true,"url":target}}}).as_object().unwrap()).unwrap();
    auto_checkin::write_state(json!({"enabled":true}));
    checkin_schedules::upsert(&json!({"id":"one-round", "time":"00:00", "timeEnd":"00:00", "retryTime":"", "retryGapMinutes":0, "providers":[PROVIDER], "enabled":true})).unwrap();
    let checkin = AutoCheckin::new(fixture.store.clone(), BillingService::new(AuthService::new(fixture.store.clone())));
    checkin.tick().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let initial_count = fixture.http.requests.lock().unwrap().iter().filter(|request| request.path == "/notify-fixture").count();
    assert_eq!(initial_count, 2, "each due account completes one independent scheduled attempt");
    checkin.tick().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let delivered = fixture.http.requests.lock().unwrap().iter().filter(|request| request.path == "/notify-fixture").map(|request| request.body.clone()).collect::<Vec<_>>();
    assert_eq!(delivered.len(), initial_count, "repeating the scheduler tick must not repeat an account attempt or its notification");
    for delivery in delivered {
        assert_eq!(delivery["event"], "checkin_failure");
        assert_eq!(delivery["data"]["failedCount"], 1);
        assert!(!delivery.to_string().contains("synthetic-checkin-private"));
    }
    fixture.close().await;
}

impl Fixture {
    async fn open(handler: impl Fn(&RecordedRequest) -> Reply + Send + Sync + 'static) -> Self {
        let http = LocalHttp::open(move |request| {
            if request.path == "/v3/config" {
                return Reply::json(200, json!({"data":{"models":[
                    {"id":"deepseek-v4.1-flash", "tags":["chat"], "maxOutputTokens":32768},
                    {"id":IMAGE, "tags":["text-to-image", "image-to-image"]}
                ]}}));
            }
            handler(request)
        }).await;
        let (_, store) = isolated_store();
        let package = std::env::var_os("AGENT2API_TEST_WORKBUDDY_INTL_ZIP").map(PathBuf::from)
            .expect("supply the original signed WorkBuddy Intl package");
        let installed = install::install_zip(&std::fs::read(package).unwrap()).unwrap();
        assert_eq!(installed.id, "agent2api-wasm-workbuddy-intl");
        assert!(installed.signed, "the actual production signature verifier must accept the guest");
        install::set_pack_enabled(&installed.id, true).unwrap();
        install::set_provider_enabled(&installed.id, PROVIDER, true).unwrap();
        let host = bootstrap::start(store.clone()).await.expect("start the actual installed guest");
        let adapter = registry::acquire(PROVIDER).await.unwrap().unwrap();
        assert!(!adapter.is_stateful(), "statefulness is independent of owning the response transport");
        let account = store.plugin_upsert_account("user-wasm-forward-user", PROVIDER, "WASM forwarding fixture",
            &json!({"uid":"wasm-forward-user", "accessToken":"fixture-workbuddy-access",
                "endpoint":"https://www.workbuddy.ai", "edition":"intl", "platform":"workbuddy-ai",
                "prefixPath":"/plugin"}),
            &json!({"uid":"wasm-forward-user", "name":"WASM forwarding fixture"}), false).unwrap();
        let account = account["id"].as_str().unwrap().to_string();
        let key = api_keys::add("wasm-forwarding-fixture", None, vec![PROVIDER.into()], Vec::new()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {}", key.key).parse().unwrap());
        headers.insert("x-session-id", "wasm-forwarding-fixture-session".parse().unwrap());
        let refreshed = adapter.refresh_models(&store, &account, true).await;
        assert!(refreshed.refreshed,
            "refresh the guest's real account catalog before choosing a routing member");
        assert_eq!(refreshed.count, 2, "the official guest must recognize both fixture models");
        Self {store, host, adapter:Some(adapter), account, headers, http}
    }

    fn request(&self, mut body: Value, image: bool, stream: bool,
        telemetry: &Arc<RequestTelemetry>) -> ForwardRequest {
        let upstream_model = body["model"].as_str().unwrap().to_string();
        let group_id = if image && body.get("images").is_some() {"wasm-fixture-image-edit"}
            else if image {"wasm-fixture-image"}
            else if stream {"wasm-fixture-chat-stream"} else {"wasm-fixture-chat"};
        let group: config::RoutingGroup = serde_json::from_value(json!({
            "id":group_id, "name":group_id, "model":group_id,
            "kind":if image {"image"} else {"chat"}, "strategy":"order", "sticky":"off",
            "members":[{"id":"guest-source", "provider":PROVIDER, "model":upstream_model,
                "included":true, "accounts":[self.account]}]
        })).unwrap();
        config::routing_groups::save(group_id, Some(group.clone()), &config::routing_groups::revision(None)).unwrap();
        body["model"] = group_id.into();
        let key = api_keys::list().into_iter().find(|entry| entry.name == "wasm-forwarding-fixture").unwrap();
        let accounts = self.store.routing_snapshot().accounts.iter()
            .map(|account| account.as_ref().clone()).collect::<Vec<_>>();
        let projection = crate::server::core::routing_groups::project(&group, &accounts,
            &crate::server::core::routing_groups::RequestNeeds::from_body(&body), Some(&KeyScope::from_entry(&key)));
        assert_eq!(projection.accounts.len(), 1,
            "the real account must pass the normal routing projection: {:?}", projection.blocked);
        ForwardRequest {body, stream, dedupe_key:String::new(), client_headers:self.headers.clone(),
            telemetry:telemetry.clone(), allowed_providers:Some(KeyScope::from_entry(&key)),
            pinned_account:None, ignore_model_gate:false, proxy_override:None}
    }

    fn service(&self) -> UpstreamService {
        UpstreamService::new(self.store.clone(), AuthService::new(self.store.clone()))
    }

    fn requests(&self, path: &str) -> Vec<RecordedRequest> {
        self.http.requests.lock().unwrap().iter().filter(|request| request.path == path).cloned().collect()
    }

    async fn close(mut self) {
        self.adapter.take();
        plugin_host::shutdown_all().await;
        assert!(self.host.local_shutdown_complete(), "finished requests release their real guest ownership");
        registry::remove(PROVIDER);
    }
}

fn chat_reply() -> Reply {
    let first = json!({"id":"chatcmpl-wasm-fixture", "object":"chat.completion.chunk",
        "model":"deepseek-v4.1-flash", "choices":[{"index":0, "delta":{
            "role":"assistant", "content":"complete signed guest answer", "reasoning_content":"fixture thought",
            "tool_calls":[{"index":0,"id":"call-fixture","type":"function",
                "function":{"name":"read_value","arguments":"{\"value\":1}"}}]}, "finish_reason":null}]});
    let last = json!({"id":"chatcmpl-wasm-fixture", "object":"chat.completion.chunk",
        "model":"deepseek-v4.1-flash", "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":7,"completion_tokens":11,"total_tokens":18}});
    Reply::sse(format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a signed WorkBuddy Intl ZIP and a separate process with an empty temporary home"]
async fn official_wasm_stateless_chat_uses_response_transport() {
    let fixture = Fixture::open(|request| match request.path.as_str() {
        CHAT => chat_reply(), _ => Reply::json(404, json!({"error":"unexpected upstream request"})),
    }).await;
    let service = fixture.service();
    for stream in [false, true] {
        let telemetry = Arc::new(RequestTelemetry::with_id());
        let request = fixture.request(json!({"model":"deepseek-v4.1-flash",
            "messages":[{"role":"user","content":"original forwarding prompt"}]}), false, stream, &telemetry);
        let outcome = service.forward(request).await.expect("stateless WASM must call conversation, not the unsupported chat plan");
        match outcome {
            ForwardOutcome::Completion {body} => {
                assert!(!stream);
                assert_eq!(body["choices"][0]["message"]["content"], "complete signed guest answer");
                assert_eq!(body["choices"][0]["message"]["reasoning_content"], "fixture thought");
                assert_eq!(body["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "read_value");
                assert_eq!(body["usage"]["total_tokens"], 18);
                assert_eq!(body["model"], "wasm-fixture-chat");
            }
            ForwardOutcome::Stream {status, stream:mut output} => {
                assert!(stream);
                assert_eq!(status, 200);
                let mut bytes = Vec::new();
                while let Some(chunk) = output.next().await {bytes.extend_from_slice(&chunk.unwrap());}
                let text = String::from_utf8(bytes).unwrap();
                assert!(text.contains("complete signed guest answer") && text.contains("fixture thought"));
                assert!(text.contains("read_value") && text.contains("wasm-fixture-chat"));
                assert!(text.contains("[DONE]"), "the full original guest response ends explicitly");
            }
            _ => panic!("expected the guest's normalized Chat output"),
        }
    }
    let requests = fixture.requests(CHAT);
    assert_eq!(requests.len(), 2, "one upstream request per original client request");
    for request in requests {
        assert_eq!(request.body["model"], "deepseek-v4.1-flash");
        assert!(request.body["messages"].to_string().contains("original forwarding prompt"));
        assert_eq!(request.headers["authorization"], "Bearer fixture-workbuddy-access");
    }
    drop(service);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a signed WorkBuddy Intl ZIP and a separate process with an empty temporary home"]
async fn official_wasm_images_use_normalized_guest_results() {
    let fixture = Fixture::open(|request| match request.path.as_str() {
        GENERATE | EDIT => Reply::json(200, json!({"code":0,"data":{"created":123,"data":[{"b64_json":PNG,
            "revised_prompt":"actual guest image"}],"usage":{"total_tokens":9}}})),
        _ => Reply::json(404, json!({"error":"unexpected upstream request"})),
    }).await;
    let service = fixture.service();
    for editing in [false, true] {
        let mut body = json!({"model":IMAGE,"prompt":"original image prompt"});
        if editing {body["images"] = json!([{"image_url":format!("data:image/png;base64,{PNG}")}]);}
        let telemetry = Arc::new(RequestTelemetry::with_id());
        let request = fixture.request(body, true, false, &telemetry);
        let outcome = if editing {service.edit_images(request).await} else {service.generate_images(request).await}
            .expect("WASM returns image data, not an upstream request plan");
        let ForwardOutcome::Completion {body} = outcome else {panic!("expected standard image result")};
        assert_eq!(body["created"], 123);
        assert_eq!(body["data"][0]["b64_json"], PNG);
        assert_eq!(body["data"][0]["revised_prompt"], "actual guest image");
        assert!(body["data"][0].get("resource").is_none(), "private resource handles are materialized by the actual host");
        assert_eq!(body["usage"]["total_tokens"], 9);
        assert_eq!(telemetry.snapshot().total_tokens, 9);
    }
    assert_eq!(fixture.requests(GENERATE).len(), 1);
    let edits = fixture.requests(EDIT);
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].body["image"][0], format!("data:image/png;base64,{PNG}"));
    drop(service);
    fixture.close().await;
}

#[derive(serde::Deserialize)]
struct PackageFixture {
    id: String,
    version: String,
    provider: String,
    zip: PathBuf,
    sha256: String,
    stateful: bool,
    generation: bool,
    editing: bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires all ten original signed packages and a separate process with an empty temporary home"]
async fn official_wasm_packages_use_their_response_interfaces() {
    let (_, store) = isolated_store();
    let file = std::env::var_os("AGENT2API_TEST_WASM_PACKAGES").map(PathBuf::from)
        .expect("supply the manifest for all ten original signed production packages");
    let packages: Vec<PackageFixture> = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    assert_eq!(packages.len(), 10);
    let ids = packages.iter().map(|package| &package.provider).collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), packages.len());
    for package in &packages {
        let bytes = std::fs::read(&package.zip).unwrap();
        assert_eq!(install::sha256_hex(&bytes), package.sha256);
        let installed = install::install_zip(&bytes).unwrap();
        assert!(installed.signed, "every package must pass the actual signature verifier");
        assert_eq!(installed.id, package.id);
        assert_eq!(installed.version, package.version);
        install::set_pack_enabled(&installed.id, true).unwrap();
        install::set_provider_enabled(&installed.id, &package.provider, true).unwrap();
    }
    bootstrap::start(store).await.expect("load all installed signed guests through the actual host");
    let mut hosts = Vec::new();
    for package in &packages {
        let adapter = registry::acquire(&package.provider).await.unwrap().unwrap();
        assert_eq!(adapter.is_stateful(), package.stateful, "keep the guest's actual state semantics");
        assert!(adapter.forwards_response(), "{} uses conversation rather than a chat request plan", package.provider);
        assert!(adapter.forwards_images(), "WASM image output is a completed result");
        assert_eq!(adapter.supports_image_generation(), package.generation);
        assert_eq!(adapter.supports_image_editing(), package.editing);
        let wrapper = crate::server::core::providers::adapter::adapter_by_id(&package.provider).unwrap();
        assert_eq!(wrapper.is_stateful(), package.stateful);
        assert!(wrapper.forwards_response() && wrapper.forwards_images(), "dynamic delegation must preserve transport selection");
        let host = super::super::host_for_provider(&package.provider).unwrap();
        assert!(host.ready());
        assert_eq!(super::super::provider_pack(&package.provider).as_deref(), Some(package.id.as_str()));
        hosts.push(host);
        eprintln!("validated signed host: {} {} stateful={} images={}/{}", package.provider,
            package.version, package.stateful, package.generation, package.editing);
    }
    plugin_host::shutdown_all().await;
    assert!(hosts.iter().all(|host| host.local_shutdown_complete()));
    for package in packages { registry::remove(&package.provider); }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a signed WorkBuddy Intl ZIP and a separate process with an empty temporary home"]
async fn official_wasm_image_failure_does_not_resubmit_generation() {
    let fixture = Fixture::open(|request| match request.path.as_str() {
        GENERATE => Reply::json(200, json!({"code":0,"data":{"data":[]}})),
        _ => Reply::json(404, json!({"error":"unexpected upstream request"})),
    }).await;
    let service = fixture.service();
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let request = fixture.request(json!({"model":IMAGE,"prompt":"generate once"}), true, false, &telemetry);
    let error = match service.generate_images(request).await {Err(error)=>error, Ok(_)=>panic!("empty image output must fail")};
    assert_eq!(error.status_code, 502);
    assert_eq!(error.code.as_deref(), Some("image_output_uncertain"));
    assert!(error.retry_forbidden, "an unconfirmed generation must not spend credits again");
    assert_eq!(fixture.requests(GENERATE).len(), 1);
    drop(service);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires a signed WorkBuddy Intl ZIP and a separate process with an empty temporary home"]
async fn official_wasm_image_cancellation_stops_the_original_invocation() {
    let submitted = Arc::new(tokio::sync::Notify::new());
    let notify = submitted.clone();
    let fixture = Fixture::open(move |request| match request.path.as_str() {
        GENERATE => {
            notify.notify_one();
            let mut reply = Reply::json(200, json!({"code":0,"data":{"created":123,
                "data":[{"b64_json":PNG}]}}));
            reply.delay = Duration::from_secs(30);
            reply
        },
        _ => Reply::json(404, json!({"error":"unexpected upstream request"})),
    }).await;
    let service = fixture.service();
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let cancel = crate::server::core::upstream::cancellation::register("wasm-image-cancel-fixture").unwrap();
    telemetry.set_cancel_token(cancel.clone());
    let request = fixture.request(json!({"model":IMAGE,"prompt":"cancel this one generation"}), true, false, &telemetry);
    let request = tokio::spawn(async move { service.generate_images(request).await });
    tokio::time::timeout(Duration::from_secs(10), submitted.notified()).await
        .expect("the actual guest must have submitted its original image request before cancellation");
    cancel.cancel();
    let error = match tokio::time::timeout(Duration::from_secs(2), request).await
        .expect("cancellation must end the actual invocation promptly").unwrap() {
        Err(error) => error,
        Ok(_) => panic!("a cancelled image request must not publish output"),
    };
    assert_eq!(i64::from(error.status_code), crate::server::core::upstream::cancellation::MANUAL_TERMINATED_STATUS);
    assert_eq!(fixture.requests(GENERATE).len(), 1, "cancellation must not submit a second generation");
    crate::server::core::upstream::cancellation::unregister("wasm-image-cancel-fixture");
    fixture.close().await;
}
