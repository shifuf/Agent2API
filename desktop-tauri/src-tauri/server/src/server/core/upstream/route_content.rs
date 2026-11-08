//! Hold normalized protocol output until content commits the selected route.
use std::{pin::Pin, sync::Arc, task::{Context, Poll}, time::{Duration, Instant}};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::Value;
use crate::server::{errors::GatewayError, logging};
use super::{ForwardOutcome, InFlightGuard, usage::RequestTelemetry};

pub(super) fn has_alternative(telemetry: &RequestTelemetry, excluded: &[String]) -> bool {
    let Some(route) = telemetry.route_decision() else { return false; };
    let picked = route.get("pickedCandidate").and_then(Value::as_str).unwrap_or("");
    route.get("ordered").and_then(Value::as_array).is_some_and(|entries| entries.iter().any(|entry| {
        entry.get("candidateId").and_then(Value::as_str).is_some_and(|id| id != picked && !excluded.iter().any(|excluded| excluded == id))
    }))
}

/// The timeout begins when the selected candidate starts sending, including its
/// HTTP headers wait. Changing candidates starts that candidate's own deadline.
pub(super) async fn during_send<F>(future: F, routing: &super::route_context::RequestRouting,
    telemetry: &RequestTelemetry, patience_until: Option<Instant>) -> Result<ForwardOutcome, GatewayError>
where F: std::future::Future<Output = Result<ForwardOutcome, GatewayError>> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return result,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if patience_until.is_some_and(|deadline| Instant::now() >= deadline) {
                    return Err(GatewayError::with_status(503, "路由繁忙等待期限已到").with_code("route_patience_exhausted"));
                }
                if routing.settings.sticky == crate::server::config::StickyMode::Strict || !has_alternative(telemetry, &routing.excluded) { continue; }
                let snapshot = telemetry.snapshot();
                let Some(attempt) = snapshot.attempts_detail.last() else { continue; };
                let Some(started) = attempt.started_at else { continue; };
                let candidate = routing.group_projection.accounts.iter().find(|account| crate::server::core::routing_groups::attempt_key(account) == attempt.candidate_id);
                let seconds = candidate.and_then(|account| account.get("routingFirstToken")).and_then(Value::as_u64).unwrap_or(0);
                if seconds > 0 && logging::now_ms().saturating_sub(started) >= seconds.saturating_mul(1000) as i64 {
                    return Err(GatewayError::with_status(504, "候选在首内容等待期限内没有响应").with_code("route_first_content_timeout"));
                }
            }
        }
    }
}

pub(super) type ByteStream = Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin>;

pub(super) fn transient(error: &GatewayError) -> bool {
    use crate::server::core::providers::adapter::UpstreamErrorClass;
    !error.retry_forbidden && matches!(error.status_code, 408 | 429 | 500 | 502 | 503 | 504)
        && !matches!(error.conversation_class, Some(UpstreamErrorClass::Fatal {..} | UpstreamErrorClass::TokenExpired {..} | UpstreamErrorClass::ContentBlocked {..}))
        && !matches!(error.code.as_deref(), Some("route_empty" | "model_not_found" | "account_scope_mismatch" | "route_strict_failed" | "route_strict_unavailable" | "route_patience_exhausted"))
}

pub(super) fn retry_delay(error: &GatewayError, round: usize, remaining: Duration) -> Duration {
    let backoff = (500u64 << round.min(5)).min(10_000);
    Duration::from_millis(error.retry_after_secs.unwrap_or(0).saturating_mul(1000).max(backoff)).min(remaining)
}

#[derive(Default)]
struct ContentProbe { line: Vec<u8> }
enum Frame { None, Content, Done, Error(String) }
impl ContentProbe {
    fn push(&mut self, bytes: &[u8]) -> Frame {
        let mut found = Frame::None;
        for &byte in bytes {
            if byte != b'\n' {
                if self.line.len() < 1_048_576 { self.line.push(byte); }
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let Ok(line) = std::str::from_utf8(&line) else { continue; };
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue; };
            if data == "[DONE]" { if !matches!(found, Frame::Content) { found = Frame::Done; } continue; }
            let Ok(value) = serde_json::from_str::<Value>(data) else { continue; };
            if let Some(error) = value.get("error") {
                return Frame::Error(error.get("message").and_then(Value::as_str).unwrap_or("上游在首内容前返回错误").into());
            }
            let meaningful = value.get("choices").and_then(Value::as_array).is_some_and(|choices| choices.iter().any(|choice| {
                let delta = choice.get("delta").or_else(|| choice.get("message")).unwrap_or(choice);
                ["content", "reasoning_content", "reasoning"].iter().any(|key| delta.get(*key).and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty()))
                    || delta.get("tool_calls").and_then(Value::as_array).is_some_and(|calls| calls.iter().any(|call|
                        call.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                        || call.get("function").is_some_and(|function| ["name", "arguments"].iter().any(|key| function.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty())))))
                    || delta.get("function_call").is_some_and(|function| ["name", "arguments"].iter().any(|key| function.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty())))
            }));
            if meaningful { found = Frame::Content; }
        }
        found
    }
}

