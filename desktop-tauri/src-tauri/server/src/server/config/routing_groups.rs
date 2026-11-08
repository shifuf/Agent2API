//! 自定义对话路由组。组是独立入口，成员直指提供商的模型，不借用模型映射。

use std::collections::{BTreeMap, HashSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{RoutingProfile, RoutingSettings};

pub const MAX_GROUPS: usize = 500;
pub const MAX_MEMBERS: usize = 256;
pub const MAX_NESTING: usize = 8;
pub const STRATEGIES: &[&str] = &["smart", "order", "rotate", "least-used", "pace", "free", "fast", "weight", "manual", "provider"];
pub const PROFILE_STRATEGIES: &[&str] = &["smart", "order", "rotate", "least-used", "pace", "free", "fast", "provider"];

fn enabled_default() -> bool { true }
fn weight_default() -> u32 { 1 }
fn patience_default() -> i64 { -1 }
fn context_default() -> i64 { -1 }
fn classifier_timeout_default() -> u64 { 8 }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutingAccountScope { #[default] Selected, All }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingMember {
    pub id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    pub included: bool,
    #[serde(default)]
    pub accounts: Vec<String>,
    #[serde(default)] pub group: String,
    #[serde(default)] pub account_scope: RoutingAccountScope,
    #[serde(default = "weight_default")] pub weight: u32,
    #[serde(default)] pub effort: String,
    #[serde(default)] pub levels: Vec<String>,
    #[serde(default)] pub fast: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingGroup {
    pub id: String,
    pub name: String,
    pub model: String,
    #[serde(default)]
    pub description: String,
    pub strategy: String,
    pub sticky: String,
    pub members: Vec<RoutingMember>,
    #[serde(default = "enabled_default")] pub enabled: bool,
    #[serde(default)] pub auto: bool,
    #[serde(default)] pub hidden: bool,
    #[serde(default, rename = "match")] pub match_patterns: Vec<String>,
    #[serde(default)] pub pick: String,
    #[serde(default)] pub sink: Option<bool>,
    #[serde(default)] pub first_token: u64,
    #[serde(default = "patience_default")] pub patience: i64,
    #[serde(default)] pub rules: Vec<super::RoutingRule>,
    #[serde(default)] pub classifier: String,
    #[serde(default = "classifier_timeout_default")] pub classifier_timeout: u64,
    #[serde(default)] pub effort: String,
    #[serde(default = "context_default")] pub context: i64,
    #[serde(default)] pub levels: Vec<String>,
    #[serde(default)] pub family: String,
    #[serde(default)] pub unlists: bool,
}

impl RoutingGroup {
    pub fn settings(&self, mut base: RoutingSettings) -> RoutingSettings {
        base.strategy = super::RouteStrategy::from_id(&self.strategy);
        base.sticky = super::StickyMode::from_id(&self.sticky);
        if let Some(sink) = self.sink { base.sink = sink; }
        base
    }

    pub fn patience_ms(&self) -> u64 {
        match self.patience { n if n < 0 => 0, 0 => 60_000, n => n.min(240) as u64 * 1000 }
    }

    pub fn first_token_ms(&self) -> u64 { self.first_token.saturating_mul(1000) }

    pub fn picked_member(&self) -> Option<&str> {
        self.members.iter().find(|member| member.id == self.pick)
            .or_else(|| self.members.first()).map(|member| member.id.as_str())
    }

    pub fn profile(&self) -> RoutingProfile {
        let mut providers = Vec::new();
        for member in self.members.iter().filter(|member| member.included && member.group.is_empty()) {
            if !providers.contains(&member.provider) { providers.push(member.provider.clone()); }
        }
        RoutingProfile { provider_scope: Some(super::RoutingProviderScope::Selected), providers,
            strategy: Some(self.strategy.clone()), sticky: Some(self.sticky.clone()), ..Default::default() }
    }
}

pub fn revision(group: Option<&RoutingGroup>) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(&group).unwrap_or_default()))
}

