//! HTTP keepalive must not commit a route or outlive the caller's response body.
use std::time::Duration;

use bytes::Bytes;
use futures::{StreamExt, stream::BoxStream};
use serde_json::Value;

use crate::server::core::upstream::{ForwardOutcome, ForwardRequest, UpstreamService, sse};
use crate::server::errors::GatewayError;

type Source = BoxStream<'static, Result<Bytes, std::io::Error>>;

pub(super) async fn response<F>(future: F, streaming: bool, protocol: crate::server::core::protocol::native::WireProtocol, client_model: String) -> axum::response::Response
where F: std::future::Future<Output = axum::response::Response> + Send + 'static {
    if !streaming { return future.await; }
    let mut pending = Box::pin(future);
    tokio::select! {
        biased;
        result = &mut pending => return result,
        _ = tokio::time::sleep(Duration::from_millis(500)) => {}
    }
    let source = futures::stream::once(async move {
        let response = pending.await;
        if response.status().is_success() {
            return response.into_body().into_data_stream().map(|chunk| chunk.map_err(std::io::Error::other)).boxed();
        }
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024).await.unwrap_or_default();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({"error":{"message":"上游请求失败","type":"server_error"}}));
        let error = body.get("error").cloned().unwrap_or(body);
        if protocol == crate::server::core::protocol::native::WireProtocol::Responses {
            // No upstream stream was returned. Use the upstream converter's
            // error lifecycle, including a failed response and event sequence.
            let mut converter = crate::server::core::protocol::responses::ResponsesStream::new(&client_model, &serde_json::json!({}), false);
            return futures::stream::iter(converter.push(&sse::sse_frame(&serde_json::json!({"error":error}))).into_iter().map(Ok)).boxed();
        }
        let event = serde_json::json!({"type":"error","error":error});
        futures::stream::once(async move { Ok(Bytes::from(format!("event: error\ndata: {event}\n\n"))) }).boxed()
    }).flatten().boxed();
    super::pipeline::sse_response(axum::http::StatusCode::OK, Box::new(source))
}

/// Fast failures keep their HTTP status. Once streaming headers are handed off,
/// the owned future finishes through protocol error frames instead. Dropping the
/// body drops this future, including its pending attempt and inference leases.
pub(super) async fn forward(service: UpstreamService, request: ForwardRequest) -> Result<ForwardOutcome, GatewayError> {
    if !request.stream { return service.forward(request).await; }
    let telemetry = request.telemetry.clone();
    let mut pending = Box::pin(async move { service.forward(request).await });
    tokio::select! {
        biased;
        result = &mut pending => return result,
        _ = tokio::time::sleep(Duration::from_millis(500)) => {}
    }
    let source = futures::stream::once(async move {
        match pending.await {
            Ok(ForwardOutcome::Stream { stream, .. }) => stream.boxed(),
            Ok(ForwardOutcome::Completion { mut body }) => {
                // Some adapters can complete without a streaming body. Normalize
                // their final Chat message into the same delta shape converters use.
                if let Some(choices) = body.get_mut("choices").and_then(Value::as_array_mut) {
                    for choice in choices {
                        if let Some(object) = choice.as_object_mut() {
                            if let Some(message) = object.remove("message") { object.insert("delta".into(), message); }
                        }
                    }
                }
                futures::stream::iter([Ok(sse::sse_frame(&body)), Ok(Bytes::from_static(b"data: [DONE]\n\n"))]).boxed()
            }
            Ok(ForwardOutcome::Native(_)) => {
                let error = GatewayError::with_status(502, "Chat入口收到了不匹配的原生协议响应");
                telemetry.note_error(&error.message);
                futures::stream::iter([Ok(sse::sse_frame(&error.payload())), Ok(Bytes::from_static(b"data: [DONE]\n\n"))]).boxed()
            }
            Err(error) => {
                telemetry.note_error(&error.message);
                telemetry.finish_last_attempt(Some(i64::from(error.status_code)), Some(&error.message));
                futures::stream::iter([Ok(sse::sse_frame(&error.payload())), Ok(Bytes::from_static(b"data: [DONE]\n\n"))]).boxed()
            }
        }
    }).flatten().boxed();
    Ok(ForwardOutcome::Stream { status: 200, stream: Box::new(source) })
}

