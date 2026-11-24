//! Parameters supplied by a bounded host request, never inferred from client headers or JSON.

use std::borrow::Cow;

use serde_json::Value;

use super::RequestTelemetry;

#[derive(Clone, Copy)]
pub(super) enum HostRequestDefaults {
    Classifier,
    AssistantTitle,
    AnthropicModelTest,
}

impl RequestTelemetry {
    pub(crate) fn mark_classifier_defaults(&self) {
        let _ = self.host_request_defaults.set(HostRequestDefaults::Classifier);
    }

    pub(crate) fn mark_title_defaults(&self) {
        let _ = self.host_request_defaults.set(HostRequestDefaults::AssistantTitle);
    }

    pub(crate) fn mark_anthropic_model_test_defaults(&self) {
        let _ = self.host_request_defaults.set(HostRequestDefaults::AnthropicModelTest);
    }

    /// Call only after binding the genuine CatPaw WASM execution host. Its protocol cannot
    /// express these host defaults; user-supplied parameters keep the normal strict validation.
    /// The adjusted body must also be the body sealed in the original conversation material.
    pub(crate) fn adapt_catpaw_host_defaults<'a>(&self, body: &'a Value) -> Cow<'a, Value> {
        let fields: &[(&str, i64)] = match self.host_request_defaults.get() {
            Some(HostRequestDefaults::Classifier) => &[("temperature", 0), ("max_tokens", 192)],
            Some(HostRequestDefaults::AssistantTitle) => &[("max_tokens", 120)],
            Some(HostRequestDefaults::AnthropicModelTest) => &[("max_tokens", 8192)],
            None => return Cow::Borrowed(body),
        };
        let Some(object) = body.as_object() else { return Cow::Borrowed(body) };
        if !fields.iter().any(|(name, expected)| object.get(*name).and_then(Value::as_i64) == Some(*expected)) {
            return Cow::Borrowed(body);
        }
        let mut adjusted = body.clone();
        if let Some(object) = adjusted.as_object_mut() {
            for (name, expected) in fields {
                if object.get(*name).and_then(Value::as_i64) == Some(*expected) { object.remove(*name); }
            }
        }
        Cow::Owned(adjusted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_client_cannot_claim_host_defaults_with_headers_or_body() {
        let telemetry = RequestTelemetry::new();
        let body = json!({"model":"model", "temperature":0, "max_tokens":192,
            "metadata":{"classifier":true}, "user_agent":"agent2api-router/1"});
        assert_eq!(telemetry.adapt_catpaw_host_defaults(&body).as_ref(), &body);
    }

    #[test]
    fn host_default_adaptation_removes_only_the_original_fixed_values() {
        let telemetry = RequestTelemetry::new();
        telemetry.mark_classifier_defaults();
        let body = json!({"model":"model", "temperature":0, "max_tokens":192, "top_p":0.2,
            "messages":[{"role":"user","content":"task"}]});
        let adjusted = telemetry.adapt_catpaw_host_defaults(&body);
        assert!(adjusted.get("temperature").is_none());
        assert!(adjusted.get("max_tokens").is_none());
        assert_eq!(adjusted["messages"], body["messages"]);
        assert_eq!(adjusted["top_p"], body["top_p"]);
        assert_eq!(body["max_tokens"], 192);
        let changed = json!({"temperature":1, "max_tokens":256});
        assert_eq!(telemetry.adapt_catpaw_host_defaults(&changed).as_ref(), &changed);
    }

    #[test]
    fn a_host_request_cannot_be_reclassified_to_remove_additional_parameters() {
        let telemetry = RequestTelemetry::new();
        telemetry.mark_title_defaults();
        telemetry.mark_classifier_defaults();
        let body = json!({"temperature":0, "max_tokens":120});
        let adjusted = telemetry.adapt_catpaw_host_defaults(&body);
        assert_eq!(adjusted["temperature"], 0);
        assert!(adjusted.get("max_tokens").is_none());
        let child = RequestTelemetry::new();
        assert_eq!(child.adapt_catpaw_host_defaults(&body).as_ref(), &body);
    }
}
