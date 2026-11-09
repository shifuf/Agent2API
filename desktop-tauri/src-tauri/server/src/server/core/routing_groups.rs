//! 跨模型成员投影。运行时字段只存在于候选副本，不写入账号库。

use std::collections::{BTreeMap, HashMap, HashSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::server::config::{self, RoutingGroup, RoutingMember};
use super::{account_store::AccountStore, capability, custom_providers, key_scope::{self, KeyScope}, models::model_id, providers, routing};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestNeeds {
    #[serde(default)] pub tools: bool,
    #[serde(default)] pub images: bool,
    #[serde(default)] pub video: bool,
}

impl RequestNeeds {
    pub fn from_body(body: &Value) -> Self {
        let mut needs = Self {
            tools: ["tools", "functions"].iter().any(|key| body.get(key).and_then(Value::as_array).is_some_and(|tools| !tools.is_empty())),
            ..Default::default()
        };
        for message in body.get("messages").and_then(Value::as_array).into_iter().flatten() {
            needs.tools |= matches!(message.get("role").and_then(Value::as_str), Some("tool" | "function"))
                || message.get("function_call").is_some()
                || message.get("tool_calls").and_then(Value::as_array).is_some_and(|calls| !calls.is_empty());
            for part in message.get("content").and_then(Value::as_array).into_iter().flatten() {
                match part.get("type").and_then(Value::as_str) {
                    Some("image_url" | "input_image" | "image") => needs.images = true,
                    Some("video_url" | "input_video" | "video") => needs.video = true,
                    _ => {},
                }
            }
        }
        needs
    }

    pub fn reason(&self, item: &Value) -> Option<String> {
        for (required, key, label) in [(self.tools, "supportsToolCall", "工具调用"),
            (self.images, "supportsImages", "图片输入"), (self.video, "supportsVideo", "视频输入")] {
            if required && item.get(key).and_then(Value::as_bool) == Some(false) {
                return Some(format!("该模型不支持{label}，已跳过"));
            }
        }
        None
    }
}

fn manifest(provider: &str) -> Vec<Value> {
    if let Some(owner) = custom_providers::get(provider) {
        owner.get("models").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|mut item| {
            super::model_meta::apply(&mut item);
            let overrides = capability::normalize_object(item.get("capabilities"));
            capability::apply_overrides(&mut item, &overrides);
            item
        }).collect()
    } else {
        let rules = super::model_rules::shared();
        providers::catalog::manifest_for_provider(provider).into_iter().map(|mut item| {
            let enabled = item.get("enabled") != Some(&Value::Bool(false))
                && rules.default_enabled(provider, &model_id(&item));
            item["enabled"] = enabled.into();
            item
        }).collect()
    }
}

pub fn catalog_model(provider: &str, model: &str) -> Option<Value> {
    manifest(provider).into_iter().find(|item| model_id(item).eq_ignore_ascii_case(model))
}

pub fn choices(store: &AccountStore) -> Vec<Value> {
    let accounts = store.routing_snapshot();
    let mut ids: Vec<_> = accounts.accounts.iter().map(|account| routing::provider_of(account).to_string()).collect();
    ids.sort(); ids.dedup();
    let mut result = Vec::new();
    for provider in ids {
        if !provider_active(&provider) { continue; }
        let provider_accounts: Vec<_> = accounts.accounts.iter()
            .filter(|account| routing::provider_of(account) == provider).collect();
        let models = manifest(&provider);
        let mut seen = HashSet::new();
        for item in models {
            let model = model_id(&item);
            if model.is_empty() || item.get("enabled") == Some(&Value::Bool(false))
                || !seen.insert(model.to_ascii_lowercase()) { continue; }
            // New choices use the same account and Key-group eligibility as forwarding.
            // Saved group members are projected separately so unavailable entries remain editable.
            let account_count = provider_accounts.iter()
                .filter(|account| member_account_unavailable(account, &model).is_none()).count();
            if account_count == 0 { continue; }
            let identity = super::routing_metadata::describe(&model);
            result.push(json!({ "provider": provider, "providerLabel": providers::label_of(&provider), "model": model,
                "kind": if providers::images::model_is_image(&item) { "image" } else { "chat" },
                "name": item.get("name").and_then(Value::as_str).unwrap_or(&model), "capabilities": capability::effective(&item),
                "credits": item.get("credits").and_then(Value::as_str),
                "canonicalModel": identity.canonical_model, "developer": identity.developer,
                "developerName": identity.developer_name, "family": identity.family,
                "accountCount": account_count }));
        }
    }
    result
}

