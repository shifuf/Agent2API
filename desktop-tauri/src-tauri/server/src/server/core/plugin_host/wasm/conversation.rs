//! 原 RPC 调用的唯一租约、执行结束信号与 CatPaw 材料；来源均在 guest 执行前封存。
use std::sync::{atomic::Ordering, Arc, Mutex, Weak};
use std::time::Duration;

use agent2api_provider_protocol as proto;
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

mod catpaw_material;
mod source_ref;
pub(super) use catpaw_material::CatPawMaterial;
pub(super) use source_ref::{SourceGate, SourceRef};

use super::context::Shared;
use super::super::Host;
use crate::server::core::{proxies::ResolvedProxy, upstream::{
    cancellation::CancelToken,
    replay_guard::{CallLease, PreparationRef, ReplayError}, usage::RequestTelemetry,
}};
use crate::server::errors::GatewayError;

#[derive(Clone, Copy)]
enum ExecutionEnd { Returned, Interrupted }
#[derive(Default)]
struct EndState {
    consumer: bool,
    execution: Option<ExecutionEnd>,
    guard_issued: bool,
    source_issued: bool,
    http_submission: bool,
}
struct Signal { state: Mutex<EndState>, ended: CancellationToken }
impl Signal {
    fn new() -> Self { Self { state: Mutex::new(Default::default()), ended: CancellationToken::new() } }
    fn execution_ended(&self, end: ExecutionEnd) {
        self.state.lock().unwrap_or_else(|error| error.into_inner()).execution.get_or_insert(end);
        self.ended.cancel();
    }
}

/// 原上游选定的 Option<ResolvedProxy>，内层 None 表示原直连，外层 None 表示已消费。
struct ConversationEgress { selected: Mutex<Option<Option<ResolvedProxy>>> }
impl ConversationEgress {
    fn take(&self) -> Result<Option<ResolvedProxy>, proto::WireError> {
        self.selected.try_lock().map_err(|_| unavailable())?.take().ok_or_else(unavailable)
    }
}

pub(in crate::server::core::plugin_host) struct ConversationOwner {
    lease: Option<CallLease>,
    signal: Arc<Signal>,
    output: Option<Arc<super::catpaw_turn::output::OutputSlot>>,
}
impl ConversationOwner {
    pub(in crate::server::core::plugin_host) fn new(
        host: &Arc<Host>, provider: &str, account: &str, telemetry: &Arc<RequestTelemetry>,
        selected: Option<ResolvedProxy>, params: &Value, timeout: Duration,
    ) -> Result<(Self, ConversationCall), GatewayError> {
        let lease = telemetry.replay_guard().open_call().map_err(|error| match error {
            ReplayError::Blocked => crate::server::core::upstream::replay_guard::blocked_error(),
            _ => GatewayError::with_status(409, "原始请求已有活动调用或来源已撤销").with_code("request_call_unavailable"),
        })?;
        let signal = Arc::new(Signal::new());
        let key_source = crate::server::config::model_key_source::current();
        if provider == "catpaw" && key_source.as_ref().is_none_or(|source| !source.is_current() || !source.allows_provider(provider)) {
            return Err(GatewayError::with_status(403, "CatPaw 调用缺少当前原始模型 Key 来源").with_code("model_key_source_revoked"));
        }
        let output = if provider == "catpaw" {
            let output = super::catpaw_turn::output::OutputSlot::new();
            telemetry.install_catpaw_output(output.clone()).map_err(|_| output_unavailable())?;
            Some(output)
        } else { None };
        let memory = if provider == "catpaw" {
            let bytes = super::catpaw_turn::budget::value_bytes(&params["body"])
                .map_err(|error| GatewayError::with_status(413, error.message))?
                .checked_mul(2).and_then(|bytes| bytes.checked_add(2 * 1024 * 1024)).ok_or_else(output_unavailable)?;
            Some(Arc::new(super::catpaw_turn::budget::Allocation::new(bytes)
                .map_err(|error| GatewayError::with_status(503, error.message))?))
        } else { None };
        let call = ConversationCall {
            preparation: lease.preparation(), signal: signal.clone(), key_source, output: output.clone(),
            egress: Arc::new(ConversationEgress { selected: Mutex::new(Some(selected)) }),
            provider: provider.to_string(), account: account.to_string(), request: String::new(),
            host: Arc::downgrade(host), shared: Weak::new(), generation: 0, rpc: 0,
            body: params["body"].clone(), session: params["session"].as_str().unwrap_or("").to_string(),
            client_stream: params["client_stream"].as_bool().ok_or_else(output_unavailable)?,
            deadline: Instant::now() + timeout,
            call_cancel: telemetry.cancel_token(),
            capture: telemetry.capture(), memory,
        };
        Ok((Self { lease: Some(lease), signal, output }, call))
    }
    pub(in crate::server::core::plugin_host) fn select_output(&self) -> Result<(), GatewayError> {
        let state = self.signal.state.try_lock().map_err(|_| output_unavailable())?;
        if state.consumer { return Err(output_unavailable()); }
        self.lease.as_ref().ok_or_else(output_unavailable)?.preparation().freeze().map_err(|_| output_unavailable())?;
        if let Some(output) = &self.output { output.select().map_err(|_| output_unavailable())?; }
        Ok(())
    }
    pub(in crate::server::core::plugin_host) fn close(&mut self) {
        if let Some(output) = &self.output { output.close_attempt(); }
        let mut state = self.signal.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(lease) = self.lease.take() { lease.close(); }
        state.consumer = true;
        drop(state);
        self.signal.ended.cancel();
    }
}
impl Drop for ConversationOwner { fn drop(&mut self) { self.close(); } }