/// Old editors reconstruct only their known fields. Preserve absent additions;
/// explicit empty/false/zero values still mean the user requested a reset.
pub fn preserve_omitted_fields(raw: &mut Value, old: &RoutingGroup) {
    let Ok(previous) = serde_json::to_value(old) else { return; };
    let Some(object) = raw.as_object_mut() else { return; };
    for key in ["enabled", "auto", "hidden", "match", "pick", "sink", "firstToken", "patience", "rules", "classifier",
        "classifierTimeout", "effort", "context", "levels", "family", "unlists"] {
        if !object.contains_key(key) { object.insert(key.into(), previous[key].clone()); }
    }
    for member in object.get_mut("members").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(previous) = previous["members"].as_array().and_then(|members| members.iter().find(|old| old["id"] == member["id"])) else { continue; };
        let Some(member) = member.as_object_mut() else { continue; };
        for key in ["group", "accountScope", "weight", "effort", "levels", "fast"] {
            if !member.contains_key(key) { member.insert(key.into(), previous[key].clone()); }
        }
    }
}

/// Public names cannot shadow source models or any existing alias. Collection
/// validators add their own sibling group and model-profile checks.
pub fn public_model_occupied(model: &str) -> bool {
    crate::server::core::managed_models::list().iter().any(|known| known.id.eq_ignore_ascii_case(model))
        || !crate::server::core::providers::catalog::providers_for_model(model).is_empty()
        || crate::server::core::model_rules::shared().mappings.iter().any(|mapping| mapping.alias.eq_ignore_ascii_case(model))
        || crate::server::core::custom_providers::list().iter().any(|provider| provider.get("mappings").and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| item.get("alias").and_then(Value::as_str).is_some_and(|alias| alias.eq_ignore_ascii_case(model)))))
}

fn remove_saved_group(profiles: &mut super::RoutingProfiles, id: &str) {
    if profiles.groups.remove(id).is_some() && id.starts_with("auto-") && !profiles.hidden_auto_groups.iter().any(|known| known == id) {
        profiles.hidden_auto_groups.push(id.into());
    }
    profiles.group_order.retain(|known| known != id);
}

