use std::sync::Arc;

use axum::http::HeaderMap;

use crate::server::{config::model_key_source, errors::GatewayError};

use super::RequestTelemetry;

pub(super) type Captured = Option<Result<Arc<model_key_source::Source>, GatewayError>>;

impl RequestTelemetry {
    /// Internal model endpoints install the genuine source before removing client headers.
    /// Absence and failure also belong to the original request and cannot be replaced later.
    pub(crate) fn install_model_key_source(&self, source: Result<Arc<model_key_source::Source>, GatewayError>) {
        let _ = self.model_key_source.set(Some(source));
    }

    pub(crate) fn capture_model_key_source(&self, headers: &HeaderMap) -> Captured {
        self.model_key_source.get_or_init(|| {
            if headers.contains_key("x-api-key") || headers.contains_key(axum::http::header::AUTHORIZATION) {
                Some(model_key_source::capture(headers))
            } else {
                None
            }
        }).clone()
    }

    /// A fixed host classifier has a different intent and replay guard, while its authority
    /// still belongs to the original request. Preserve the original Arc, failure, or absence;
    /// never recapture a key from the classifier's synthetic headers.
    pub(crate) fn inherit_model_key_source(&self, original: &Self, original_headers: &HeaderMap) {
        let _ = self.model_key_source.set(original.capture_model_key_source(original_headers));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_original_model_key_source_cannot_be_recaptured() {
        let telemetry = RequestTelemetry::new();
        assert!(telemetry.capture_model_key_source(&HeaderMap::new()).is_none());
        let mut later = HeaderMap::new();
        later.insert("x-api-key", "later-fixture-key".parse().unwrap());
        assert!(telemetry.capture_model_key_source(&later).is_none());
        telemetry.install_model_key_source(Err(GatewayError::with_status(401, "later failure")));
        assert!(telemetry.capture_model_key_source(&later).is_none());
    }

    #[test]
    fn original_model_key_source_failure_is_retained() {
        let telemetry = RequestTelemetry::new();
        telemetry.install_model_key_source(Err(GatewayError::with_status(401, "original failure")));
        telemetry.install_model_key_source(Err(GatewayError::with_status(409, "replacement failure")));
        match telemetry.capture_model_key_source(&HeaderMap::new()) {
            Some(Err(error)) => {
                assert_eq!(error.status_code, 401);
                assert_eq!(error.message, "original failure");
            }
            _ => panic!("the original key source failure was replaced"),
        }
    }

    #[test]
    fn a_classifier_inherits_absence_without_recapturing_synthetic_authority() {
        let original = RequestTelemetry::new();
        let classifier = RequestTelemetry::new();
        classifier.inherit_model_key_source(&original, &HeaderMap::new());
        let mut synthetic = HeaderMap::new();
        synthetic.insert("x-api-key", "replacement-fixture-key".parse().unwrap());
        assert!(classifier.capture_model_key_source(&synthetic).is_none());
        assert!(original.capture_model_key_source(&synthetic).is_none());
    }

    #[test]
    fn a_classifier_inherits_the_original_error_with_an_independent_intent_guard() {
        let original = RequestTelemetry::new();
        original.install_model_key_source(Err(GatewayError::with_status(401, "original failure")));
        let classifier = RequestTelemetry::new();
        classifier.inherit_model_key_source(&original, &HeaderMap::new());
        match classifier.capture_model_key_source(&HeaderMap::new()) {
            Some(Err(error)) => { assert_eq!(error.status_code, 401); assert_eq!(error.message, "original failure"); }
            _ => panic!("the original failure must be inherited"),
        }
        let call = classifier.replay_guard().open_call().unwrap();
        call.preparation().freeze().unwrap();
        call.preparation().lock_permanent_replay_block();
        call.close();
        assert!(classifier.replay_guard().blocked());
        assert!(!original.replay_guard().blocked());
    }
}
