//! Each nested pool keeps its own conversation/turn affinity.
use serde_json::{json, Value};
use crate::server::{config, core::{routing, routing_groups}, errors::GatewayError, logging};
use super::{route_context::RequestRouting, UpstreamService};

fn layer_key(route: &RequestRouting, conversation: &str, mode: config::StickyMode) -> String {
    let base = if route.settings.sticky == config::StickyMode::Turn { conversation.rsplit_once(":turn:").map(|(base, _)| base).unwrap_or(conversation) } else { conversation };
    if mode == config::StickyMode::Turn { format!("{base}:turn:{}", route.turn_id) } else { base.into() }
}
fn layer_model(route: &RequestRouting, policies: &[Value], depth: usize) -> String {
    let path = policies.iter().take(depth + 1).filter_map(|policy| policy.get("groupId").and_then(Value::as_str)).collect::<Vec<_>>().join("/");
    format!("{}\0{path}", route.scope)
}

pub(super) fn decorate(service: &UpstreamService, route: &RequestRouting, conversation: &str,
    accounts: &mut Vec<Value>, tried: &[String]) -> Result<(), GatewayError> {
    if conversation.is_empty() { return Ok(()); }
    let now = logging::now_ms();
    // Snapshot each pool once; a lookup is stateful (last seen/hit count).
    let mut bindings = std::collections::HashMap::new();
    let mut strict = Vec::new();
    for account in accounts.iter_mut() {
        let policies = account.get("routingStrategyPath").and_then(Value::as_array).cloned().unwrap_or_default();
        let candidate = routing_groups::attempt_key(account);
        let mut ranks = Vec::new();
        for (depth, policy) in policies.iter().enumerate() {
            // The outer pool is already handled by the shared routing snapshot.
            if depth == 0 { ranks.push(false); continue; }
            let mode = config::StickyMode::from_id(policy.get("sticky").and_then(Value::as_str).unwrap_or("off"));
            let model = layer_model(route, &policies, depth);
            let key = layer_key(route, conversation, mode);
            let binding = bindings.entry((key.clone(), model.clone())).or_insert_with(|| service.route
                .snapshot_for_model(&key, &model, now, routing::sticky_ttl_ms(mode)).sticky_hit);
            let hit = binding.as_deref() == Some(candidate.as_str());
            ranks.push(hit);
            if hit && mode == config::StickyMode::Strict { account["routingStrict"] = true.into(); }
            if mode == config::StickyMode::Strict {
                if let Some(binding) = binding.as_ref() {
                    if !strict.iter().any(|(pool, _): &(String, String)| pool == &model) { strict.push((model, binding.clone())); }
                }
            }
        }
        account["routingStickyPath"] = json!(ranks);
    }
    for (model, bound) in strict {
        if tried.contains(&bound) { return Err(GatewayError::with_status(503, "嵌套严格粘性成员本次已失败，未切换其余成员").with_code("route_strict_failed")); }
        let available = accounts.iter().find(|account| routing_groups::attempt_key(account) == bound)
            .is_some_and(|account| account.get("enabled").and_then(Value::as_bool) != Some(false) && account.get("hasCredentials").and_then(Value::as_bool) != Some(false));
        if !available { return Err(GatewayError::with_status(503, "嵌套严格粘性成员不再可用").with_code("route_strict_unavailable")); }
        accounts.retain(|account| {
            let policies = account.get("routingStrategyPath").and_then(Value::as_array).cloned().unwrap_or_default();
            let belongs = (1..policies.len()).any(|depth| layer_model(route, &policies, depth) == model);
            !belongs || routing_groups::attempt_key(account) == bound
        });
    }
    Ok(())
}

pub(super) fn bind(service: &UpstreamService, route: &RequestRouting, conversation: &str,
    account: &Value, source: &str, generation: u64) {
    let policies = account.get("routingStrategyPath").and_then(Value::as_array).cloned().unwrap_or_default();
    for (depth, policy) in policies.iter().enumerate().skip(1) {
        let mode = config::StickyMode::from_id(policy.get("sticky").and_then(Value::as_str).unwrap_or("off"));
        service.route.sticky_bind(&layer_key(route, conversation, mode), &layer_model(route, &policies, depth),
            &routing_groups::attempt_key(account), source, logging::now_ms(), routing::sticky_ttl_ms(mode), generation);
    }
}

pub(super) fn sink_enabled(account: Option<&Value>, fallback: bool) -> bool {
    account.and_then(|account| account.get("routingStrategyPath")).and_then(Value::as_array)
        .and_then(|path| path.iter().rev().find_map(|policy| policy.get("sink").and_then(Value::as_bool))).unwrap_or(fallback)
}