pub fn validate(group: &RoutingGroup) -> Result<(), String> {
    fn identifier(value: &str) -> bool {
        !value.is_empty() && value.len() <= 128 && value.bytes().all(|ch| ch.is_ascii_alphanumeric() || b"-_.".contains(&ch))
    }
    if !identifier(&group.id) || group.members.iter().any(|member| !identifier(&member.id)) {
        return Err("路由组或成员标识无效".into());
    }
    if group.name.trim().is_empty() || group.name.chars().count() > 64 || group.name.chars().any(char::is_control)
        || group.description.chars().count() > 500 {
        return Err("组名不能为空或超过 64 个字符，说明不能超过 500 个字符".into());
    }
    if group.model.is_empty() || super::normalize_routing_model(&group.model)? != group.model {
        return Err("对外模型 ID 不能为空，请去掉首尾空格并使用小写英文字母".into());
    }
    if !STRATEGIES.contains(&group.strategy.as_str()) { return Err("路由策略无效".into()); }
    let mut profile = group.profile();
    profile.strategy = None;
    super::validate_routing_profile(&profile)?;
    if group.members.len() > MAX_MEMBERS { return Err(format!("一个路由组最多允许 {MAX_MEMBERS} 个成员")); }
    if group.match_patterns.len() > MAX_MEMBERS { return Err("动态成员规则数量过多".into()); }
    for pattern in &group.match_patterns { compile_pattern(pattern)?; }
    if group.first_token > 3600 || !(-1..=240).contains(&group.patience) || !(1..=60).contains(&group.classifier_timeout) {
        return Err("首内容等待最多 3600 秒，繁忙等待为 -1 到 240 秒，分类超时为 1 到 60 秒".into());
    }
    if group.context < -1 || group.context > 100_000_000 || group.family.len() > 256 || group.family.chars().any(char::is_control) {
        return Err("上下文或系列配置无效".into());
    }
    if !["", "auto"].contains(&group.effort.as_str()) { return Err("组推理模式必须为 auto 或留空".into()); }
    super::routing_rules::validate_levels(&group.levels)?;
    if group.classifier.len() > 512 || group.classifier.chars().any(char::is_control) || group.classifier.trim() != group.classifier {
        return Err("分类器模型无效".into());
    }
    let mut ids = HashSet::new();
    let mut pairs = HashSet::new();
    let mut count = 0;
    for member in &group.members {
        if !ids.insert(&member.id) || !pairs.insert((&member.provider, member.model.to_ascii_lowercase(), &member.group, &member.effort, &member.levels)) {
            return Err("同一提供商的同一模型不能重复加入，成员标识也不能重复".into());
        }
        if !member.group.is_empty() {
            if !identifier(&member.group) || !member.provider.is_empty() || !member.model.is_empty() || !member.accounts.is_empty()
                || !member.effort.is_empty() || !member.levels.is_empty() || member.fast {
                return Err("嵌套路由组只填写组标识，不可混用提供商、账号或模型参数".into());
            }
        } else if member.provider.is_empty() || member.provider.len() > 256 || member.provider.trim() != member.provider
            || member.provider.chars().any(char::is_control) || member.model.is_empty()
            || member.model.trim() != member.model || super::normalize_routing_model(&member.model).is_err() {
            return Err("成员的提供商或模型 ID 无效".into());
        }
        if member.weight == 0 || member.weight > 1000 { return Err("成员权重必须为 1 到 1000".into()); }
        super::routing_rules::validate_levels(&member.levels)?;
        if !super::routing_rules::valid_effort(&member.effort, true) || !member.effort.is_empty() && !member.levels.is_empty() {
            return Err("成员推理等级无效，固定等级与可选等级不能同时设置".into());
        }
        let unique: HashSet<_> = member.accounts.iter().collect();
        if unique.len() != member.accounts.len() || member.accounts.iter().any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)) {
            return Err("成员的参与账号为空、重复或格式不正确".into());
        }
        count += member.accounts.len();
    }
    if count > super::routing_profiles::MAX_ROUTING_ACCOUNTS { return Err("路由组的账号候选数量过多".into()); }
    if !group.pick.is_empty() && !group.members.iter().any(|member| member.id == group.pick)
        && (group.match_patterns.is_empty() || !is_dynamic_member_id(&group.pick)) {
        return Err("手动选择的成员不在组内".into());
    }
    super::routing_rules::validate_rules(group)?;
    Ok(())
}

pub fn is_dynamic_member_id(id: &str) -> bool {
    id.starts_with("match-") && id.len() == 30 && id[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn compile_pattern(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.is_empty() || pattern.len() > 512 || pattern.trim() != pattern || pattern.chars().any(char::is_control) {
        return Err("动态成员模式不能为空、超过 512 字节或含控制字符".into());
    }
    let expression = if let Some(expression) = pattern.strip_prefix("re:") {
        if expression.is_empty() { return Err("正则表达式不能为空".into()); }
        expression.to_string()
    } else { pattern.split('*').map(regex::escape).collect::<Vec<_>>().join(".*") };
    regex::RegexBuilder::new(&format!("^(?:{expression})$"))
        .case_insensitive(true).size_limit(256 * 1024).build()
        .map_err(|_| "动态成员模式不是有效的正则表达式".to_string())
}

pub fn pattern_matches(pattern: &str, model_ref: &str) -> bool {
    compile_pattern(pattern).is_ok_and(|pattern| pattern.is_match(model_ref))
}

pub fn referenced_group<'a>(reference: &str, groups: &'a BTreeMap<String, RoutingGroup>) -> Option<&'a RoutingGroup> {
    let id = reference.strip_prefix("group/").unwrap_or(reference);
    groups.get(id).or_else(|| groups.values().find(|group| group.model == reference))
}

