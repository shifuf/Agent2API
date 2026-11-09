//! 路由组管理及无副作用的草稿预演。

use axum::{body::Bytes, extract::State, response::Response};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::server::{config, errors, http::{ok_json, parse_body}, ServerState};
use crate::server::core::{routing, routing_groups::{self, RequestNeeds}, routing_scope};

pub fn groups_json(state: &ServerState) -> Value {
    let profiles = config::routing_profiles();
    let accounts = routing::accounts_of(&state.store().list_visible_accounts());
    let mut groups: Vec<_> = profiles.groups.values().collect();
    groups.sort_by_key(|group| profiles.group_order.iter().position(|id| id == &group.id).unwrap_or(usize::MAX));
    let found = crate::server::core::routing_discovery::found_groups(&accounts).into_iter()
        .filter(|group| !profiles.groups.contains_key(&group.id)).map(|mut group| {
            group.hidden = profiles.hidden_auto_groups.contains(&group.id);
            json!({"expandedMembers":routing_groups::expanded_members(&group, &accounts),"group":group,"revision":config::routing_groups::revision(None)})
        }).collect::<Vec<_>>();
    json!({ "groups": groups.into_iter().map(|group| json!({ "group": group, "expandedMembers":routing_groups::expanded_members(group, &accounts), "revision": config::routing_groups::revision(Some(group)) })).collect::<Vec<_>>(),
        "newRevision": config::routing_groups::revision(None), "catalog": routing_groups::choices(&state.store()),
        "foundGroups":found,"autoGroupsEnabled":profiles.auto_groups_enabled,
        "collectionRevision":super::routing_actions::revision(&profiles),"metadata":crate::server::core::routing_metadata::status() })
}

