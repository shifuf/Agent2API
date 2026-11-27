use super::RequestTelemetry;
use crate::server::core::prompt::rules::Request;

impl RequestTelemetry {
    /// 入站模型与识别结果只采一次，自动续写和路由重试沿用原始条件。
    pub(crate) fn capture_prompt_request(&self, source: &crate::server::request_stats::RequestSource, model: &str) {
        let mut slot = self.prompt_request.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() { return; }
        // Privacy omits evidence from persisted request metadata, but it must
        // not change the identified client used by conditional prompt rules.
        let client = source.evidence.as_ref().map(|evidence| evidence.client_id.as_str())
            .filter(|client| !client.is_empty())
            .or_else(|| crate::server::core::client::catalog::CLIENTS.iter()
                .find(|client| client.value == source.client).map(|client| client.id))
            .or_else(|| source.client.starts_with("custom:").then_some(source.client.as_str()))
            .unwrap_or("other");
        *slot = Some(Request { client: client.into(), model: model.into() });
    }

    pub(crate) fn prompt_request(&self) -> Option<Request> {
        self.prompt_request.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::request_stats::RequestSource;

    #[test]
    fn private_request_preserves_identified_client_for_prompt_rules() {
        for (identified, expected) in [("Codex", "codex"), ("custom:fixture", "custom:fixture")] {
            let telemetry = RequestTelemetry::new();
            telemetry.capture_prompt_request(&RequestSource {
                client: identified.into(), evidence: None,
                behavior_client: "ZCode".into(), ..Default::default()
            }, "Source-Chat");
            let request = telemetry.prompt_request().unwrap();
            assert_eq!(request.client, expected);
            assert_eq!(request.model, "Source-Chat");
            telemetry.capture_prompt_request(&RequestSource::default(), "Title-Cheap");
            assert_eq!(telemetry.prompt_request().unwrap().model, "Source-Chat");
        }
    }
}
