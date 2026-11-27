use serde_json::Value;

use super::{truncate_chars, ActiveAttempt, LogPhase, RequestTelemetry, TelemetrySnapshot};

pub const MAX_ATTEMPT_DETAILS: usize = 24;
pub const MAX_ATTEMPT_ERROR_CHARS: usize = 200;
pub const MAX_ATTEMPT_ACCOUNT_CHARS: usize = 60;
pub const MAX_ATTEMPT_RETRY_REASON_CHARS: usize = 120;
pub const MAX_ATTEMPT_NOTICE_CHARS: usize = 200;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AttemptDetail {
    pub provider: String,
    #[serde(default)]
    pub account: String,
    #[serde(rename = "accountId", default)]
    pub account_id: String,
    #[serde(rename = "candidateId", default)]
    pub candidate_id: String,
    #[serde(rename = "memberId", default)]
    pub member_id: String,
    #[serde(default)]
    pub model: String,
    #[serde(rename = "responseModels", default)]
    pub response_models: Vec<String>,
    #[serde(rename = "responseModelSource", default)]
    pub response_model_source: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub reason: String,
    #[serde(rename = "stickyHit", default)]
    pub sticky_hit: bool,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<i64>,
    /// 响应头或会话式转发接收结果，不代表流式响应已经结束。
    #[serde(rename = "responseAt", default)]
    pub response_at: Option<i64>,
    #[serde(rename = "finishedAt", default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub retries: Vec<RetryEvent>,
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(rename = "bodyBytes", default)]
    pub body_bytes: Option<i64>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RetryEvent {
    pub reason: String,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(rename = "delayMs", default)]
    pub delay_ms: u64,
}

impl TelemetrySnapshot {
    pub(super) fn current_attempt_mut(&mut self) -> Option<&mut AttemptDetail> {
        if self.attempts > MAX_ATTEMPT_DETAILS as i64 { return None; }
        self.attempts_detail.last_mut()
    }

    pub fn finish_trace(&mut self, finished_at: i64, error: Option<&str>) {
        let Some(last) = self.current_attempt_mut() else { return };
        if last.finished_at.is_none() {
            last.finished_at = Some(finished_at.max(last.started_at.unwrap_or(finished_at)));
        }
        if let Some(error) = error.filter(|text| !text.is_empty()) {
            if last.error.is_none() {
                last.error = Some(truncate_chars(error, MAX_ATTEMPT_ERROR_CHARS));
            }
        }
    }
}

impl RequestTelemetry {
    pub fn set_route_decision(&self, mut decision: Value) {
        let mut guard = self.lock();
        if let (Some(object), Some(previous)) = (decision.as_object_mut(), guard.route.as_ref()) {
            for key in ["titleRoute", "promptRuleId", "visionRoute", "visionParent"] {
                if let Some(value) = previous.get(key) { object.entry(key).or_insert_with(|| value.clone()); }
            }
        }
        if guard.route.as_ref() == Some(&decision) { return; }
        guard.route = Some(decision);
        guard.route_revision = guard.route_revision.wrapping_add(1);
        self.flush_live(&guard);
    }

    pub fn route_decision(&self) -> Option<Value> {
        self.lock().route.clone()
    }

    pub fn set_prompt_rule(&self, id: Option<&str>) {
        let mut guard = self.lock();
        if guard.route.as_ref().and_then(|route| route["promptRuleId"].as_str()) == id { return; }
        let route = guard.route.get_or_insert_with(|| serde_json::json!({}));
        if let Some(object) = route.as_object_mut() {
            if let Some(id) = id { object.insert("promptRuleId".into(), id.into()); } else { object.remove("promptRuleId"); }
            guard.route_revision = guard.route_revision.wrapping_add(1);
            self.flush_live(&guard);
        }
    }

    pub fn note_attempt_response(&self) {
        let mut guard = self.lock();
        let Some(last) = guard.current_attempt_mut() else { return };
        if last.response_at.is_none() {
            last.response_at = Some(crate::server::logging::now_ms());
            self.flush_live(&guard);
        }
    }

    pub fn note_attempt_started(&self, provider: &str, account: &str) {
        self.upstream_stream_end.store(0, std::sync::atomic::Ordering::Release);
        let mut guard = self.lock();
        let account_id = guard.account_id.clone();
        let candidate_id = guard.route.as_ref().and_then(|route| route.get("pickedCandidate")).and_then(Value::as_str).unwrap_or(&account_id).to_string();
        let started_at = crate::server::logging::now_ms();
        *self.active_attempt.lock().unwrap_or_else(|error| error.into_inner()) = Some(ActiveAttempt { candidate_id: candidate_id.clone(), started_at, dispatch: Default::default() });
        if guard.attempts_detail.len() >= MAX_ATTEMPT_DETAILS { return; }
        let member_id = crate::server::core::routing_groups::member_key(&candidate_id).unwrap_or("").to_string();
        let reason = guard.route.as_ref()
            .and_then(|route| route.get("ordered")).and_then(Value::as_array)
            .and_then(|entries| entries.iter().find(|entry| entry.get("candidateId").and_then(Value::as_str).unwrap_or_else(|| entry.get("id").and_then(Value::as_str).unwrap_or("")) == candidate_id))
            .and_then(|entry| entry.get("reason")).and_then(Value::as_str).unwrap_or("");
        let reason = truncate_chars(reason, MAX_ATTEMPT_NOTICE_CHARS);
        let sticky_hit = guard.route.as_ref().and_then(|route| route.get("stickyHit")).and_then(Value::as_bool).unwrap_or(false);
        guard.attempts_detail.push(AttemptDetail {
            provider: provider.to_string(), account: truncate_chars(account, MAX_ATTEMPT_ACCOUNT_CHARS),
            account_id, candidate_id, member_id, model: String::new(), reasoning: String::new(), reason, sticky_hit,
            started_at: Some(started_at), response_at: None, finished_at: None,
            status: None, error: None, retries: Vec::new(), notice: None, body_bytes: None,
            response_models: Vec::new(), response_model_source: String::new(),
        });
        self.enter_phase(&mut guard, LogPhase::Waiting);
        self.flush_live(&guard);
    }
}