pub fn candidate_key(member: &str, account: &str) -> String { format!("{member}\0{account}") }
pub fn account_key(key: &str) -> &str { key.split_once('\0').map(|(_, account)| account).unwrap_or(key) }
pub fn member_key(key: &str) -> Option<&str> { key.split_once('\0').map(|(member, _)| member) }
pub fn attempt_key(account: &Value) -> String {
    account.get("routingCandidateId").and_then(Value::as_str).unwrap_or_else(|| routing::account_id(account).unwrap_or("")).to_string()
}
pub fn candidate_model(account: &Value) -> Option<&str> { account.get("routingModel").and_then(Value::as_str) }
pub fn family_key(account: &Value) -> &str {
    account.get("routingMemberId").and_then(Value::as_str).unwrap_or_else(|| routing::provider_of(account))
}

#[derive(Clone, Default)]
pub struct GroupProjection {
    pub accounts: Vec<Value>,
    pub blocked: Vec<Value>,
}

fn provider_active(provider: &str) -> bool {
    super::account_store::store_view::account_visible(provider)
        && custom_providers::get(provider).map_or_else(|| providers::adapter::adapter_by_id(provider).is_some(), |owner| owner.get("enabled") != Some(&Value::Bool(false)))
}

fn member_account_unavailable(account: &Value, upstream_model: &str) -> Option<&'static str> {
    if account.get("enabled") == Some(&Value::Bool(false)) { return Some("参与账号已停用"); }
    if account.get("hasCredentials") != Some(&Value::Bool(true)) { return Some("参与账号未配置可用凭证"); }
    if !super::account_store::custom_accounts::key_groups::allows_model(account, upstream_model) {
        return Some("此 Key 分组未启用或未选择当前上游模型");
    }
    None
}

pub fn project(group: &RoutingGroup, accounts: &[Value], needs: &RequestNeeds, scope: Option<&KeyScope>) -> GroupProjection {
    let profiles = super::routing_discovery::effective_profiles(&config::routing_profiles(), accounts);
    project_with_groups(group, &profiles.groups, accounts, needs, scope)
}

pub fn project_with_groups(group: &RoutingGroup, groups: &BTreeMap<String, RoutingGroup>, accounts: &[Value], needs: &RequestNeeds, scope: Option<&KeyScope>) -> GroupProjection {
    let mut providers: HashSet<String> = accounts.iter().map(|account| routing::provider_of(account).to_string()).collect();
    for group in std::iter::once(group).chain(groups.values()) {
        providers.extend(group.members.iter().filter(|member| member.group.is_empty()).map(|member| member.provider.clone()));
    }
    let active: HashSet<_> = providers.iter().filter(|id| provider_active(id)).cloned().collect();
    let catalog = providers.into_iter().map(|id| { let models = manifest(&id); (id, models) }).collect();
    project_catalog(group, groups, accounts, needs, scope, &catalog, &active)
}

pub fn dynamic_member_id(provider: &str, model: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(format!("{}\0{}", provider.to_lowercase(), model.to_lowercase()).as_bytes()));
    format!("match-{}", &hash[..24])
}