pub async fn get_groups(State(state): State<ServerState>) -> Response {
    if let Some(error) = crate::server::core::group_migration::last_error() {
        return errors::management_error(500, format!("旧配置迁入路由组失败，原数据已保留，请检查启动日志：{error}"));
    }
    match tokio::task::spawn_blocking(move || groups_json(&state)).await {
        Ok(value) => ok_json(value), Err(error) => errors::management_error(500, error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupSave { id: String, group: Option<config::RoutingGroup>, revision: String }

pub async fn put_group(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body).and_then(|mut value| {
        let previous = config::routing_profiles();
        let old = value.get("id").and_then(Value::as_str).and_then(|id| previous.groups.get(id));
        if let (Some(old), Some(raw)) = (old, value.get_mut("group").filter(|raw| raw.is_object())) {
            config::routing_groups::preserve_omitted_fields(raw, old);
        }
        serde_json::from_value::<GroupSave>(value).map_err(|error| errors::GatewayError::bad_request(error.to_string()))
    }) {
        Ok(value) => value, Err(error) => return errors::management_error(400, error.message),
    };
    match tokio::task::spawn_blocking(move || {
        let previous = config::routing_profiles();
        let old = previous.groups.get(&payload.id);
        if let Some(group) = &payload.group {
            config::routing_groups::validate(group)?;
            let accounts = routing::accounts_of(&state.store().list_visible_accounts());
            routing_groups::validate_members(group, old, &accounts)?;
        }
        let effective = crate::server::core::routing_discovery::snapshot(state.store());
        config::routing_groups::save_with_groups(&payload.id, payload.group.clone(), &payload.revision, &effective.groups)?;
        crate::server::core::providers::catalog::invalidate();
        if let Some(old) = old { state.upstream().clear_route_sticky(None, Some(&old.model)); }
        Ok::<_, String>(groups_json(&state))
    }).await {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err(error)) => errors::management_error(if error.starts_with("路由配置已在其他位置修改") { 409 } else { 400 }, error),
        Err(error) => errors::management_error(500, error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preview {
    #[serde(default)] model: String,
    #[serde(default)] group: Option<config::RoutingGroup>,
    #[serde(default)] profile: Option<config::RoutingProfile>,
    #[serde(default)] global: bool,
    #[serde(default)] needs: RequestNeeds,
    #[serde(default)] fail_first: bool,
    #[serde(default)] facts: crate::server::core::routing_rules::RequestFacts,
    #[serde(default)] classification: Option<crate::server::core::routing_rules::Classification>,
}

pub async fn preview(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body).and_then(|value| serde_json::from_value::<Preview>(value).map_err(|error| errors::GatewayError::bad_request(error.to_string()))) {
        Ok(value) => value, Err(error) => return errors::management_error(400, error.message),
    };
    if let Some(group) = &payload.group { if let Err(error) = config::routing_groups::validate(group) { return errors::management_error(400, error); } }
    if let Some(profile) = &payload.profile { if let Err(error) = config::validate_routing_profile(profile) { return errors::management_error(400, error); } }
    if config::normalize_routing_model(&payload.model).is_err() { return errors::management_error(400, "模型 ID 格式不正确"); }
    if payload.group.as_ref().is_some_and(|group| !group.model.eq_ignore_ascii_case(&payload.model)) {
        return errors::management_error(400, "预演入口与路由组模型 ID 不一致");
    }
    match tokio::task::spawn_blocking(move || preview_json(&state, payload)).await {
        Ok(value) => ok_json(value), Err(error) => errors::management_error(500, error.to_string()),
    }
}

pub fn group_queue(state: &ServerState, group: config::RoutingGroup) -> Value {
    preview_json(state, Preview { model: group.model.clone(), group: Some(group), profile: None,
        global: false, needs: Default::default(), fail_first: false, facts: Default::default(), classification: None })["queue"].clone()
}

fn preview_json(state: &ServerState, payload: Preview) -> Value {
    let accounts = routing::accounts_of(&state.store().list_visible_accounts());
    let (saved, base) = config::routing_snapshot();
    let profiles = crate::server::core::routing_discovery::effective_profiles(&saved, &accounts);
    let settings;
    let mut member_blocked = Vec::new();
    let mut rule_trace = Vec::new();
    let group = payload.group.or_else(|| profiles.group_for_model(&payload.model).cloned());
    let mut candidates = if let Some(group) = &group {
        settings = group.settings(base);
        let projection = routing_groups::project_with_groups(group, &profiles.groups, &accounts, &payload.needs, None);
        member_blocked = projection.blocked;
        let mut projected = projection.accounts;
        let before_rules = projected.clone();
        let mut facts = payload.facts;
        if facts.at_ms == 0 { facts.at_ms = crate::server::logging::now_ms(); }
        rule_trace = crate::server::core::routing_rules::preview_rules(group, &profiles, &mut projected, &facts, payload.classification.as_ref());
        for rejected in before_rules.iter().filter(|account| !projected.iter().any(|candidate| routing_groups::attempt_key(candidate) == routing_groups::attempt_key(account))) {
            member_blocked.push(json!({"id":routing::account_id(rejected),"candidateId":routing_groups::attempt_key(rejected),
                "memberId":rejected.get("routingMemberId"),"provider":routing::provider_of(rejected),"state":"paused","reason":"请求命中暂停规则"}));
        }
        for candidate in &mut projected {
            if let Some(model) = routing_groups::candidate_model(candidate).map(str::to_owned) {
                if let Some(item) = routing_groups::catalog_model(routing::provider_of(candidate), &model) {
                    if let Some(cost) = item.get("cost").filter(|cost| cost.is_object()) { candidate["routingCost"] = cost.clone(); }
                    if let Some(free) = item.get("free").and_then(Value::as_bool) { candidate["routingFree"] = free.into(); }
                }
            }
        }
        projected
    } else {
        let providers = if payload.model.is_empty() { routing_scope::available_providers(&accounts) }
            else { crate::server::core::providers::catalog::forwarding_providers(&payload.model) };
        let mut snapshot = profiles.clone();
        let global_draft = if payload.global && snapshot.model_profile(&payload.model).is_none() { payload.profile.clone() } else { None };
        if let Some(profile) = payload.profile {
            if payload.global { snapshot.global = Some(profile); } else { snapshot.models.insert(payload.model.to_ascii_lowercase(), profile); }
        }
        settings = snapshot.settings_for(&payload.model, base);
        let profile = if let Some(mut profile) = global_draft {
            let sorting = crate::server::core::account_order::sorting(&accounts, crate::server::logging::now_ms());
            for (provider, rules) in &sorting.rules {
                let automatic = rules.iter().any(|rule| match rule {
                    config::AccountSortRule::Credit { on, .. } => *on && crate::server::core::account_order::supports_credit_expiry(provider),
                    config::AccountSortRule::Added { on, .. } => *on,
                });
                if automatic { profile.account_order.remove(provider); }
            }
            profile
        } else { routing_scope::materialize_profile_with(&accounts, &providers, &payload.model, &snapshot) };
        routing_scope::project_accounts(&accounts, &profile).into_iter().filter(|account| providers.iter().any(|id| id == routing::provider_of(account))).collect()
    };
    for (index, account) in candidates.iter_mut().enumerate() { account["routingPriority"] = index.into(); }
    let now = crate::server::logging::now_ms();
    let any_ready = candidates.iter().any(|account| !crate::server::core::providers::readiness::gated(routing::provider_of(account)));
    candidates.retain(|account| {
        let cooling = account.get("upstreamCooldownUntil").and_then(Value::as_i64).is_some_and(|until| until > now);
        let gated = any_ready && crate::server::core::providers::readiness::gated(routing::provider_of(account));
        if cooling || gated {
            member_blocked.push(json!({ "id": routing::account_id(account), "candidateId": routing_groups::attempt_key(account),
                "memberId": account.get("routingMemberId"), "model": account.get("routingModel"), "provider": routing::provider_of(account),
                "name": routing::account_name(account, routing::account_id(account).unwrap_or("")), "state": if cooling { "cooldown" } else { "unavailable" },
                "reason": if cooling { "账号处于上游冷却" } else { "提供商暂未就绪" } }));
            return false;
        }
        true
    });
    let keys = routing::CooldownKeys::new(&payload.model);
    let counts = state.upstream().connections().snapshot().into_iter().collect();
    let (sunk, resting, open) = state.upstream().route_queue_facts(now);
    let facts = crate::server::core::limiter::sources::facts();
    let counters = crate::server::core::limiter::counter::facts();
    let limiter = candidates.iter().filter(|account| crate::server::core::limiter::evaluate::blocked(account, &keys.for_account(account), &facts, &counters, now))
        .map(routing_groups::attempt_key).collect();
    let meta = routing::PlanMeta { strategy: settings.strategy, sunk: &sunk, resting: &resting, open: &open,
        limiter_blocked: &limiter, cursor: None, provider_cursors: None, sticky_account: None };
    let mut plan = routing::plan_route(&candidates, &keys, &counts, &[], now, &meta);
    if payload.fail_first {
        if let Some(first) = plan.ordered.first() {
            let member = first.account.get("routingMemberId").and_then(Value::as_str);
            let excluded: Vec<_> = candidates.iter().filter(|account| member.map_or_else(|| routing::provider_of(account) == first.provider,
                |member| account.get("routingMemberId").and_then(Value::as_str) == Some(member))).map(routing_groups::attempt_key).collect();
            plan = routing::plan_route(&candidates, &keys, &counts, &excluded, now, &meta);
        }
    }
    let row = |entry: &routing::PlanEntry| json!({ "id": entry.id, "candidateId": routing_groups::attempt_key(&entry.account),
        "memberId": entry.account.get("routingMemberId"), "model": keys.for_account(&entry.account), "name": entry.name,
        "provider": entry.provider, "providerLabel": crate::server::core::providers::label_of(&entry.provider),
        "state": entry.state, "reason": if payload.fail_first && entry.state == "tried" { "模拟首选成员失败，未实际发送" } else { &entry.reason }, "resetAt": entry.reset_at });
    let mut blocked: Vec<_> = plan.blocked.iter().map(row).collect(); blocked.extend(member_blocked);
    json!({ "model": payload.model, "customized": group.is_some() || profiles.model_profile(&payload.model).is_some(),
        "expandedMembers":group.as_ref().map(|group|routing_groups::expanded_members(group,&accounts)),
        "group": group, "preview": true, "rules":rule_trace, "settings": super::routing_api::routing_json(settings),
        "queue": { "strategy": settings.strategy.as_str(), "sticky": settings.sticky.as_str(),
            "pickedId": plan.ordered.first().map(|entry| &entry.id), "ordered": plan.ordered.iter().map(row).collect::<Vec<_>>(), "blocked": blocked } })
}