/// Membership and classifier edges share the same cycle guard.
pub fn validate_graph(group: &RoutingGroup, groups: &BTreeMap<String, RoutingGroup>) -> Result<(), String> {
    fn walk(current: &RoutingGroup, groups: &BTreeMap<String, RoutingGroup>, stack: &mut Vec<String>, depths: &mut BTreeMap<String, usize>) -> Result<usize, String> {
        if stack.iter().any(|id| id == &current.id) { return Err(format!("路由组循环引用：{} → {}", stack.join(" → "), current.id)); }
        if let Some(depth) = depths.get(&current.id) { return Ok(*depth); }
        stack.push(current.id.clone());
        let mut depth = 1;
        for member in &current.members {
            if member.group.is_empty() { continue; }
            let child = groups.get(&member.group)
                .ok_or_else(|| format!("找不到嵌套路由组 {}", member.group))?;
            depth = depth.max(1 + walk(child, groups, stack, depths)?);
        }
        if !current.classifier.is_empty() {
            let classifier = referenced_group(&current.classifier, groups);
            if let Some(child) = classifier {
                if current.enabled && !current.hidden && (!child.enabled || child.hidden) { return Err("分类器路由组已停用".into()); }
                depth = depth.max(1 + walk(child, groups, stack, depths)?);
            } else if current.classifier.starts_with("group/") || !current.classifier.contains('/') {
                return Err("找不到分类器路由组".into());
            }
        }
        stack.pop();
        if depth > MAX_NESTING { return Err(format!("嵌套路由组最多 {MAX_NESTING} 层")); }
        depths.insert(current.id.clone(), depth);
        Ok(depth)
    }
    let mut graph = groups.clone();
    graph.insert(group.id.clone(), group.clone());
    let mut depths = BTreeMap::new();
    for current in graph.values() {
        walk(current, &graph, &mut Vec::new(), &mut depths)?;
    }
    Ok(())
}

pub(crate) fn from_value(value: Option<&Value>) -> BTreeMap<String, RoutingGroup> {
    value.and_then(Value::as_object).into_iter().flatten().take(MAX_GROUPS).filter_map(|(id, raw)| {
        let group: RoutingGroup = serde_json::from_value(raw.clone()).ok()?;
        (group.id == *id && validate(&group).is_ok()).then(|| (id.clone(), group))
    }).collect()
}

pub fn save(id: &str, group: Option<RoutingGroup>, expected: &str) -> Result<(), String> {
    save_with_groups(id, group, expected, &BTreeMap::new())
}