fn members_from_catalog(group: &RoutingGroup, catalog: &BTreeMap<String, Vec<Value>>) -> Vec<RoutingMember> {
    let mut result = group.members.clone();
    let mut named: HashSet<_> = result.iter().filter(|member| member.group.is_empty())
        .map(|member| (member.provider.to_lowercase(), member.model.to_lowercase())).collect();
    let patterns: Vec<_> = group.match_patterns.iter().filter_map(|pattern| config::routing_groups::compile_pattern(pattern).ok()).collect();
    if patterns.is_empty() { return result; }
    for (provider, models) in catalog {
        for item in models {
            let model = model_id(item);
            if model.is_empty() || providers::images::model_is_image(item) != group.kind.is_image() || named.contains(&(provider.to_lowercase(), model.to_lowercase())) { continue; }
            if !patterns.iter().any(|pattern| pattern.is_match(&format!("{provider}/{model}"))) { continue; }
            named.insert((provider.to_lowercase(), model.to_lowercase()));
            result.push(RoutingMember {id:dynamic_member_id(provider, &model), provider:provider.clone(), model,
                included:true, accounts:Vec::new(), group:String::new(), account_scope:config::RoutingAccountScope::All,
                weight:1, effort:String::new(), levels:Vec::new(), fast:false});
            if result.len() >= 4096 { return result; }
        }
    }
    result
}

/// Expanded editor members are derived and must never replace saved patterns.
pub fn expanded_members(group: &RoutingGroup, accounts: &[Value]) -> Vec<RoutingMember> {
    let providers: HashSet<_> = accounts.iter().map(|account| routing::provider_of(account).to_string()).collect();
    let catalog = providers.into_iter().map(|id| { let models = manifest(&id); (id, models) }).collect();
    members_from_catalog(group, &catalog)
}

struct ResolvedMember {
    member: RoutingMember,
    path: Vec<String>,
    policies: Vec<Value>,
    first_token: u64,
    patience: i64,
}

fn resolve_members(group: &RoutingGroup, groups: &BTreeMap<String, RoutingGroup>, catalog: &BTreeMap<String, Vec<Value>>, blocked: &mut Vec<Value>) -> Vec<ResolvedMember> {
    struct Walker<'a> {
        groups: &'a BTreeMap<String, RoutingGroup>, catalog: &'a BTreeMap<String, Vec<Value>>,
        output: Vec<ResolvedMember>, blocked: &'a mut Vec<Value>, visits: usize,
    }
    impl Walker<'_> {
        fn walk(&mut self, group: &RoutingGroup, group_path: &[String], path: &[String], policies: &[Value], first_token: u64, patience: i64) {
            if self.visits >= 8192 { return; }
            self.visits += 1;
            let reason = if !group.enabled || group.hidden { Some("路由组已停用") }
                else if group_path.len() >= config::routing_groups::MAX_NESTING || group_path.contains(&group.id) { Some("路由组嵌套过深或循环引用") }
                else { None };
            if let Some(reason) = reason {
                self.blocked.push(json!({"id":path.first().unwrap_or(&group.id),"memberPath":path,"state":"unavailable","reason":reason}));
                return;
            }
            let mut group_path = group_path.to_vec(); group_path.push(group.id.clone());
            let first_token = if group.first_token > 0 { group.first_token } else { first_token };
            let patience = if group.patience != 0 { group.patience } else { patience };
            let members = members_from_catalog(group, self.catalog);
            let picked = members.iter().find(|member| member.id == group.pick).or_else(|| members.first()).map(|member| member.id.clone());
            for member in members {
                if !member.included || group.strategy == "manual" && picked.as_deref() != Some(member.id.as_str()) { continue; }
                let mut member_path = path.to_vec(); member_path.push(member.id.clone());
                let mut policy_path = policies.to_vec();
                policy_path.push(json!({"groupId":group.id,"memberId":member.id,"strategy":group.strategy,
                    "weight":member.weight,"pick":group.pick,"firstToken":group.first_token,"patience":group.patience,
                    "sticky":group.sticky,"sink":group.sink}));
                if !member.group.is_empty() {
                    if let Some(child) = self.groups.get(&member.group) {
                        if child.kind == group.kind {
                            self.walk(child, &group_path, &member_path, &policy_path, first_token, patience);
                        } else {
                            self.blocked.push(json!({"id":member.id,"memberId":member_path[0],"memberPath":member_path,"state":"unavailable","reason":"嵌套路由组的模型类型不匹配"}));
                        }
                    } else {
                        self.blocked.push(json!({"id":member.id,"memberId":member_path[0],"memberPath":member_path,"state":"unavailable","reason":"嵌套路由组不存在"}));
                    }
                } else {
                    self.output.push(ResolvedMember {member,path:member_path,policies:policy_path,first_token,patience});
                }
                if self.output.len() >= 4096 { return; }
            }
        }
    }
    let mut walker = Walker {groups,catalog,output:Vec::new(),blocked,visits:0};
    walker.walk(group, &[], &[], &[], group.first_token, group.patience);
    walker.output
}

