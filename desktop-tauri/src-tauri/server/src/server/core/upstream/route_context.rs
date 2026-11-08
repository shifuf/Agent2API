use std::collections::HashMap;
use serde_json::{json, Value};
use crate::server::{config, core::{account_order, routing, routing_groups::{self, GroupProjection, RequestNeeds}}};

#[derive(Clone)]
pub(crate) struct RequestRouting {
    pub settings: config::RoutingSettings,
    pub profile: Option<config::RoutingProfile>,
    pub scope: String,
    pub captured_at: i64,
    pub group: Option<config::RoutingGroup>,
    pub group_projection: GroupProjection,
    /// Set only by ForwardRequest::ignore_model_gate, never by client body fields.
    pub source_test: Option<String>,
    pub profiles: config::RoutingProfiles,
    pub excluded: Vec<String>,
    pub rule_trace: Vec<Value>,
    pub turn_id: String,
    pub account_snapshot: Vec<Value>,
    pub classifier_stack: Vec<String>,
    /// Shared by this request's clones: a fallback consumes a pool only on its
    /// first visit, while unvisited sibling pools retain their next position.
    pub(super) rotation_cursors: std::sync::Arc<std::sync::Mutex<HashMap<String, usize>>>,
    positions: HashMap<String, usize>,
}

impl RequestRouting {
    pub fn conversation_key(&self, headers: &axum::http::HeaderMap, body: &Value) -> String {
        let base = super::route_state::RouteState::conversation_key(headers, body);
        if self.settings.sticky != config::StickyMode::Turn { return base; }
        let turn = turn_identity(body);
        if turn.is_empty() { String::new() } else { format!("{base}:turn:{turn}") }
    }

    pub fn sticky_ttl(&self) -> i64 {
        if self.settings.sticky == config::StickyMode::Turn { 6 * 60 * 60 * 1000 }
        else { self.settings.sticky.ttl_ms().unwrap_or(0) }
    }
    fn capture_with(model: &str, accounts: &[Value],
        profiles: &config::RoutingProfiles, base: config::RoutingSettings) -> Self {
        let ordered = if let Some(profile) = profiles.model_profile(model) {
            crate::server::core::routing_scope::project_accounts(&accounts, profile)
        } else {
            let sorting = account_order::sorting(&accounts, crate::server::logging::now_ms());
            account_order::ordered_accounts(&accounts, &sorting).into_iter().filter(|account| profiles.global.as_ref().map_or(true, |profile|
                profile.includes_provider(routing::provider_of(account)) && !routing::account_id(account).is_some_and(|id| profile.excluded_accounts.iter().any(|excluded| excluded == id))))
                .collect()
        };
        Self { settings: profiles.settings_for(model, base), profile: profiles.effective(model).cloned(),
            scope: profiles.scope(model).to_string(), captured_at: crate::server::logging::now_ms(), group: None,
            group_projection: Default::default(), source_test: None, profiles: profiles.clone(), excluded: Vec::new(), rule_trace: Vec::new(), turn_id: String::new(),
            account_snapshot: accounts.to_vec(), classifier_stack: Vec::new(), rotation_cursors: Default::default(), positions: ordered.iter().enumerate().filter_map(|(index, account)|
                routing::account_id(account).map(|id| (id.to_string(), index))).collect() }
    }

    pub fn capture_request(model: &str, store: &crate::server::core::account_store::store::AccountStore,
        body: &Value, scope: Option<&crate::server::core::key_scope::KeyScope>, ignore: bool) -> Result<Self, crate::server::errors::GatewayError> {
        let (profiles, base) = config::routing_snapshot();
        let snapshot = store.routing_snapshot();
        let accounts: Vec<Value> = snapshot.accounts.iter()
            .filter(|account| crate::server::core::account_store::store_view::account_visible(routing::provider_of(account)))
            .map(|account| account.as_ref().clone()).collect();
        let profiles = crate::server::core::routing_discovery::effective_profiles(&profiles, &accounts);
        if !ignore && body.get("_wb_route_group_id").and_then(Value::as_str).is_some_and(|id|
            !profiles.group_for_model(model).is_some_and(|group| group.id == id)) {
            return Err(crate::server::errors::GatewayError::with_status(409, "路由组已删除或入口已变更，请重新发起请求；未回退其他路由"));
        }
        let mut routing = Self::capture_with(model, &accounts, &profiles, base);
        routing.turn_id = turn_identity(body);
        if ignore { routing.source_test = Some(model.to_string()); }
        if !ignore {
            if let Some(group) = profiles.group_for_model(model).cloned() {
                if !crate::server::core::key_scope::allows_model(scope, &group.model) {
                    return Err(crate::server::errors::GatewayError::with_status(404, "此路由组不在网关 Key 的可用模型列表里").with_code("model_not_found"));
                }
                routing.group_projection = routing_groups::project_with_groups(&group, &profiles.groups, &accounts, &RequestNeeds::from_body(body), scope);
                for candidate in &mut routing.group_projection.accounts {
                    if let Some(model) = routing_groups::candidate_model(candidate).map(str::to_owned) {
                        if let Some(item) = routing_groups::catalog_model(routing::provider_of(candidate), &model) {
                            if let Some(cost) = item.get("cost").filter(|cost| cost.is_object()) { candidate["routingCost"] = cost.clone(); }
                            if let Some(free) = item.get("free").and_then(Value::as_bool) { candidate["routingFree"] = free.into(); }
                        }
                    }
                }
                if let Some(continuation) = body.get("_wb_route_continue") {
                    routing.group_projection.accounts.retain(|account| {
                        continuation.get("candidateId").and_then(Value::as_str) == Some(routing_groups::attempt_key(account).as_str())
                            && continuation.get("accountId").and_then(Value::as_str) == routing::account_id(account)
                            && continuation.get("model").and_then(Value::as_str) == routing_groups::candidate_model(account)
                    });
                }
                routing.settings = group.settings(base);
                routing.profile = Some(group.profile());
                routing.scope = group.model.clone();
                routing.group = Some(group);
            }
        }
        Ok(routing)
    }

