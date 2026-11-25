//! Affinity is committed by a completed response, never by its first content.
use serde_json::Value;
use crate::server::logging;
use super::{route_context::RequestRouting, route_health::ChannelLease, usage::RequestTelemetry, UpstreamService};

/// Own the selected attempt until the response can hand settlement to its stream.
/// Dropping the handler before that handoff is also an incomplete attempt.
pub(super) struct PendingAttempt {
    service: UpstreamService,
    routing: RequestRouting,
    telemetry: std::sync::Arc<RequestTelemetry>,
}

impl PendingAttempt {
    pub fn new(service: &UpstreamService, routing: &RequestRouting, telemetry: std::sync::Arc<RequestTelemetry>) -> Self {
        Self { service: service.clone(), routing: routing.clone(), telemetry }
    }
}

impl Drop for PendingAttempt {
    fn drop(&mut self) {
        let lease = self.routing.attempt_health.lock().unwrap_or_else(|error| error.into_inner()).take();
        if self.telemetry.is_cancelled() { return; }
        let Some(lease) = lease else { return; };
        // Token preparation and account selection alone are not a failed send.
        if !self.telemetry.active_attempt().is_some_and(|attempt| attempt.candidate_id == lease.candidate && attempt.dispatch.dispatched()) { return; }
        self.routing.with_current_configuration(|| {
            self.service.route.channel_failure(&lease, self.routing.settings.breaker_timeout_seconds, logging::now_ms());
        });
    }
}

pub(super) struct RouteCompletion {
    service: UpstreamService,
    routing: RequestRouting,
    conversation: String,
    model: String,
    candidate_id: String,
    account_id: String,
    candidate: Option<Value>,
    source: &'static str,
    sticky_generation: u64,
    lease: Option<ChannelLease>,
}

impl RouteCompletion {
    #[allow(clippy::too_many_arguments)]
    pub fn new(service: &UpstreamService, routing: &RequestRouting, conversation: &str, model: &str,
        candidate_id: &str, account_id: &str, candidate: Option<&Value>, source: &'static str,
        sticky_generation: u64, lease: Option<ChannelLease>) -> Self {
        Self { service: service.clone(), routing: routing.clone(), conversation: conversation.into(), model: model.into(),
            candidate_id: candidate_id.into(), account_id: account_id.into(), candidate: candidate.cloned(), source,
            sticky_generation, lease }
    }

    pub fn tracks_channel(&self) -> bool { self.lease.is_some() }

    pub fn finish(&self, telemetry: &RequestTelemetry, success: bool) {
        if telemetry.is_cancelled() { return; }
        let now = logging::now_ms();
        if !success {
            if let Some(lease) = &self.lease {
                self.routing.with_current_configuration(|| {
                    self.service.route.channel_failure(lease, self.routing.settings.breaker_timeout_seconds, now);
                });
            }
            return;
        }
        let commit = || {
            if self.account_id.is_empty() { return; }
            if self.routing.settings.breaker_enabled {
                self.service.route.breaker_success(&self.account_id, self.routing.settings.breaker_success_threshold);
            }
            self.service.route.backoff_clear(&self.account_id);
            self.service.route.sink_clear(&self.account_id);
            self.service.route.sticky_bind(&self.conversation, &self.model, &self.candidate_id, self.source,
                now, self.routing.sticky_ttl(), self.sticky_generation);
            if let Some(candidate) = &self.candidate {
                super::route_affinity::bind(&self.service, &self.routing, &self.conversation, candidate, self.source, self.sticky_generation);
            }
        };
        self.routing.with_current_configuration(|| {
            if let Some(lease) = &self.lease {
                // Holding health before affinity also excludes a concurrent freeze.
                self.service.route.health.success(lease, now, commit);
            } else { commit(); }
        });
    }
}