pub(super) async fn hold(mut stream: ByteStream, deadline: Option<Instant>) -> Result<ByteStream, GatewayError> {
    let mut probe = ContentProbe::default();
    let mut prefix = Vec::new();
    let mut size = 0;
    loop {
        let next = if let Some(deadline) = deadline {
            tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), stream.next()).await
                .map_err(|_| GatewayError::with_status(504, "候选在首内容等待期限内没有返回文本、推理或工具调用").with_code("route_first_content_timeout"))?
        } else { stream.next().await };
        let Some(next) = next else { return Err(GatewayError::with_status(502, "上游在返回有效内容前关闭了响应").with_code("route_empty_response")); };
        let bytes = next.map_err(|error| GatewayError::with_status(502, error.to_string()))?;
        size += bytes.len();
        let frame = probe.push(&bytes);
        prefix.push(Ok(bytes));
        match frame {
            Frame::Content => return Ok(Box::new(futures::stream::iter(prefix).chain(stream))),
            Frame::Error(message) => return Err(GatewayError::with_status(502, message)),
            Frame::Done => return Err(GatewayError::with_status(502, "上游响应结束但没有文本、推理或工具调用").with_code("route_empty_response")),
            Frame::None => {}
        }
        if size > 1_048_576 { return Err(GatewayError::with_status(502, "上游首内容前的控制帧超过 1 MiB")); }
    }
}

pub(super) struct ObservedStream {
    inner: ByteStream,
    telemetry: Arc<RequestTelemetry>,
    started: Instant,
    first: Option<f64>,
    probe: ContentProbe,
    finished: bool,
    _slot: Option<InFlightGuard>,
}
impl ObservedStream {
    pub(super) fn new(inner: ByteStream, telemetry: Arc<RequestTelemetry>, started: Instant, first: Option<f64>, slot: Option<InFlightGuard>) -> Self {
        Self { inner, telemetry, started, first, probe: ContentProbe::default(), finished: false, _slot: slot }
    }
    fn finish(&mut self) {
        if self.finished { return; } self.finished = true;
        let snapshot = self.telemetry.snapshot();
        if self.first.is_some() && snapshot.error.is_none() {
            crate::server::core::routing_observations::record(&snapshot.account_id, &snapshot.upstream_model,
                logging::now_ms(), self.first, self.started.elapsed().as_secs_f64() * 1000.0,
                snapshot.total_tokens, snapshot.completion_tokens, snapshot.cache_read_tokens > 0);
            if let Some(model) = snapshot.route.as_ref().and_then(|route| route.get("scope")).and_then(Value::as_str)
                .filter(|model| *model != snapshot.upstream_model && !model.is_empty()) {
                crate::server::core::routing_observations::record(&snapshot.account_id, model, logging::now_ms(), self.first,
                    self.started.elapsed().as_secs_f64() * 1000.0, 0, 0, snapshot.cache_read_tokens > 0);
            }
        }
    }
}
impl Stream for ObservedStream {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                if self.first.is_none() && matches!(self.probe.push(&bytes), Frame::Content) { self.first = Some(self.started.elapsed().as_secs_f64() * 1000.0); }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(None) => { self.finish(); Poll::Ready(None) }
            result => result,
        }
    }
}

pub(super) async fn deliver(outcome: ForwardOutcome, telemetry: Arc<RequestTelemetry>, started: Instant, first: Option<f64>, slot: Option<InFlightGuard>, stream: bool) -> Result<ForwardOutcome, GatewayError> {
    match outcome {
        ForwardOutcome::Stream { status, stream: inner } => {
            let observed = ObservedStream::new(inner, telemetry.clone(), started, first, slot);
            if stream { Ok(ForwardOutcome::Stream { status, stream: Box::new(observed) }) }
            else {
                let completion = super::aggregate::aggregate_frame_stream(Box::pin(observed), telemetry, Default::default()).await?;
                Ok(ForwardOutcome::Completion { body: completion.body })
            }
        }
        completion => {
            let snapshot = telemetry.snapshot();
            crate::server::core::routing_observations::record(&snapshot.account_id, &snapshot.upstream_model,
                logging::now_ms(), first, started.elapsed().as_secs_f64() * 1000.0,
                snapshot.total_tokens, if first.is_some() { snapshot.completion_tokens } else { 0 }, snapshot.cache_read_tokens > 0);
            Ok(completion)
        },
    }
}

pub(super) fn timeout_at(started: Instant, seconds: u64) -> Option<Instant> {
    (seconds > 0).then(|| started + Duration::from_secs(seconds.min(3600)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_frames_do_not_commit_and_partial_tool_frames_do() {
        let mut probe = ContentProbe::default();
        assert!(matches!(probe.push(b": keepalive\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n"), Frame::None));
        assert!(matches!(probe.push(b"data: {\"choices\":[{\"delta\":{\"tool_calls\":["), Frame::None));
        assert!(matches!(probe.push(b"{\"index\":0,\"function\":{\"name\":\"read\"}}]}}]}\n"), Frame::Content));
    }
    #[tokio::test]
    async fn content_timeout_cancels_the_old_stream_without_emitting_its_prefix() {
        let stream = futures::stream::iter([Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"))]).chain(futures::stream::pending());
        let result = hold(Box::new(stream), Some(Instant::now() + Duration::from_millis(10))).await;
        assert!(result.is_err_and(|error| error.code.as_deref() == Some("route_first_content_timeout")));
    }

    #[test]
    fn patience_obeys_retry_after_and_does_not_retry_permission_or_fatal_failures() {
        let mut busy = GatewayError::with_status(429,"busy"); busy.retry_after_secs = Some(20);
        assert_eq!(retry_delay(&busy,1,Duration::from_secs(60)),Duration::from_secs(20));
        assert_eq!(retry_delay(&busy,1,Duration::from_secs(3)),Duration::from_secs(3));
        assert!(transient(&busy));
        assert!(!transient(&GatewayError::with_status(403,"denied")));
        let mut fatal = GatewayError::with_status(503,"fatal");
        fatal.conversation_class = Some(crate::server::core::providers::adapter::UpstreamErrorClass::Fatal {status:503,message:"fatal".into(),upstream_code:None});
        assert!(!transient(&fatal));
        let mut stopped = GatewayError::with_status(503, "adapter stopped");
        stopped.retry_forbidden = true;
        assert!(!transient(&stopped));
    }
}
