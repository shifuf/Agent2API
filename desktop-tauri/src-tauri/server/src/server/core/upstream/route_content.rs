//! Hold normalized protocol output until content commits the selected route.
use std::{pin::Pin, sync::Arc, task::{Context, Poll}, time::{Duration, Instant}};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::Value;
use crate::server::{errors::GatewayError, logging};
use super::{ForwardOutcome, InFlightGuard, usage::RequestTelemetry, route_completion::RouteCompletion};

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
                if !routing.sticky_faults() && (routing.settings.sticky == crate::server::config::StickyMode::Strict || !has_alternative(telemetry, &routing.excluded)) { continue; }
                let Some(attempt) = telemetry.active_attempt() else { continue; };
                let started = attempt.started_at;
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
    // Fatal is the plugin protocol's catch-all for ordinary upstream failures;
    // explicit Stop decisions are carried separately by retry_forbidden.
    !error.retry_forbidden && error.routing_error.as_ref().is_none_or(|decision| decision.switches())
        && matches!(error.status_code, 408 | 429 | 500 | 502 | 503 | 504 | 524)
        && !matches!(error.conversation_class, Some(UpstreamErrorClass::TokenExpired {..} | UpstreamErrorClass::ContentBlocked {..}))
        && !matches!(error.code.as_deref(), Some("route_empty" | "model_not_found" | "account_scope_mismatch" | "route_strict_failed" | "route_strict_unavailable" | "route_patience_exhausted" | "route_cooling_down"))
}


pub(super) fn channel_fault(error: &GatewayError) -> bool {
    use crate::server::core::providers::adapter::UpstreamErrorClass;
    matches!(error.status_code, 408 | 500 | 502 | 503 | 504 | 524)
        && !matches!(error.conversation_class, Some(UpstreamErrorClass::TokenExpired {..} | UpstreamErrorClass::ContentBlocked {..} | UpstreamErrorClass::QuotaLimited {..}))
        && error.code.as_deref().map_or(true, |code| !code.starts_with("route_")
            || matches!(code, "route_first_content_timeout" | "route_empty_response"))
}

pub(super) fn retry_delay(error: &GatewayError, round: usize, remaining: Duration) -> Duration {
    let backoff = (500u64 << round.min(5)).min(10_000);
    Duration::from_millis(error.retry_after_secs.unwrap_or(0).saturating_mul(1000).max(backoff)).min(remaining)
}

#[derive(Default)]
struct ContentProbe { line: Vec<u8>, terminal: bool, error: Option<String> }
enum Frame { None, Content, Done, Error(String) }

fn native_block_has_content(block: &Value) -> bool {
    matches!(block.get("type").and_then(Value::as_str), Some("tool_use" | "server_tool_use"))
        || ["text", "thinking", "refusal", "data", "image_url"].iter().any(|key|
            block.get(*key).and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty()))
}