fn project_catalog(group: &RoutingGroup, groups: &BTreeMap<String, RoutingGroup>, accounts: &[Value], needs: &RequestNeeds, scope: Option<&KeyScope>, manifests: &BTreeMap<String, Vec<Value>>, active: &HashSet<String>) -> GroupProjection {
    let mut result = GroupProjection::default();
    if !key_scope::allows_model(scope, &group.model) {
        result.blocked.push(json!({"id":group.id,"state":"unavailable","reason":"网关 Key 不允许此路由组模型"}));
        return result;
    }
    let by_id: HashMap<_, _> = accounts.iter().filter_map(|account| routing::account_id(account).map(|id| (id, account))).collect();
    let sorting = super::account_order::sorting(accounts, crate::server::logging::now_ms());
    let ordered_accounts = super::account_order::ordered_accounts(accounts, &sorting);
    for resolved in resolve_members(group, groups, manifests, &mut result.blocked) {
        let member = &resolved.member;
        let outer = &resolved.path[0];
        let item = manifests.get(&member.provider).and_then(|items| items.iter().find(|item| model_id(item).eq_ignore_ascii_case(&member.model))).cloned();
        let reason = if !key_scope::allows_provider(scope, &member.provider) { Some("网关 Key 不允许此提供商".to_string()) }
            else if !active.contains(&member.provider) { Some("提供商当前不可用".to_string()) }
            else if let Some(item) = &item {
                if item.get("enabled") == Some(&Value::Bool(false)) { Some("上游模型已停用".to_string()) }
                else if providers::images::model_is_image(item) != group.kind.is_image() { Some("成员模型与路由组的类型不匹配".to_string()) }
                else if group.kind.is_image() { None } else { needs.reason(item) }
            } else { Some("模型已不在提供商目录中，配置保留但不参与转发".to_string()) };
        let actual = item.as_ref().map(model_id).unwrap_or_else(|| member.model.clone());
        if let Some(reason) = reason {
            result.blocked.push(json!({ "id": member.id, "memberId": outer, "memberPath": resolved.path, "provider": member.provider,
                "providerLabel": providers::label_of(&member.provider), "model": actual, "name": actual, "state": "unavailable", "reason": reason }));
            continue;
        }
        let selected: Vec<&str> = if member.account_scope == config::RoutingAccountScope::All {
            ordered_accounts.iter().filter(|account| routing::provider_of(account) == member.provider).filter_map(routing::account_id).collect()
        } else { member.accounts.iter().map(String::as_str).collect() };
        if selected.is_empty() {
            result.blocked.push(json!({ "id": member.id, "memberId": outer, "memberPath": resolved.path, "provider": member.provider, "model": actual,
                "name": actual, "state": "excluded", "reason": "该成员没有参与账号" }));
        }
        for id in selected {
            let Some(account) = by_id.get(id).filter(|account| routing::provider_of(account) == member.provider) else {
                result.blocked.push(json!({ "id": id, "memberId": outer, "memberPath": resolved.path, "provider": member.provider, "model": actual,
                    "name": id, "state": "unavailable", "reason": "参与账号已移除或不属于此提供商" }));
                continue;
            };
            if let Some(reason) = member_account_unavailable(account, &actual) {
                result.blocked.push(json!({ "id": id, "memberId": outer, "memberPath": resolved.path, "provider": member.provider, "model": actual,
                    "name": account.get("name").and_then(Value::as_str).unwrap_or(id), "state": "unavailable", "reason": reason }));
                continue;
            }
            let mut account = (*account).clone();
            account["routingCandidateId"] = candidate_key(&resolved.path.join("/"), id).into();
            account["routingMemberId"] = outer.clone().into();
            account["routingMemberPath"] = json!(resolved.path);
            account["routingStrategyPath"] = json!(resolved.policies);
            account["routingModel"] = actual.clone().into();
            account["routingWeight"] = member.weight.into();
            account["routingEffort"] = member.effort.clone().into();
            account["routingLevels"] = json!(member.levels);
            account["routingFast"] = member.fast.into();
            account["routingFirstToken"] = resolved.first_token.into();
            account["routingPatience"] = resolved.patience.into();
            account["routingPriority"] = result.accounts.len().into();
            result.accounts.push(account);
            if result.accounts.len() >= 10_000 { return result; }
        }
    }
    result
}

