use std::sync::Arc;

use crate::server::core::protocol::{anthropic_outbound, responses_outbound};
use crate::server::core::upstream::usage::RequestTelemetry;

use super::OutboundKind;

pub(super) struct ProtocolTranslateStream {
    /// 上游字节流。错误在构造时就描述成文案折进 `io::Error`（与
    /// `ForwardStream::new` 同一手法）：空闲守卫的入参就是这个类型，
    /// 两个消费层（ForwardStream / 聚合器）拿到的也是同一形态。
    inner: futures::stream::BoxStream<'static, Result<bytes::Bytes, std::io::Error>>,
    machine: TranslateMachine,
    /// 已翻译待下发的帧（一个上游 chunk 可能产出多帧）
    pending: std::collections::VecDeque<bytes::Bytes>,
    /// 上游已结束（不再 poll 上游，把 pending 吐完即 None）
    upstream_done: bool,
    telemetry: Arc<RequestTelemetry>,
    capture: Option<Arc<crate::server::core::debug_traffic::TrafficCapture>>,
}

/// 两个翻译状态机的分派壳（转换器接口同形，包一层枚举避免 dyn 分发）
enum TranslateMachine {
    Responses(responses_outbound::ChatFromResponsesStream),
    Anthropic(anthropic_outbound::ChatFromAnthropicStream),
}

impl TranslateMachine {
    fn has_upstream_terminal(&self) -> bool {
        match self {
            Self::Responses(machine) => machine.has_upstream_terminal(),
            Self::Anthropic(machine) => machine.has_upstream_terminal(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<bytes::Bytes> {
        match self {
            Self::Responses(machine) => machine.push(chunk),
            Self::Anthropic(machine) => machine.push(chunk),
        }
    }

    fn finish(&mut self) -> Vec<bytes::Bytes> {
        match self {
            Self::Responses(machine) => machine.finish(),
            Self::Anthropic(machine) => machine.finish(),
        }
    }
}
impl ProtocolTranslateStream {
    pub(super) fn new(
        kind: OutboundKind,
        model: &str,
        response: reqwest::Response,
        telemetry: &Arc<RequestTelemetry>,
    ) -> Self {
        use futures::StreamExt;
        let capture = telemetry.capture();
        if let Some(capture) = &capture {
            capture.attach_response(response.status().as_u16(), response.headers());
        }
        // 上游字节 → io::Error（描述成文案）→ 空闲守卫（设置页「请求超时」
        // 的「流式响应空闲超时」，与 chat 路径同一份口径、同一个实现）
        let described = response.bytes_stream().map(|item| {
            item.map_err(|error| {
                std::io::Error::other(crate::server::core::egress::describe_error_detail(&error))
            })
        });
        let guarded = crate::server::core::upstream::stall::idle_guard(
            crate::server::core::upstream::model_trace::observe(Box::pin(described), telemetry.clone()),
            std::time::Duration::from_millis(
                crate::server::config::timeout_settings().stream_idle_ms(),
            ),
        );
        Self {
            inner: guarded,
            machine: match kind {
                OutboundKind::Responses => TranslateMachine::Responses(
                    responses_outbound::ChatFromResponsesStream::new(model),
                ),
                OutboundKind::Anthropic => TranslateMachine::Anthropic(
                    anthropic_outbound::ChatFromAnthropicStream::new(model),
                ),
            },
            pending: std::collections::VecDeque::new(),
            upstream_done: false,
            telemetry: telemetry.clone(),
            capture,
        }
    }
}

impl futures::Stream for ProtocolTranslateStream {
    type Item = Result<bytes::Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use futures::StreamExt;
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return std::task::Poll::Ready(Some(Ok(frame)));
            }
            if self.upstream_done {
                return std::task::Poll::Ready(None);
            }
            match self.inner.poll_next_unpin(cx) {
                std::task::Poll::Pending => return std::task::Poll::Pending,
                std::task::Poll::Ready(None) => {
                    self.upstream_done = true;
                    // 上游 EOF：转换器收尾（finish_reason / usage / [DONE]）
                    for frame in self.machine.finish() {
                        self.pending.push_back(frame);
                    }
                    // The parser already owns the complete event buffer. A
                    // bounded model observer cannot decide completion here.
                    self.telemetry.note_upstream_stream_end(self.machine.has_upstream_terminal());
                }
                std::task::Poll::Ready(Some(Ok(bytes))) => {
                    // 调试模式：采上游原始字节（在翻译之前，与 chat 路径同语义）
                    if let Some(capture) = &self.capture {
                        capture.push(&bytes);
                    }
                    for frame in self.machine.push(&bytes[..]) {
                        self.pending.push_back(frame);
                    }
                }
                std::task::Poll::Ready(Some(Err(error))) => {
                    self.upstream_done = true;
                    // 文案已在构造时描述好（见 inner 字段说明）：reqwest 错误的
                    // 描述、空闲守卫的超时原文，原样上抛
                    return std::task::Poll::Ready(Some(Err(error)));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translated_eof_does_not_invent_an_upstream_terminal() {
        let mut responses = TranslateMachine::Responses(responses_outbound::ChatFromResponsesStream::new("model"));
        responses.push(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n");
        assert!(!responses.finish().is_empty());
        assert!(!responses.has_upstream_terminal());

        let mut anthropic = TranslateMachine::Anthropic(anthropic_outbound::ChatFromAnthropicStream::new("model"));
        anthropic.push(b"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\"}}\n\n");
        assert!(!anthropic.finish().is_empty());
        assert!(!anthropic.has_upstream_terminal());
    }

    #[test]
    fn translated_terminal_survives_a_fragmented_final_event() {
        let mut responses = TranslateMachine::Responses(responses_outbound::ChatFromResponsesStream::new("model"));
        responses.push(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.compl");
        assert!(!responses.has_upstream_terminal());
        responses.push(b"eted\"}\n\n");
        responses.finish();
        assert!(responses.has_upstream_terminal());

        let mut anthropic = TranslateMachine::Anthropic(anthropic_outbound::ChatFromAnthropicStream::new("model"));
        anthropic.push(b"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\"}}\n\ndata: {\"type\":\"message_st");
        assert!(!anthropic.has_upstream_terminal());
        anthropic.push(b"op\"}\n\n");
        anthropic.finish();
        assert!(anthropic.has_upstream_terminal());
    }
}