fn native_item_has_content(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "function_call" | "custom_tool_call" => ["name", "arguments", "input", "call_id"].iter().any(|key|
            item.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty())),
        "image_generation_call" => item.get("result").and_then(Value::as_str).is_some_and(|text| !text.is_empty()),
        _ => item.get("encrypted_content").and_then(Value::as_str).is_some_and(|text| !text.is_empty())
            || item.get("content").and_then(Value::as_array).is_some_and(|blocks| blocks.iter().any(native_block_has_content)),
    }
}

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
            if data == "[DONE]" { self.terminal = true; if !matches!(found, Frame::Content) { found = Frame::Done; } continue; }
            let Ok(value) = serde_json::from_str::<Value>(data) else { continue; };
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(kind, "message_stop" | "response.completed" | "response.incomplete") { self.terminal = true; }
            if kind == "response.failed" {
                let message = value.pointer("/response/error/message").and_then(Value::as_str).unwrap_or("上游原生响应未成功完成").to_string();
                self.error = Some(message.clone());
                return Frame::Error(message);
            }
            if let Some(error) = value.get("error").filter(|value| !value.is_null()) {
                let message = error.get("message").and_then(Value::as_str).or_else(|| error.as_str()).unwrap_or("上游流式返回错误").to_string();
                self.error = Some(message.clone());
                return Frame::Error(message);
            }
            if value.get("choices").and_then(Value::as_array).is_some_and(|choices| choices.iter().any(|choice|
                choice.get("finish_reason").and_then(Value::as_str).is_some_and(|reason| !reason.is_empty()))) { self.terminal = true; }
            let meaningful = value.get("choices").and_then(Value::as_array).is_some_and(|choices| choices.iter().any(|choice| {
                let delta = choice.get("delta").or_else(|| choice.get("message")).unwrap_or(choice);
                ["content", "reasoning_content", "reasoning"].iter().any(|key| delta.get(*key).and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty()))
                    || delta.get("tool_calls").and_then(Value::as_array).is_some_and(|calls| calls.iter().any(|call|
                        call.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                        || call.get("function").is_some_and(|function| ["name", "arguments"].iter().any(|key| function.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty())))))
                    || delta.get("function_call").is_some_and(|function| ["name", "arguments"].iter().any(|key| function.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty())))
            }));
            let native_meaningful = match kind {
                "response.output_text.delta" | "response.refusal.delta" | "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" | "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" =>
                    value.get("delta").and_then(Value::as_str).is_some_and(|text| !text.is_empty()),
                "response.output_item.added" | "response.output_item.done" => value.get("item").is_some_and(native_item_has_content),
                "response.completed" | "response.incomplete" => value.pointer("/response/output").and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(native_item_has_content)),
                "content_block_start" => value.get("content_block").is_some_and(native_block_has_content),
                "content_block_delta" => value.get("delta").is_some_and(|delta|
                    ["text", "thinking", "partial_json"].iter().any(|key| delta.get(*key).and_then(Value::as_str).is_some_and(|text| !text.is_empty()))),
                _ => false,
            };
            if meaningful || native_meaningful { found = Frame::Content; }
            else if self.terminal && !matches!(found, Frame::Content) { found = Frame::Done; }
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
        let bytes = next.map_err(|error| super::stream_errors::gateway(&error)
            .unwrap_or_else(|| GatewayError::with_status(502, error.to_string())))?;
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
    ended: bool,
    completion: Option<RouteCompletion>,
    native: Option<crate::server::core::protocol::native::WireProtocol>,
    _slot: Option<InFlightGuard>,
}
impl ObservedStream {
    pub(super) fn new(inner: ByteStream, telemetry: Arc<RequestTelemetry>, started: Instant, first: Option<f64>,
        slot: Option<InFlightGuard>, completion: Option<RouteCompletion>) -> Self {
        Self { inner, telemetry, started, first, probe: ContentProbe::default(), finished: false, ended: false, completion, native: None, _slot: slot }
    }
    fn record(&mut self, success: bool) {
        if self.finished { return; } self.finished = true;
        let snapshot = self.telemetry.snapshot();
        let success = success && snapshot.error.is_none() && !self.telemetry.is_cancelled();
        if let Some(completion) = &self.completion { completion.finish(&self.telemetry, success); }
        if self.first.is_some() && success {
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
    fn finish(&mut self) -> Option<Bytes> {
        self.ended = true;
        if !self.probe.line.is_empty() { self.probe.push(b"\n"); }
        if let Some(error) = &self.probe.error { self.telemetry.note_error(error); }
        let raw_incomplete = self.completion.as_ref().is_some_and(RouteCompletion::tracks_channel)
            && self.telemetry.upstream_stream_complete() == Some(false);
        let complete = self.probe.terminal && !raw_incomplete;
        let missing = !complete && !self.telemetry.is_cancelled() && self.telemetry.snapshot().error.is_none();
        let error_frame = if missing {
            let message = "上游响应未完整结束：缺少完成标记";
            self.telemetry.note_error(message);
            if let Some(protocol) = self.native {
                self.record(false);
                return Some(crate::server::core::protocol::native::error_frame(protocol, message, 0));
            }
            let mut frame = super::sse::sse_frame(&serde_json::json!({"error":{"message":message,"type":"proxy_error"}})).to_vec();
            frame.extend_from_slice(b"data: [DONE]\n\n");
            Some(Bytes::from(frame))
        } else { None };
        self.record(complete);
        error_frame
    }
}
impl Stream for ObservedStream {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended { return Poll::Ready(None); }
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                match self.probe.push(&bytes) {
                    Frame::Content if self.first.is_none() => self.first = Some(self.started.elapsed().as_secs_f64() * 1000.0),
                    Frame::Error(message) => { self.telemetry.note_error(&message); self.record(false); }
                    _ => {},
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.telemetry.note_error(&error.to_string());
                self.record(false);
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => Poll::Ready(self.finish().map(Ok)),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for ObservedStream {
    fn drop(&mut self) {
        // Only actual EOF above can settle success. A client closing its body
        // leaves the next request to fail over; never replay a partial reply.
        self.record(false);
    }
}

pub(super) async fn deliver(outcome: ForwardOutcome, telemetry: Arc<RequestTelemetry>, started: Instant, first: Option<f64>, slot: Option<InFlightGuard>, stream: bool, completion: Option<RouteCompletion>) -> Result<ForwardOutcome, GatewayError> {
    match outcome {
        ForwardOutcome::Stream { status, stream: inner } => {
            let observed = ObservedStream::new(inner, telemetry.clone(), started, first, slot, completion);
            if stream { Ok(ForwardOutcome::Stream { status, stream: Box::new(super::stream_errors::public(Box::pin(observed))) }) }
            else {
                let completion = super::aggregate::aggregate_frame_stream(Box::pin(observed), telemetry, Default::default()).await?;
                Ok(ForwardOutcome::Completion { body: completion.body })
            }
        }
        ForwardOutcome::Native(mut response) => {
            if let super::native::NativeBody::Stream(inner) = response.body {
                let mut observed = ObservedStream::new(inner, telemetry.clone(), started, first, slot, completion);
                observed.native = Some(response.protocol);
                response.body = if stream {
                    super::native::NativeBody::Stream(Box::new(observed))
                } else {
                    super::native::NativeBody::Json(super::native::aggregate_stream(
                        Box::pin(observed), response.protocol, &telemetry,
                    ).await?)
                };
                Ok(ForwardOutcome::Native(response))
            } else {
                if let Some(completion) = &completion { completion.finish(&telemetry, telemetry.snapshot().error.is_none()); }
                Ok(ForwardOutcome::Native(response))
            }
        }
        outcome => {
            if let Some(completion) = &completion { completion.finish(&telemetry, telemetry.snapshot().error.is_none()); }
            let snapshot = telemetry.snapshot();
            crate::server::core::routing_observations::record(&snapshot.account_id, &snapshot.upstream_model,
                logging::now_ms(), first, started.elapsed().as_secs_f64() * 1000.0,
                snapshot.total_tokens, if first.is_some() { snapshot.completion_tokens } else { 0 }, snapshot.cache_read_tokens > 0);
            Ok(outcome)
        },
    }
}

pub(super) fn timeout_at(started: Instant, seconds: u64) -> Option<Instant> {
    (seconds > 0).then(|| started + Duration::from_secs(seconds.min(3600)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewritten_failure_stream(error: GatewayError, telemetry: Arc<RequestTelemetry>, content: bool) -> ByteStream {
        let prefix = if content {
            Bytes::from_static(b"data: {\"model\":\"private-model\",\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n")
        } else {
            Bytes::from_static(b"data: {\"model\":\"private-model\",\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n")
        };
        Box::new(super::super::ForwardStream::from_translated(
            Box::pin(futures::stream::iter([Ok(prefix), Err(std::io::Error::other(error))])),
            None,
            super::super::ConnectionGuard::new(super::super::Connections::new()),
            telemetry,
            super::super::sse::FramePolicy::with_rewrite(Some(super::super::sse::ModelRewrite {
                requested: "public-model".into(),
            })),
        ))
    }

    #[tokio::test]
    async fn trusted_stream_failure_survives_model_rewrite_and_first_content_probe() {
        for status in [429, 499, 504, 502] {
            let mut failure = GatewayError::with_status(status, "original host failure")
                .with_code("original_host_code").upstream_code(6029).with_retry_after_seconds(17);
            failure.retry_forbidden = true;
            let stream = rewritten_failure_stream(failure, Arc::new(RequestTelemetry::new()), false);
            let error = match hold(stream, None).await {
                Err(error) => error,
                Ok(_) => panic!("a trusted failure cannot commit the route"),
            };
            assert_eq!(error.status_code, status);
            assert_eq!(error.code.as_deref(), Some("original_host_code"));
            assert_eq!(error.upstream_code, Some(6029));
            assert_eq!(error.retry_after_secs, Some(17));
            assert!(error.retry_forbidden);
        }
    }

    #[tokio::test]
    async fn trusted_stream_failure_after_content_keeps_metadata_in_aggregate() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let mut failure = GatewayError::with_status(429, "original host failure")
            .with_code("original_host_code").upstream_code(6029).with_retry_after_seconds(17);
        failure.retry_forbidden = true;
        let stream = rewritten_failure_stream(failure, telemetry.clone(), true);
        let error = match deliver(ForwardOutcome::Stream { status: 200, stream }, telemetry,
            Instant::now(), None, None, false, None).await {
            Err(error) => error,
            Ok(_) => panic!("a failed aggregate cannot be a successful completion"),
        };
        assert_eq!(error.status_code, 429);
        assert_eq!(error.code.as_deref(), Some("original_host_code"));
        assert_eq!(error.upstream_code, Some(6029));
        assert_eq!(error.retry_after_secs, Some(17));
        assert!(error.retry_forbidden);
    }

    #[tokio::test]
    async fn trusted_stream_failure_is_projected_once_at_the_public_stream_boundary() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let mut failure = GatewayError::with_status(429, "original host failure")
            .with_code("original_host_code").upstream_code(6029);
        failure.retry_forbidden = true;
        let stream = rewritten_failure_stream(failure, telemetry.clone(), true);
        let outcome = deliver(ForwardOutcome::Stream { status: 200, stream }, telemetry,
            Instant::now(), None, None, true, None).await.unwrap();
        let ForwardOutcome::Stream { mut stream, .. } = outcome else { panic!("stream requested"); };
        let mut bytes = Vec::new();
        while let Some(frame) = stream.next().await { bytes.extend_from_slice(&frame.unwrap()); }
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("public-model"));
        assert!(!text.contains("private-model"));
        assert_eq!(text.matches("data: [DONE]").count(), 1);
        let frames: Vec<Value> = text.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter(|line| *line != "[DONE]").map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(frames.iter().filter(|frame| frame.get("error").is_some()).count(), 1);
        let error = frames.iter().find(|frame| frame.get("error").is_some()).unwrap();
        assert_eq!(error["error"]["code"], "original_host_code");
        assert_eq!(error["error"]["upstream_code"], 6029);
        assert!(!text.contains("retry_forbidden") && !text.contains("conversation_class"));
        assert!(frames.iter().all(|frame| frame.pointer("/choices/0/finish_reason").is_none_or(Value::is_null)));
    }

    #[test]
    fn control_frames_do_not_commit_and_partial_tool_frames_do() {
        let mut probe = ContentProbe::default();
        assert!(matches!(probe.push(b": keepalive\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n"), Frame::None));
        assert!(matches!(probe.push(b"data: {\"choices\":[{\"delta\":{\"tool_calls\":["), Frame::None));
        assert!(matches!(probe.push(b"{\"index\":0,\"function\":{\"name\":\"read\"}}]}}]}\n"), Frame::Content));
    }

    #[test]
    fn native_control_frames_wait_for_content_and_terminal_frames_settle() {
        let mut responses = ContentProbe::default();
        assert!(matches!(responses.push(b"data: {\"type\":\"response.created\",\"response\":{}}\n\n"), Frame::None));
        assert!(matches!(responses.push(b"data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\"}\n\n"), Frame::Content));
        assert!(matches!(responses.push(b"data: {\"type\":\"response.completed\",\"response\":{}}\n\n"), Frame::Done));
        assert!(responses.terminal);
        let mut anthropic = ContentProbe::default();
        assert!(matches!(anthropic.push(b"data: {\"type\":\"message_start\",\"message\":{}}\n\n"), Frame::None));
        assert!(matches!(anthropic.push(b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reason\"}}\n\n"), Frame::Content));
        assert!(matches!(anthropic.push(b"data: {\"type\":\"message_stop\"}\n\n"), Frame::Done));
        assert!(anthropic.terminal);
    }

    #[test]
    fn native_custom_tools_and_whole_output_items_commit_content() {
        for event in [
            serde_json::json!({"type":"response.custom_tool_call_input.delta","delta":"print(1)"}),
            serde_json::json!({"type":"response.output_item.added","item":{"type":"custom_tool_call","name":"python","call_id":"call"}}),
            serde_json::json!({"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"ciphertext"}}),
            serde_json::json!({"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}]}}),
            serde_json::json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}}),
            serde_json::json!({"type":"response.refusal.delta","delta":"cannot comply"}),
        ] {
            let mut probe = ContentProbe::default();
            assert!(matches!(probe.push(format!("data: {event}\n\n").as_bytes()), Frame::Content));
        }
    }

    #[tokio::test]
    async fn native_eof_error_keeps_the_requested_protocol() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let stream = futures::stream::iter([Ok(Bytes::from_static(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"))]);
        let mut observed = ObservedStream::new(Box::new(stream), telemetry.clone(), Instant::now(), None, None, None);
        observed.native = Some(crate::server::core::protocol::native::WireProtocol::Responses);
        let frames: Vec<_> = observed.collect().await;
        let text = frames.into_iter().map(|frame| String::from_utf8(frame.unwrap().to_vec()).unwrap()).collect::<String>();
        assert!(text.contains("event: error"));
        assert!(text.contains("\"sequence_number\":0"));
        assert!(!text.contains("[DONE]"));
        assert!(telemetry.snapshot().error.is_some());
    }

    #[tokio::test]
    async fn native_nonstream_delivery_preserves_fields_and_observes_eof() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let reached_eof = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_eof = reached_eof.clone();
        let body = serde_json::json!({
            "id":"resp_native", "model":"public-model", "status":"completed",
            "output":[
                {"type":"reasoning", "encrypted_content":"opaque"},
                {"type":"custom_tool_call", "call_id":"call_native", "input":"print(1)"}
            ],
            "provider_extension":{"preserved":true}
        });
        let terminal = serde_json::json!({"type":"response.completed", "response":body});
        let source = futures::stream::iter([Ok(Bytes::from(format!("data: {terminal}\n\n")))])
            .chain(futures::stream::poll_fn(move |_| {
                observed_eof.store(true, std::sync::atomic::Ordering::SeqCst);
                Poll::Ready(None)
            }));
        let response = super::super::native::NativeResponse {
            protocol: crate::server::core::protocol::native::WireProtocol::Responses,
            status: 200,
            headers: Default::default(),
            body: super::super::native::NativeBody::Stream(Box::new(source)),
        };
        let outcome = deliver(ForwardOutcome::Native(response), telemetry.clone(),
            Instant::now(), None, None, false, None).await.unwrap();
        let ForwardOutcome::Native(response) = outcome else { panic!("native response expected"); };
        let super::super::native::NativeBody::Json(actual) = response.body else { panic!("JSON body expected"); };
        assert_eq!(actual, body);
        assert!(reached_eof.load(std::sync::atomic::Ordering::SeqCst));
        assert!(telemetry.snapshot().error.is_none());
    }

    #[tokio::test]
    async fn native_nonstream_delivery_preserves_typed_stream_failures() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let mut failure = GatewayError::with_status(429, "original native failure")
            .with_code("native_failure").upstream_code(6029).with_retry_after_seconds(17);
        failure.retry_forbidden = true;
        let response = super::super::native::NativeResponse {
            protocol: crate::server::core::protocol::native::WireProtocol::Responses,
            status: 200,
            headers: Default::default(),
            body: super::super::native::NativeBody::Stream(Box::new(futures::stream::iter([
                Ok(Bytes::from_static(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")),
                Err(std::io::Error::other(failure)),
            ]))),
        };
        let error = match deliver(ForwardOutcome::Native(response), telemetry,
            Instant::now(), None, None, false, None).await {
            Err(error) => error,
            Ok(_) => panic!("failed native response cannot become a completion"),
        };
        assert_eq!(error.status_code, 429);
        assert_eq!(error.code.as_deref(), Some("native_failure"));
        assert_eq!(error.upstream_code, Some(6029));
        assert_eq!(error.retry_after_secs, Some(17));
        assert!(error.retry_forbidden);
    }

    #[tokio::test]
    async fn content_timeout_cancels_the_old_stream_without_emitting_its_prefix() {
        let stream = futures::stream::iter([Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"))]).chain(futures::stream::pending());
        let result = hold(Box::new(stream), Some(Instant::now() + Duration::from_millis(10))).await;
        assert!(result.is_err_and(|error| error.code.as_deref() == Some("route_first_content_timeout")));
    }

    #[test]
    fn ordinary_plugin_server_failures_can_retry_until_content_commits() {
        for status in [503, 524] {
            let mut error = GatewayError::with_status(status, "upstream server failure");
            error.conversation_class = Some(crate::server::core::providers::adapter::UpstreamErrorClass::Fatal {
                status: status as u16, message: "upstream server failure".into(), upstream_code: None,
            });
            assert!(transient(&error), "ordinary plugin HTTP {status} must reach another candidate");
            error.retry_forbidden = true;
            assert!(!transient(&error), "explicit stop must retain replay protection");
        }
    }

    #[test]
    fn patience_obeys_retry_after_and_does_not_retry_permission_or_explicit_stop() {
        let mut busy = GatewayError::with_status(429,"busy"); busy.retry_after_secs = Some(20);
        assert_eq!(retry_delay(&busy,1,Duration::from_secs(60)),Duration::from_secs(20));
        assert_eq!(retry_delay(&busy,1,Duration::from_secs(3)),Duration::from_secs(3));
        assert!(transient(&busy));
        assert!(!transient(&GatewayError::with_status(403,"denied")));
        let mut stopped = GatewayError::with_status(503, "adapter stopped");
        stopped.retry_forbidden = true;
        assert!(!transient(&stopped));
    }
    #[tokio::test]
    async fn stream_completion_reports_eof_without_a_terminal_after_content() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let stream = futures::stream::iter([Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n"))]);
        let observed = ObservedStream::new(Box::new(stream), telemetry.clone(), Instant::now(), None, None, None);
        let _: Vec<_> = observed.collect().await;
        assert!(telemetry.snapshot().error.is_some(), "a partial answer must be reported as incomplete");
    }

    #[tokio::test]
    async fn stream_completion_keeps_observing_errors_after_the_first_content() {
        let telemetry = Arc::new(RequestTelemetry::new());
        let stream = futures::stream::iter([
            Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n")),
            Ok(Bytes::from_static(b"data: {\"error\":{\"message\":\"failed after content\"}}\n\ndata: [DONE]\n\n")),
        ]);
        let observed = ObservedStream::new(Box::new(stream), telemetry.clone(), Instant::now(), None, None, None);
        let _: Vec<_> = observed.collect().await;
        assert_eq!(telemetry.snapshot().error.as_deref(), Some("failed after content"));
    }

    #[tokio::test]
    async fn stream_completion_accepts_content_and_terminal_in_one_chunk_or_split_lines() {
        for parts in [vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n".as_slice()],
            vec![b"data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DO".as_slice(), b"NE]\n\n".as_slice()]] {
            let telemetry = Arc::new(RequestTelemetry::new());
            let stream = futures::stream::iter(parts.into_iter().map(|part| Ok(Bytes::copy_from_slice(part))));
            let observed = ObservedStream::new(Box::new(stream), telemetry.clone(), Instant::now(), None, None, None);
            let _: Vec<_> = observed.collect().await;
            assert!(telemetry.snapshot().error.is_none());
        }
    }

}