pub fn save_with_groups(id: &str, group: Option<RoutingGroup>, expected: &str, effective_groups: &BTreeMap<String, RoutingGroup>) -> Result<(), String> {
    if let Some(group) = &group {
        validate(group)?;
        if group.id != id { return Err("路由组标识不一致".into()); }
    }
    super::try_update_raw_field(super::KEY_ROUTING_PROFILES, |raw| {
        let mut raw_map = serde_json::Map::new();
        raw_map.insert(super::KEY_ROUTING_PROFILES.into(), raw.clone());
        let mut profiles = (*super::routing_profiles::from_raw(&raw_map)).clone();
        let mut graph: BTreeMap<_, _> = effective_groups.iter().filter(|(_, group)| group.auto
            && profiles.auto_groups_enabled && !profiles.hidden_auto_groups.contains(&group.id))
            .map(|(id, group)| (id.clone(), group.clone())).collect();
        graph.extend(profiles.groups.clone());
        let old = profiles.groups.get(id);
        if revision(old) != expected { return Err("路由配置已在其他位置修改，请刷新后重试；草稿未丢失".to_string()); }
        if let Some(group) = &group {
            if old.is_none() && profiles.groups.len() >= MAX_GROUPS { return Err("自定义路由组数量已达上限".into()); }
            if profiles.groups.values().any(|known| known.id != id && known.model.eq_ignore_ascii_case(&group.model))
                || profiles.models.contains_key(&group.model)
                || public_model_occupied(&group.model) {
                return Err("对外模型 ID 已被模型、映射或其他路由占用，请换一个名称".into());
            }
            validate_graph(group, &graph)?;
            let mut saved = group.clone();
            saved.auto = false;
            profiles.groups.insert(id.to_string(), saved);
        } else {
            if profiles.groups.values().any(|known| known.id != id && (known.members.iter().any(|member| member.group == id)
                || referenced_group(&known.classifier, &graph).is_some_and(|target| target.id == id))) {
                return Err("此路由组仍被其他组或分类器引用，请先移除引用".into());
            }
            remove_saved_group(&mut profiles, id);
        }
        *raw = json!(profiles);
        Ok(())
    }, || "路由配置落盘失败，未应用本次修改".to_string())
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    fn legacy() -> Value {
        json!({"id":"chat","name":"Chat","model":"chat-route","strategy":"order","sticky":"auto",
            "members":[{"id":"a","provider":"openai","model":"gpt-4o","included":true,"accounts":[]}]})
    }

    #[test]
    fn old_groups_do_not_gain_waits_or_unselected_accounts() {
        let group: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        let saved = serde_json::to_value(group).unwrap();
        assert_eq!(saved["enabled"], true);
        assert_eq!(saved["patience"], -1);
        assert_eq!(saved["context"], -1);
        assert_eq!(saved["members"][0]["accountScope"], "selected");
        assert_eq!(saved["members"][0]["accounts"], json!([]));
    }

    #[test]
    fn dynamic_and_nested_member_shapes_are_accepted_without_fake_provider_ids() {
        let mut raw = legacy();
        raw["strategy"] = "weight".into();
        raw["match"] = json!(["openrouter/*:free"]);
        raw["members"] = json!([{"id":"child","group":"fallback","included":true,"weight":3}]);
        let group: RoutingGroup = serde_json::from_value(raw).unwrap();
        assert!(validate(&group).is_ok());
    }

    #[test]
    fn invalid_patterns_and_dangling_rule_targets_are_rejected() {
        let mut raw = legacy();
        raw["match"] = json!(["re:["]);
        let group: RoutingGroup = serde_json::from_value(raw).unwrap();
        assert!(validate(&group).is_err());
        let mut raw = legacy();
        raw["rules"] = json!([{"use":"missing","images":true}]);
        let group: RoutingGroup = serde_json::from_value(raw).unwrap();
        assert!(validate(&group).is_err());
    }

    #[test]
    fn patterns_must_match_the_entire_ref_and_keep_variants_separate() {
        assert!(pattern_matches("openrouter/*:free", "OpenRouter/qwen:free"));
        assert!(!pattern_matches("openrouter/*:free", "openrouter/qwen:free-extra"));
        assert!(!pattern_matches("*/claude-sonnet", "relay/claude-sonnet-thinking"));
        assert!(pattern_matches("re:relay/(a|b)", "relay/b"));
    }

    #[test]
    fn nesting_and_classifier_cycles_are_rejected() {
        let mut a: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        let mut b = a.clone();
        b.id = "other".into();
        b.model = "other-route".into();
        a.members = vec![serde_json::from_value(json!({"id":"child","group":"other","included":true})).unwrap()];
        b.classifier = "group/chat".into();
        b.effort = "auto".into();
        let all = BTreeMap::from([(a.id.clone(), a.clone()), (b.id.clone(), b)]);
        assert!(validate_graph(&a, &all).is_err());
    }

    #[test]
    fn renamed_public_model_cannot_leave_a_classifier_pointing_at_the_old_name() {
        let mut target: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        let mut caller = target.clone();
        caller.id = "caller".into();
        caller.model = "caller-route".into();
        caller.classifier = target.model.clone();
        let groups = BTreeMap::from([(target.id.clone(), target.clone()), (caller.id.clone(), caller)]);
        assert!(validate_graph(&target, &groups).is_ok());
        target.model = "renamed-route".into();
        assert!(validate_graph(&target, &groups).is_err());
    }

    #[test]
    fn edits_cannot_extend_an_existing_parent_chain_past_eight_groups() {
        let mut groups = BTreeMap::new();
        for index in 0..8 {
            let mut group: RoutingGroup = serde_json::from_value(legacy()).unwrap();
            group.id = format!("level-{index}");
            group.model = group.id.clone();
            if index < 7 {
                group.members = vec![serde_json::from_value(json!({"id":"child","group":format!("level-{}", index + 1),"included":true})).unwrap()];
            }
            groups.insert(group.id.clone(), group);
        }
        assert!(validate_graph(&groups["level-7"], &groups).is_ok());
        let mut extra: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        extra.id = "level-8".into();
        extra.model = extra.id.clone();
        groups.insert(extra.id.clone(), extra);
        let mut leaf = groups["level-7"].clone();
        leaf.members = vec![serde_json::from_value(json!({"id":"child","group":"level-8","included":true})).unwrap()];
        assert!(validate_graph(&leaf, &groups).is_err());
    }

    #[test]
    fn a_dynamic_pick_requires_patterns_and_a_generated_member_identity() {
        let mut group: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        group.strategy = "manual".into();
        group.pick = "match-0123456789abcdef01234567".into();
        assert!(validate(&group).is_err());
        group.match_patterns = vec!["openai/*".into()];
        assert!(validate(&group).is_ok());
        group.pick = "match-arbitrary".into();
        assert!(validate(&group).is_err());
    }

    #[test]
    fn legacy_usage_and_strict_affinity_keep_distinct_contracts() {
        assert_eq!(super::super::RouteStrategy::from_id("usage"), super::super::RouteStrategy::Rotate);
        assert_eq!(super::super::RouteStrategy::from_id("least-used"), super::super::RouteStrategy::LeastUsed);
        assert_eq!(super::super::StickyMode::from_id("strict").ttl_ms(), Some(21_600_000));
    }

    #[test]
    fn legacy_editor_omissions_preserve_new_fields_but_explicit_resets_win() {
        let mut old: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        old.enabled = false; old.context = 42_000; old.patience = 12;
        old.members[0].weight = 5;
        old.members[0].account_scope = RoutingAccountScope::All;
        let mut raw = legacy();
        raw["context"] = 0.into();
        raw["members"][0]["weight"] = 1.into();
        preserve_omitted_fields(&mut raw, &old);
        let saved: RoutingGroup = serde_json::from_value(raw).unwrap();
        assert!(!saved.enabled);
        assert_eq!(saved.patience, 12);
        assert_eq!(saved.context, 0);
        assert_eq!(saved.members[0].weight, 1);
        assert_eq!(saved.members[0].account_scope, RoutingAccountScope::All);
    }

    #[test]
    fn deleting_a_saved_automatic_group_records_a_tombstone() {
        let mut profiles = super::super::RoutingProfiles::default();
        let mut group: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        group.id = "auto-model-0123456789ab".into();
        profiles.groups.insert(group.id.clone(), group.clone());
        profiles.group_order.push(group.id.clone());
        remove_saved_group(&mut profiles, &group.id);
        assert!(!profiles.groups.contains_key(&group.id));
        assert_eq!(profiles.hidden_auto_groups, [group.id]);
        assert!(profiles.group_order.is_empty());
    }

    #[test]
    fn disabled_imports_may_reference_disabled_classifiers_until_enabled() {
        let mut source: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        source.id = "source".into(); source.model = "source-model".into(); source.enabled = false;
        let mut caller: RoutingGroup = serde_json::from_value(legacy()).unwrap();
        caller.enabled = false; caller.classifier = source.id.clone();
        let groups = BTreeMap::from([(source.id.clone(),source)]);
        assert!(validate_graph(&caller, &groups).is_ok());
        caller.enabled = true;
        assert!(validate_graph(&caller, &groups).is_err());
    }
}
