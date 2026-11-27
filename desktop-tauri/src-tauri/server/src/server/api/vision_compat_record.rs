use serde_json::json;

use crate::server::request_stats::NewRequestEntry;
use super::pipeline::{stored_attempt_details, stored_privacy_hits, stored_sensitive_hits, RecordContext};

pub(super) fn persist(context: &RecordContext) {
    for call in context.telemetry.take_vision_calls() {
        let mut snapshot = *call.snapshot;
        let private = context.telemetry.privacy_active();
        if private {
            snapshot.sensitive_hits.clear();
            for attempt in &mut snapshot.attempts_detail {
                if attempt.error.is_some() { attempt.error = Some("隐私保护已隐藏诊断内容".into()); }
                if attempt.notice.is_some() { attempt.notice = Some("隐私保护已隐藏诊断内容".into()); }
                attempt.error_policy = None;
                for retry in &mut attempt.retries { retry.reason = "隐私保护已隐藏诊断内容".into(); }
            }
        }
        let mut entry = NewRequestEntry::new(snapshot.upstream_model.clone(), call.status);
        entry.id = snapshot.id.clone();
        entry.ts = Some(call.started_at);
        entry.duration_ms = call.finished_at.saturating_sub(call.started_at);
        entry.first_response_ms = snapshot.first_response_at.map(|at| at.saturating_sub(call.started_at));
        entry.account_id = snapshot.account_id.clone();
        entry.account_name = snapshot.account_name;
        entry.provider = snapshot.provider;
        entry.attempts = snapshot.attempts.max(1);
        entry.client_model = context.client_model.clone();
        entry.upstream_model = snapshot.upstream_model.clone();
        entry.upstream_reasoning = snapshot.upstream_reasoning;
        entry.error = call.error.map(|error| if private { "隐私保护已隐藏诊断内容".into() } else { error });
        entry.prompt_tokens = snapshot.prompt_tokens;
        entry.completion_tokens = snapshot.completion_tokens;
        entry.total_tokens = snapshot.total_tokens;
        entry.cache_read_tokens = snapshot.cache_read_tokens;
        entry.cache_creation_tokens = snapshot.cache_creation_tokens;
        entry.cache_creation_1h_tokens = snapshot.cache_creation_1h_tokens;
        entry.credit = snapshot.credit;
        entry.attempt_details = stored_attempt_details(&snapshot.attempts_detail);
        entry.sensitive_hits = stored_sensitive_hits(&snapshot.sensitive_hits);
        entry.privacy_hits = stored_privacy_hits(&snapshot.privacy_hits);
        entry.is_test = context.is_test;
        entry.source = context.source.clone();
        entry.route = snapshot.route.unwrap_or_else(|| json!({}));
        entry.route["visionParent"] = json!(context.telemetry.id());
        entry.route["visionCompatibility"] = json!({ "mode": "assist_call", "parentId": context.telemetry.id(),
            "status": if call.status == 200 { "completed" } else { "failed" }, "durationMs": entry.duration_ms });
        context.stats.record(entry);
    }
}