pub(in crate::server::core::plugin_host) struct ConversationCall {
    preparation: PreparationRef,
    signal: Arc<Signal>,
    key_source: Option<Arc<crate::server::config::model_key_source::Source>>,
    output: Option<Arc<super::catpaw_turn::output::OutputSlot>>,
    egress: Arc<ConversationEgress>,
    provider: String,
    account: String,
    request: String,
    host: Weak<Host>,
    shared: Weak<Shared>,
    generation: u64,
    rpc: i64,
    body: Value,
    session: String,
    client_stream: bool,
    deadline: Instant,
    call_cancel: Option<Arc<CancelToken>>,
    capture: Option<Arc<crate::server::core::debug_traffic::TrafficCapture>>,
    memory: Option<Arc<super::catpaw_turn::budget::Allocation>>,
}
impl ConversationCall {
    pub(super) fn deadline(&self) -> Instant { self.deadline }
    pub(super) fn call_cancel(&self) -> Option<Arc<CancelToken>> { self.call_cancel.clone() }
    pub(super) fn execution_guard(&self) -> Result<ExecutionGuard, proto::WireError> {
        let mut state = self.signal.state.try_lock().map_err(|_| unavailable())?;
        if state.guard_issued || state.consumer || state.execution.is_some() { return Err(unavailable()); }
        state.guard_issued = true;
        Ok(ExecutionGuard { signal: self.signal.clone(), finished: false })
    }
    pub(super) fn bind(mut self, host: &Arc<Host>, shared: &Arc<Shared>, rpc: i64) -> Result<Self, proto::WireError> {
        if self.rpc != 0 || rpc <= 0 || !self.host.upgrade().is_some_and(|original| Arc::ptr_eq(&original, host))
            || shared.options.provider != self.provider { return Err(unavailable()); }
        let state = self.signal.state.try_lock().map_err(|_| unavailable())?;
        if !state.guard_issued || state.consumer || state.execution.is_some() { return Err(unavailable()); }
        let _lifecycle = host.lifecycle.try_lock().map_err(|_| unavailable())?;
        if !host.ready() || shared.cancel.is_cancelled() || !host.embedded.runtime.try_read().is_ok_and(|runtime|
            runtime.as_ref().is_some_and(|runtime| Arc::ptr_eq(&runtime.shared, shared))) { return Err(unavailable()); }
        self.shared = Arc::downgrade(shared);
        self.generation = host.generation.load(Ordering::Acquire);
        self.rpc = rpc;
        drop(_lifecycle);
        drop(state);
        Ok(self)
    }
    pub(super) fn validate_params(&self, shared: &Arc<Shared>, params: &Value) -> Result<(), proto::WireError> {
        if params["provider"].as_str() != Some(&self.provider) || params["account"].as_str() != Some(&self.account)
            || params["body"] != self.body || params["session"].as_str() != Some(&self.session)
            || params["client_stream"].as_bool() != Some(self.client_stream) { return Err(unavailable()); }
        self.validate_context(shared, &self.account)
    }
    pub(super) fn validate_context(&self, shared: &Arc<Shared>, account: &str) -> Result<(), proto::WireError> {
        let state = self.signal.state.try_lock().map_err(|_| unavailable())?;
        if !state.guard_issued || state.consumer || state.execution.is_some() || account != self.account
            || !self.shared.upgrade().is_some_and(|original| Arc::ptr_eq(&original, shared)) { return Err(unavailable()); }
        self.with_current(|| Ok(())).map_err(|_| unavailable())
    }
    fn with_current<R>(&self, action: impl FnOnce() -> Result<R, ReplayError>) -> Result<R, ReplayError> {
        let host = self.host.upgrade().ok_or(ReplayError::Revoked)?;
        let shared = self.shared.upgrade().ok_or(ReplayError::Revoked)?;
        if self.rpc <= 0 || self.generation == 0 || !bounded(&self.request, 512)
            || super::super::registry::is_switching(&self.provider) || !super::super::serves_provider(&self.provider)
            || !super::super::host_for_provider(&self.provider).is_some_and(|current| Arc::ptr_eq(&current, &host)) { return Err(ReplayError::Revoked); }
        let _lifecycle = host.lifecycle.try_lock().map_err(|_| ReplayError::Unavailable)?;
        let runtime = host.embedded.runtime.try_read().map_err(|_| ReplayError::Unavailable)?;
        if !host.ready() || host.activity.retired() || host.generation.load(Ordering::Acquire) != self.generation
            || shared.cancel.is_cancelled() || self.call_cancel.as_ref().is_some_and(|token| token.is_cancelled()) || self.deadline <= Instant::now()
            || shared.options.provider != self.provider
            || !runtime.as_ref().is_some_and(|runtime| Arc::ptr_eq(&runtime.shared, &shared)) { return Err(ReplayError::Revoked); }
        action()
    }
    pub(super) fn freeze_http(&self) -> Result<HttpSubmissionGuard, proto::WireError> {
        let mut state = self.signal.state.try_lock().map_err(|_| unavailable())?;
        if !state.guard_issued || state.source_issued || state.consumer || state.execution.is_some() { return Err(unavailable()); }
        self.with_current(|| self.preparation.freeze()).map_err(|_| unavailable())?;
        state.http_submission = true;
        Ok(HttpSubmissionGuard { preparation: self.preparation.clone() })
    }
}

