//! Bounded, read-only observation at the upstream byte boundary, before protocol translation.
use std::sync::Arc;
use bytes::Bytes;
use futures::{StreamExt, stream::BoxStream};
use serde_json::Value;
use super::usage::RequestTelemetry;

const MAX_EVENT: usize = 256 * 1024;

#[derive(Default)]
pub struct Observer {
    line: Vec<u8>,
    data: Vec<u8>,
    bytes: usize,
    skipped: bool,
    line_nonempty: bool,
    ndjson_line: bool,
    skip_lf: bool,
}

impl Observer {
    pub fn feed(&mut self, bytes: &[u8], telemetry: &RequestTelemetry) {
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' { continue; }
            }
            if byte == b'\n' || byte == b'\r' {
                self.line(telemetry);
                self.skip_lf = byte == b'\r';
                continue;
            }
            if !self.line_nonempty { self.ndjson_line = byte == b'{'; }
            self.line_nonempty = true;
            self.bytes = self.bytes.saturating_add(1);
            if self.bytes > MAX_EVENT {
                self.line.clear(); self.data.clear(); self.skipped = true;
            }
            if !self.skipped { self.line.push(byte); }
        }
    }

    fn line(&mut self, telemetry: &RequestTelemetry) {
        let line = self.line.as_slice();
        if line.is_empty() && !self.skipped {
            self.event(telemetry);
            self.bytes = 0;
        } else if self.skipped {
            if self.ndjson_line || !self.line_nonempty { self.skipped = false; self.bytes = 0; }
        } else if let Some(data) = line.strip_prefix(b"data:") {
            self.data.extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
            self.data.push(b'\n');
        } else if line.starts_with(b"{") {
            if let Ok(value) = serde_json::from_slice::<Value>(line) { self.value(&value, telemetry); }
            self.bytes = 0;
        }
        self.line.clear();
        self.line_nonempty = false;
        self.ndjson_line = false;
    }

    fn event(&mut self, telemetry: &RequestTelemetry) {
        if let Ok(value) = serde_json::from_slice::<Value>(&self.data) {
            self.value(&value, telemetry);
        }
        self.data.clear();
    }

    fn value(&mut self, value: &Value, telemetry: &RequestTelemetry) {
        telemetry.observe_response_model(value, "upstream");
    }

    fn finish(&mut self, telemetry: &RequestTelemetry) {
        if !self.skipped {
            if !self.line.is_empty() { self.line(telemetry); }
            self.event(telemetry);
        }
    }
}

pub fn observe(stream: BoxStream<'static, Result<Bytes, std::io::Error>>, telemetry: Arc<RequestTelemetry>)
    -> BoxStream<'static, Result<Bytes, std::io::Error>> {
    Box::pin(futures::stream::unfold((stream, Observer::default(), telemetry), |(mut stream, mut observer, telemetry)| async move {
        match stream.next().await {
            Some(item) => {
                if let Ok(bytes) = &item { observer.feed(bytes, &telemetry); }
                Some((item, (stream, observer, telemetry)))
            }
            None => { observer.finish(&telemetry); None }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fragmented_protocol_models_belong_to_each_attempt() {
        let telemetry = RequestTelemetry::new();
        for (index, value) in [json!({"model":"chat"}), json!({"response":{"model":"responses"}}),
            json!({"message":{"model":"anthropic"}}), json!({"response":{"modelVersion":"gemini"}})].iter().enumerate() {
            telemetry.note_attempt_started("custom", "account");
            let mut observer = Observer::default();
            for byte in format!("data: {value}\r\n\r\n").as_bytes() { observer.feed(&[*byte], &telemetry); }
            assert_eq!(telemetry.snapshot().attempts_detail[index].response_models.len(), 1);
        }
        assert_eq!(telemetry.snapshot().attempts_detail[0].response_models[0], "chat");
        assert_eq!(telemetry.snapshot().attempts_detail[3].response_models[0], "gemini");
    }

    #[test]
    fn missing_fields_never_become_the_requested_model_and_evidence_is_bounded() {
        let telemetry = RequestTelemetry::new();
        telemetry.note_attempt_started("custom", "account");
        telemetry.note_upstream_model("requested");
        telemetry.observe_response_model(&json!({"choices":[]}), "upstream");
        assert!(telemetry.snapshot().attempts_detail[0].response_models.is_empty());
        for index in 0..100 { telemetry.observe_response_model(&json!({"model":format!("m{index}")}), "upstream"); }
        assert_eq!(telemetry.snapshot().attempts_detail[0].response_models.len(), 8);
    }

    #[test]
    fn oversized_event_recovers_at_boundary_and_unterminated_tail_is_observed() {
        let telemetry = RequestTelemetry::new();
        telemetry.note_attempt_started("custom", "account");
        let mut observer = Observer::default();
        observer.feed(&vec![b'x'; MAX_EVENT + 100], &telemetry);
        assert!(observer.line.is_empty() && observer.data.is_empty());
        observer.feed(b"\n\ndata: {\"model\":\"tail\"}", &telemetry);
        observer.finish(&telemetry);
        assert_eq!(telemetry.snapshot().attempts_detail[0].response_models, vec!["tail"]);
    }

    #[test]
    fn cr_only_events_are_supported() {
        let telemetry = RequestTelemetry::new();
        telemetry.note_attempt_started("custom", "a");
        let mut observer = Observer::default();
        observer.feed(b"data: {\"model\":\"cr-model\"}\r\r", &telemetry);
        assert_eq!(telemetry.snapshot().attempts_detail[0].response_models, vec!["cr-model"]);
    }

    #[test]
    fn review_oversized_ndjson_line_does_not_hide_later_model_evidence() {
        let telemetry = RequestTelemetry::new();
        telemetry.note_attempt_started("custom", "a");
        let mut observer = Observer::default();
        observer.feed(format!("{{\"content\":\"{}\"}}\n", "x".repeat(MAX_EVENT + 100)).as_bytes(), &telemetry);
        observer.feed(b"{\"model\":\"after-large-line\"}\n", &telemetry);
        observer.finish(&telemetry);
        assert_eq!(telemetry.snapshot().attempts_detail[0].response_models, vec!["after-large-line"]);
    }
}
