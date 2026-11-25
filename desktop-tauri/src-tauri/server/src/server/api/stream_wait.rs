//! HTTP keepalive must not commit a route or outlive the caller's response body.
use std::time::Duration;

use bytes::Bytes;
use futures::{StreamExt, stream::BoxStream};
use serde_json::Value;

use crate::server::core::upstream::{ForwardOutcome, ForwardRequest, UpstreamService, sse};
use crate::server::errors::GatewayError;

type Source = BoxStream<'static, Result<Bytes, std::io::Error>>;

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