pub fn validate_members(group: &RoutingGroup, old: Option<&RoutingGroup>, accounts: &[Value]) -> Result<(), String> {
    for member in &group.members {
        if !member.group.is_empty() { continue; }
        let previous = old.and_then(|group| group.members.iter().find(|item| item.id == member.id && item.provider == member.provider && item.model == member.model));
        match catalog_model(&member.provider, &member.model) {
            Some(item) if providers::images::model_is_image(&item) != group.kind.is_image() => return Err("成员模型与路由组的类型不匹配".into()),
            None if previous.is_none() => return Err(format!("提供商中找不到模型 {}，请刷新后重试", member.model)),
            _ => {},
        }
        for id in &member.accounts {
            if let Some(account) = accounts.iter().find(|account| routing::account_id(account) == Some(id)) {
                if routing::provider_of(account) != member.provider { return Err("参与账号不属于所选提供商".into()); }
            } else if !previous.is_some_and(|item| item.accounts.contains(id)) { return Err("参与账号不存在，请刷新后重试".into()); }
        }
    }
    Ok(())
}

/// Shared by the public catalog and gateway-key choices. An explicitly selected
/// member is available only when at least one of its own accounts can use it.
pub fn available_member_model(member: &RoutingMember, accounts: &[std::sync::Arc<Value>], scope: Option<&KeyScope>) -> Option<Value> {
    if !member.group.is_empty() || !member.included || !key_scope::allows_provider(scope, &member.provider) || !provider_active(&member.provider)
        || !accounts.iter().any(|account| routing::provider_of(account) == member.provider
            && (member.account_scope == config::RoutingAccountScope::All || routing::account_id(account).is_some_and(|id| member.accounts.iter().any(|selected| selected == id)))
            && member_account_unavailable(account, &member.model).is_none()) {
        return None;
    }
    catalog_model(&member.provider, &member.model).filter(|item| item.get("enabled") != Some(&Value::Bool(false)))
}