/// 在实际原 HTTP/WS 发送前建立，返回、取消、超时和 trap 均永久关闭新调用。
pub(super) struct HttpSubmissionGuard { preparation: PreparationRef }
impl Drop for HttpSubmissionGuard {
    fn drop(&mut self) { self.preparation.lock_permanent_replay_block(); }
}

pub(super) struct ExecutionGuard { signal: Arc<Signal>, finished: bool }
impl ExecutionGuard {
    pub(super) fn matches(&self, call: &ConversationCall) -> bool { !self.finished && Arc::ptr_eq(&self.signal, &call.signal) }
    pub(super) fn finish(&mut self, returned: bool) {
        if !self.finished { self.signal.execution_ended(if returned { ExecutionEnd::Returned } else { ExecutionEnd::Interrupted }); self.finished = true; }
    }
}
impl Drop for ExecutionGuard { fn drop(&mut self) { self.finish(false); } }

fn bounded(value: &str, limit: usize) -> bool { value.len() <= limit && !value.chars().any(char::is_control) }
fn unavailable() -> proto::WireError { proto::WireError::with_code("Wasm 原调用已结束或来源已切换", "request_call_revoked") }
fn output_unavailable() -> GatewayError { GatewayError::with_status(409, "CatPaw 原响应观察来源未确认").with_code("catpaw_output_unconfirmed") }