/// Apply after protocol conversion and accounting. Comments carry no model
/// content or usage. Never insert one into a fragmented SSE data/event line.
pub(super) fn keepalive(source: Source) -> Source {
    let interval = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(5), Duration::from_secs(5));
    futures::stream::unfold((source, interval, true, Vec::<u8>::new()), |(mut source, mut interval, first, mut suffix)| async move {
        let comment = || Ok(Bytes::from_static(b": keep-alive\n\n"));
        if first { return Some((comment(), (source, interval, false, suffix))); }
        let boundary = suffix.is_empty() || suffix.ends_with(b"\n\n") || suffix.ends_with(b"\r\n\r\n");
        tokio::select! {
            biased;
            item = source.next() => {
                let item = item?;
                if let Ok(bytes) = &item {
                    if bytes.len() >= 4 {
                        suffix.clear();
                        suffix.extend_from_slice(&bytes[bytes.len() - 4..]);
                    } else {
                        suffix.extend_from_slice(bytes);
                        if suffix.len() > 4 { suffix.drain(..suffix.len() - 4); }
                    }
                }
                Some((item, (source, interval, false, suffix)))
            }
            _ = interval.tick(), if boundary => Some((comment(), (source, interval, false, suffix))),
        }
    }).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_wait_preserves_fast_failure_status() {
        let reply = response(async { GatewayError::with_status(429, "fixture").payload_response() }, true, crate::server::core::protocol::native::WireProtocol::Anthropic, "Fixture/Chat".into()).await;
        assert_eq!(reply.status(), 429);
    }

    #[tokio::test]
    async fn native_wait_preserves_opaque_stream_bytes_after_heartbeat() {
        let original = b"event: content_block_delta\ndata: {\"signature\":\"opaque-fixture\"}\n\n";
        let reply = response(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            super::super::pipeline::sse_response(axum::http::StatusCode::OK, Box::new(futures::stream::iter([Ok(Bytes::from_static(original))])))
        }, true, crate::server::core::protocol::native::WireProtocol::Anthropic, "Fixture/Chat".into()).await;
        assert_eq!(reply.status(), 200);
        let mut body = reply.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), ": keep-alive\n\n");
        let bytes = body.collect::<Vec<_>>().await.into_iter().map(Result::unwrap).fold(Vec::new(), |mut output, chunk| { output.extend_from_slice(&chunk); output });
        assert!(bytes.ends_with(original));
    }

    #[tokio::test]
    async fn delayed_responses_error_finishes_failed_without_fabricated_completion() {
        let reply = response(async {
            tokio::time::sleep(Duration::from_millis(600)).await;
            GatewayError::with_status(503, "temporarily overloaded").payload_response()
        }, true, crate::server::core::protocol::native::WireProtocol::Responses, "Fixture/Chat".into()).await;
        let bytes = axum::body::to_bytes(reply.into_body(), 1024 * 1024).await.unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: error\n"));
        assert!(text.contains("temporarily overloaded"));
        assert!(text.contains("event: response.failed\n"));
        assert!(!text.contains("response.completed"));
        let events = text.lines().filter_map(|line| line.strip_prefix("data: ")).map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
        for (sequence, event) in events.iter().enumerate() { assert_eq!(event["sequence_number"], sequence as i64); }
        assert_eq!(events.last().unwrap()["response"]["model"], "Fixture/Chat");
        assert_eq!(events.last().unwrap()["response"]["status"], "failed");
    }

    #[tokio::test]
    async fn native_wait_body_drop_cancels_the_pending_handler() {
        struct Pending(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Pending {
            fn drop(&mut self) { self.0.store(true, std::sync::atomic::Ordering::SeqCst); }
        }
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = Pending(dropped.clone());
        let reply = response(async move { let _guard = guard; std::future::pending::<axum::response::Response>().await }, true, crate::server::core::protocol::native::WireProtocol::Responses, "Fixture/Chat".into()).await;
        assert!(!dropped.load(std::sync::atomic::Ordering::SeqCst));
        drop(reply);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn heartbeat_waits_for_a_fragmented_frame_boundary_and_does_not_hide_eof() {
        let source = futures::stream::iter([Ok(Bytes::from_static(b"data: {\"choices\":"))])
            .chain(futures::stream::once(async {
                tokio::time::sleep(Duration::from_millis(5100)).await;
                Ok(Bytes::from_static(b"[]}\n\n"))
            }));
        let mut output = keepalive(source.boxed());
        assert_eq!(output.next().await.unwrap().unwrap(), ": keep-alive\n\n");
        assert_eq!(output.next().await.unwrap().unwrap(), "data: {\"choices\":");
        assert_eq!(output.next().await.unwrap().unwrap(), "[]}\n\n", "a comment must not split the JSON line");
        assert!(output.next().await.is_none(), "the ready EOF wins over a pending keepalive tick");
    }
}