pub fn append_public(store: &AccountStore, scope: Option<&KeyScope>, data: &mut Vec<Value>) {
    let accounts: Vec<Value> = store.routing_snapshot().accounts.iter().map(|account| (**account).clone()).collect();
    let profiles = super::routing_discovery::effective_profiles(&config::routing_profiles(), &accounts);
    let mut ordered: Vec<_> = profiles.groups.values().collect();
    ordered.sort_by_key(|group| profiles.group_order.iter().position(|id| id == &group.id).unwrap_or(usize::MAX));
    let mut hide = HashSet::new();
    for group in ordered {
        if !group.enabled || group.hidden || !key_scope::allows_model(scope, &group.model) { continue; }
        let projection = project_with_groups(group, &profiles.groups, &accounts, &RequestNeeds::default(), scope);
        let mut seen = HashSet::new();
        let members: Vec<_> = projection.accounts.iter().filter_map(|account| {
            let provider = routing::provider_of(account);
            let model = candidate_model(account)?;
            if !seen.insert((provider.to_string(), model.to_string())) { return None; }
            catalog_model(provider, model)
        }).collect();
        if members.is_empty() { continue; }
        if group.unlists {
            // Raw source IDs are not public entries. Hiding by their spelling
            // would hide this group (or an unrelated group) with the same ID.
            for member in &group.members {
                if let Some(child) = profiles.groups.get(&member.group) { hide.insert(child.model.to_ascii_lowercase()); }
            }
        }
        if data.iter().any(|item| model_id(item).eq_ignore_ascii_case(&group.model)) { continue; }
        let mut item = json!({ "id": group.model, "name": group.name, "object": "model", "owned_by": "routing-group", "kind": group.kind, "routing_group": true });
        if group.kind.is_image() {
            for (operation, field) in [(providers::images::ImageOperation::Generate, "supports_image_generation"),
                (providers::images::ImageOperation::Edit, "supports_image_editing")] {
                item[field] = projection.accounts.iter().any(|account| providers::images::candidate_supports_operation(account, operation)).into();
            }
            if item["supports_image_generation"] != true && item["supports_image_editing"] != true { continue; }
            item["output_modalities"] = json!(["image"]);
        }
        for (key, public) in [("supportsToolCall", "supports_tool_call"), ("supportsImages", "supports_images"),
            ("supportsVideo", "supports_video"), ("supportsReasoning", "supports_reasoning")] {
            item[public] = members.iter().all(|item| item.get(key).and_then(Value::as_bool) == Some(true)).into();
        }
        if group.kind.is_image() { item["supports_images"] = item["supports_image_editing"].clone(); }
        for (key, public) in [("maxInputTokens", "max_input_tokens"), ("maxOutputTokens", "max_output_tokens")] {
            if members.iter().all(|item| item.get(key).and_then(Value::as_u64).is_some()) {
                item[public] = members.iter().filter_map(|item| item.get(key).and_then(Value::as_u64)).min().map(Value::from).unwrap_or(Value::Null);
            }
        }
        if group.context > 0 { item["max_input_tokens"] = group.context.into(); }
        else if group.context == 0 {
            if let Some(context) = members.iter().filter_map(|item| item.get("maxInputTokens").and_then(Value::as_u64)).max() {
                item["max_input_tokens"] = context.into();
            }
        }
        if !group.levels.is_empty() { item["reasoning_levels"] = json!(group.levels); }
        item["family"] = group.family.clone().into();
        let mut modalities = vec!["text"];
        if item["supports_images"] == true { modalities.push("image"); }
        if item["supports_video"] == true { modalities.push("video"); }
        item["input_modalities"] = json!(modalities);
        item["created"] = 0.into();
        item["is_default"] = false.into();
        data.push(item);
    }
    data.retain(|item| !hide.contains(&model_id(item).to_ascii_lowercase()));
}

#[cfg(test)]
mod key_group_tests {
    use super::*;

    #[test]
    fn unknown_capabilities_preserve_forwarding_but_explicit_denials_skip_members() {
        let needs = RequestNeeds { tools: true, images: true, video: true };
        assert_eq!(needs.reason(&json!({"id":"custom-unknown"})), None);
        for field in ["supportsToolCall", "supportsImages", "supportsVideo"] {
            let mut model = json!({"id":"explicit-denial"});
            model[field] = false.into();
            assert!(needs.reason(&model).is_some());
            model[field] = true.into();
            assert_eq!(needs.reason(&model), None);
        }
    }

    #[test]
    fn group_candidates_require_credentials_and_the_selected_upstream_model() {
        let account = json!({"enabled":true,"hasCredentials":true,
            "keyGroup":{"enabled":true,"models":["upstream-a"]}});
        assert_eq!(member_account_unavailable(&account, "upstream-a"), None);
        assert!(member_account_unavailable(&account, "upstream-b").is_some());
        for patch in [json!({"enabled":false}), json!({"hasCredentials":false}),
            json!({"keyGroup":{"enabled":false,"models":["upstream-a"]}}),
            json!({"keyGroup":{"enabled":true,"models":[]}})] {
            let mut unavailable = account.clone();
            for (key, value) in patch.as_object().unwrap() { unavailable[key] = value.clone(); }
            assert!(member_account_unavailable(&unavailable, "upstream-a").is_some());
        }
    }

