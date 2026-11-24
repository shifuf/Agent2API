//! Final Chat observations for host consumers that do not pass through an HTTP response body.
//! A parsed title or classifier JSON alone is not evidence of a complete CatPaw result.

use std::{io, pin::Pin, sync::Arc, task::{Context, Poll}};

use bytes::Bytes;
use futures::Stream;
use serde_json::Value;

use crate::server::{core::plugin_host::wasm::CatPawOutputGuard, errors::GatewayError};

use super::usage::RequestTelemetry;

type FrameStream = Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send + Unpin>;

pub(crate) fn verify_completion(body: &Value, telemetry: &RequestTelemetry) -> Result<(), GatewayError> {
    let Some(mut guard) = telemetry.take_catpaw_output().map_err(|_| unconfirmed(telemetry))? else { return Ok(()) };
    let bytes = serde_json::to_vec(body).map_err(|_| unconfirmed(telemetry))?;
    guard.observe_json(&bytes).map_err(|_| unconfirmed(telemetry))?;
    guard.prepare().map_err(|_| unconfirmed(telemetry))?;
    guard.finish().map_err(|_| unconfirmed(telemetry))
}

/// The caller must consume to EOF before using the aggregated result. Dropping a stream on
/// cancellation, timeout, size limit or parse failure drops its unfinished output guard too.
pub(crate) fn observe_stream(source: FrameStream, telemetry: &Arc<RequestTelemetry>) -> FrameStream {
    match telemetry.take_catpaw_output() {
        Ok(Some(guard)) => Box::new(ObservedChatStream { source, guard: Some(guard), telemetry: telemetry.clone(), ended: false }),
        Ok(None) => source,
        Err(_) => {
            let error = invalid(telemetry);
            Box::new(futures::stream::once(std::future::ready(Err(error))))
        }
    }
}

struct ObservedChatStream {
    source: FrameStream,
    guard: Option<CatPawOutputGuard>,
    telemetry: Arc<RequestTelemetry>,
    ended: bool,
}

impl Stream for ObservedChatStream {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended { return Poll::Ready(None); }
        match Pin::new(&mut self.source).poll_next(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(bytes))) => {
                if self.guard.as_mut().is_none_or(|guard| guard.push(&bytes).is_err()) {
                    self.guard.take();
                    self.ended = true;
                    Poll::Ready(Some(Err(invalid(&self.telemetry))))
                } else { Poll::Ready(Some(Ok(bytes))) }
            }
            Poll::Ready(Some(Err(error))) => {
                self.guard.take();
                self.ended = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.ended = true;
                let Some(mut guard) = self.guard.take() else { return Poll::Ready(Some(Err(invalid(&self.telemetry)))) };
                if guard.prepare().is_err() || guard.finish().is_err() {
                    Poll::Ready(Some(Err(invalid(&self.telemetry))))
                } else { Poll::Ready(None) }
            }
        }
    }
}

fn invalid(telemetry: &RequestTelemetry) -> io::Error {
    io::Error::other(unconfirmed(telemetry).message)
}

fn unconfirmed(telemetry: &RequestTelemetry) -> GatewayError {
    telemetry.note_error("CatPaw 内部请求的最终输出未完整核对");
    let mut error = GatewayError::with_status(502, "CatPaw 内部请求的最终输出未完整核对，未使用部分内容作为成功结果")
        .with_code("catpaw_output_unconfirmed");
    error.retry_forbidden = true;
    error
}

#[cfg(test)]
#[path = "internal_output/official_fixture_tests.rs"]
mod official_fixture_tests;