    pub fn providers(&self, available: Vec<String>) -> Vec<String> {
        if self.group.is_some() {
            let mut providers = Vec::new();
            for account in &self.group_projection.accounts {
                let provider = routing::provider_of(account).to_string();
                if !providers.contains(&provider) { providers.push(provider); }
            }
            return providers;
        }
        let Some(profile) = &self.profile else { return available };
        let mut ordered = if self.scope.is_empty() { available.clone() } else { profile.providers.clone() };
        if profile.scope() == config::RoutingProviderScope::All {
            for id in &available { if !ordered.contains(id) { ordered.push(id.clone()); } }
        }
        ordered.retain(|id| available.contains(id) && profile.includes_provider(id));
        ordered
    }

    pub fn accounts(&self, accounts: Vec<Value>) -> Vec<Value> {
        if let Some(model) = &self.source_test {
            return accounts.into_iter().map(|mut account| {
                let provider = routing::provider_of(&account);
                let wire = if crate::server::core::custom_providers::is_custom_provider_id(provider) {
                    crate::server::core::custom_providers::source_wire_model_for(provider, model).0
                } else {
                    crate::server::core::providers::catalog::source_wire_target_for_provider(model, provider).model
                };
                // Reuse the trusted upstream target for group eligibility and cooldown keys.
                account["routingModel"] = wire.into();
                account
            }).collect();
        }
        if self.group.is_some() {
            return self.group_projection.accounts.iter().filter_map(|candidate| {
                if self.excluded.contains(&routing_groups::attempt_key(candidate)) { return None; }
                let mut current = accounts.iter().find(|account| routing::account_id(account) == routing::account_id(candidate)
                    && routing::provider_of(account) == routing::provider_of(candidate))?.clone();
                for (key, value) in candidate.as_object().into_iter().flatten().filter(|(key, _)| key.starts_with("routing")) { current[key] = value.clone(); }
                Some(current)
            }).collect();
        }
        let mut accounts: Vec<_> = accounts.into_iter().filter(|account| routing::account_id(account)
            .is_some_and(|id| self.positions.contains_key(id))).collect();
        accounts.sort_by_key(|account| routing::account_id(account).and_then(|id| self.positions.get(id)).copied().unwrap_or(usize::MAX));
        for (index, account) in accounts.iter_mut().enumerate() {
            if let Some(object) = account.as_object_mut() { object.insert("routingPriority".to_string(), index.into()); }
        }
        accounts
    }

    pub fn json(&self) -> Value {
        json!({ "capturedAt": self.captured_at, "scope": self.scope,
            "strategy": self.settings.strategy.as_str(), "sticky": self.settings.sticky.as_str(),
            "providerScope": self.profile.as_ref().map(|profile| profile.scope()).unwrap_or(config::RoutingProviderScope::All),
            "providerCount": self.profile.as_ref().map(|profile| profile.providers.len()),
            "accountCount": if self.group.is_some() { self.group_projection.accounts.len() } else { self.positions.len() },
            "groupId": self.group.as_ref().map(|group| &group.id), "groupName": self.group.as_ref().map(|group| &group.name),
            "rules": self.rule_trace,
            "members": self.group.as_ref().map(|group| group.members.iter().map(|member| json!({
                "id": member.id, "provider": member.provider, "model": member.model, "included": member.included,
                "accountCount": member.accounts.len(),
            })).collect::<Vec<_>>()) })
    }
}

/// Tool results continue the latest genuine user turn. Include its position so
/// repeating identical text in a later turn does not reuse an earlier binding.
pub(crate) fn turn_identity(body: &Value) -> String {
    use sha2::{Digest, Sha256};
    let Some(messages) = body.get("messages").and_then(Value::as_array) else { return String::new(); };
    let user = messages.iter().enumerate().rev().find(|(_, message)| {
        message.get("role").and_then(Value::as_str) == Some("user") && !message.get("content").and_then(Value::as_array)
            .is_some_and(|content| !content.is_empty() && content.iter().all(|item| item.get("type").and_then(Value::as_str) == Some("tool_result")))
    });
    let Some((index, message)) = user else { return String::new(); };
    let mut hash = Sha256::new(); hash.update(index.to_le_bytes());
    hash.update(serde_json::to_vec(message).unwrap_or_default());
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_results_keep_a_turn_but_a_repeated_user_message_starts_a_new_one() {
        let mut body = json!({"messages":[{"role":"user","content":"again"}]});
        let first = turn_identity(&body);
        body["messages"].as_array_mut().unwrap().extend([json!({"role":"assistant","tool_calls":[{"id":"a"}]}), json!({"role":"tool","tool_call_id":"a","content":"done"})]);
        assert_eq!(first, turn_identity(&body));
        body["messages"].as_array_mut().unwrap().push(json!({"role":"user","content":"again"}));
        assert_ne!(first, turn_identity(&body));
    }
}