    #[test]
    fn legacy_accounts_keep_working_but_accounts_without_credentials_are_hidden() {
        assert_eq!(member_account_unavailable(&json!({"enabled":true,"hasCredentials":true}), "upstream-a"), None);
        assert!(member_account_unavailable(&json!({"enabled":true}), "upstream-a").is_some());
    }

    fn group(id: &str, members: Value) -> RoutingGroup {
        serde_json::from_value(json!({"id":id,"name":id,"model":id,"strategy":"order","sticky":"auto","members":members})).unwrap()
    }

    fn fixture() -> (Vec<Value>, BTreeMap<String, Vec<Value>>, HashSet<String>) {
        let accounts = vec![json!({"id":"a","provider":"relay","enabled":true,"hasCredentials":true}),
            json!({"id":"b","provider":"relay","enabled":true,"hasCredentials":true,"keyGroup":{"enabled":true,"models":["other"]}}),
            json!({"id":"c","provider":"other","enabled":true,"hasCredentials":true})];
        let catalog = BTreeMap::from([("relay".into(), vec![json!({"id":"chat","supportsToolCall":true})]),
            ("other".into(), vec![json!({"id":"chat","supportsToolCall":true})])]);
        let active = HashSet::from(["relay".into(), "other".into()]);
        (accounts, catalog, active)
    }

    #[test]
    fn group_only_image_projection_keeps_exact_upstream_and_account_scope() {
        let (mut accounts, mut catalog, active) = fixture();
        catalog.insert("relay".into(), vec![json!({"id":"Wire-Image","kind":"image"}),json!({"id":"chat"})]);
        accounts[1]["keyGroup"]["models"] = json!(["Wire-Image"]);
        let mut raw = serde_json::to_value(group("Public-Image", json!([
            {"id":"leaf","provider":"relay","model":"wire-image","included":true,"accounts":["b"]}
        ]))).unwrap();
        raw["kind"] = "image".into();
        let g: RoutingGroup = serde_json::from_value(raw).unwrap();
        let result = project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active);
        assert_eq!(result.accounts.len(), 1);
        assert_eq!(result.accounts[0]["id"], "b");
        assert_eq!(result.accounts[0]["routingModel"], "Wire-Image");
        accounts[1]["keyGroup"]["enabled"] = false.into();
        assert!(project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active).accounts.is_empty());
        let mut dynamic = g.clone(); dynamic.members.clear(); dynamic.match_patterns = vec!["relay/*".into()];
        let expanded = members_from_catalog(&dynamic, &catalog);
        assert_eq!(expanded.len(), 1);
        assert_eq!(expanded[0].model, "Wire-Image");
    }

    #[test]
    fn disabled_sources_block_chat_and_image_members_without_removing_saved_members() {
        for kind in ["chat", "image"] {
            let (accounts, mut catalog, active) = fixture();
            catalog.insert("relay".into(), vec![json!({"id":"chat","kind":kind,"enabled":false})]);
            let mut raw = serde_json::to_value(group("public", json!([
                {"id":"leaf","provider":"relay","model":"chat","included":true,"accounts":["a"]}
            ]))).unwrap();
            raw["kind"] = kind.into();
            let g: RoutingGroup = serde_json::from_value(raw).unwrap();
            let result = project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active);
            assert!(result.accounts.is_empty(), "disabled {kind} source must not enter forwarding");
            assert_eq!(result.blocked[0]["reason"], "上游模型已停用");
            assert_eq!(g.members.len(), 1, "source availability must preserve saved membership");
            catalog.get_mut("relay").unwrap()[0]["enabled"] = true.into();
            assert_eq!(project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active).accounts.len(), 1);
        }
    }

    #[test]
    fn explicit_empty_accounts_stay_empty_while_all_scope_respects_credentials() {
        let (accounts, catalog, active) = fixture();
        let mut g = group("outer", json!([{"id":"leaf","provider":"relay","model":"chat","included":true,"accounts":[]}]));
        let project = |g: &RoutingGroup| project_catalog(g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active);
        assert!(project(&g).accounts.is_empty());
        g.members[0].account_scope = config::RoutingAccountScope::All;
        let result = project(&g);
        assert_eq!(result.accounts.len(), 1);
        assert_eq!(result.accounts[0]["id"], "a");
    }

    #[test]
    fn all_account_members_use_effective_priority_instead_of_insertion_order() {
        let (mut accounts, catalog, active) = fixture();
        accounts[0]["priority"] = 2.into();
        accounts[1]["priority"] = 1.into();
        accounts[1]["keyGroup"]["models"] = json!(["chat"]);
        let g = group("ordered", json!([{"id":"leaf","provider":"relay","model":"chat","included":true,"accountScope":"all"}]));
        let result = project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active);
        assert_eq!(result.accounts.iter().map(|account| account["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["b", "a"]);
    }

    #[test]
    fn nested_path_keeps_leaf_parameters_and_provider_restrictions() {
        let (accounts, catalog, active) = fixture();
        let mut child = group("child", json!([{"id":"leaf","provider":"relay","model":"chat","included":true,"accountScope":"all","weight":3,"effort":"high","fast":true}]));
        child.strategy = "weight".into();
        child.first_token = 30;
        let outer = group("outer", json!([{"id":"branch","group":"child","included":true,"weight":2}]));
        let groups = BTreeMap::from([("child".into(), child)]);
        let result = project_catalog(&outer, &groups, &accounts, &RequestNeeds::default(), None, &catalog, &active);
        assert_eq!(result.accounts.len(), 1);
        let leaf = &result.accounts[0];
        assert_eq!(leaf["routingMemberPath"], json!(["branch","leaf"]));
        assert_eq!(leaf["routingMemberId"], "branch");
        assert_eq!(leaf["routingCandidateId"], "branch/leaf\0a");
        assert_eq!(leaf["routingEffort"], "high");
        assert_eq!(leaf["routingFirstToken"], 30);
        assert_eq!(leaf["routingStrategyPath"][1]["strategy"], "weight");
        let scope = KeyScope::provider_only("other");
        assert!(project_catalog(&outer, &groups, &accounts, &RequestNeeds::default(), Some(&scope), &catalog, &active).accounts.is_empty());
    }

    #[test]
    fn group_authorization_uses_public_name_and_each_leaf_provider() {
        let (accounts, catalog, active) = fixture();
        let mut g = group("public-route", json!([]));
        g.match_patterns = vec!["*/*".into()];
        let make_scope = |models: Value, providers: Value| {
            let raw = json!({"apiKeys":[{"id":"test","name":"test","key":"test-key", "enabled":true,
                "allowedModels":models,"allowedProviders":providers}]});
            let entries = super::super::api_keys::entries_from(raw.as_object().unwrap());
            KeyScope::from_entry(&entries[0])
        };
        let scope = make_scope(json!(["public-route"]), json!(["relay"]));
        let found = project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), Some(&scope), &catalog, &active);
        assert_eq!(found.accounts.len(), 1);
        assert_eq!(found.accounts[0]["id"], "a");
        assert_eq!(found.accounts[0]["routingModel"], "chat");
        let raw_model_only = make_scope(json!(["chat"]), json!(["relay"]));
        assert!(project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), Some(&raw_model_only), &catalog, &active).accounts.is_empty());
    }

    #[test]
    fn patterns_follow_catalog_and_disabled_or_cyclic_groups_do_not_expand() {
        let (accounts, catalog, active) = fixture();
        let mut g = group("outer", json!([]));
        g.match_patterns = vec!["relay/*".into()];
        let projected = project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active);
        assert_eq!(projected.accounts.len(), 1);
        let stable = projected.accounts[0]["routingCandidateId"].clone();
        assert_eq!(project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active).accounts[0]["routingCandidateId"], stable);
        g.enabled = false;
        assert!(project_catalog(&g, &BTreeMap::new(), &accounts, &RequestNeeds::default(), None, &catalog, &active).accounts.is_empty());
        let g = group("loop", json!([{"id":"again","group":"loop","included":true}]));
        let all = BTreeMap::from([("loop".into(), g.clone())]);
        assert!(project_catalog(&g, &all, &accounts, &RequestNeeds::default(), None, &catalog, &active).accounts.is_empty());
    }
}
