//! Pure route decisions. The forwarding layer owns turn identity, classifier
//! calls and caching; this module neither sends requests nor advances cursors.

use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::server::config::{RoutingGroup, RoutingProfiles, RoutingRule, RoutingTimeWindow, routing_rules::{clock_minutes, weekday, LEVELS}};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestFacts {
    pub tokens: u64,
    pub images: bool,
    pub effort: String,
    pub agent: String,
    pub compact: bool,
    pub folder: String,
    /// Optional caller-supplied home for tilde expansion; no environment reads.
    pub home: String,
    pub at_ms: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Classification {
    pub intent: String,
    pub effort: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub index: usize,
    pub targets: Vec<String>,
    pub pause: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDecision {
    pub preferred: Vec<String>,
    pub excluded: Vec<String>,
    pub effort_by_member: BTreeMap<String, String>,
    pub effort: Option<String>,
    pub matched: Vec<RuleMatch>,
    pub intents: Vec<String>,
}

fn reasoning_rank(level: &str) -> Option<usize> {
    LEVELS.iter().position(|value| *value == level)
}

fn reasoning_on(level: &str) -> bool {
    !level.is_empty() && !["none", "off", "false"].contains(&level)
}

pub fn time_matches(window: &RoutingTimeWindow, at_ms: i64) -> bool {
    let Some(from) = clock_minutes(&window.from) else { return false };
    let Some(to) = clock_minutes(&window.to) else { return false };
    let Ok(timestamp) = jiff::Timestamp::from_millisecond(at_ms) else { return false };
    let zone = if window.zone.is_empty() { jiff::tz::TimeZone::system() }
        else { let Ok(zone) = jiff::tz::TimeZone::get(&window.zone) else { return false }; zone };
    let at = timestamp.to_zoned(zone);
    let minute = at.hour() as u16 * 60 + at.minute() as u16;
    let mut day = at.weekday().to_sunday_zero_offset() as u8;
    let within = if from == to { true } else if from < to { minute >= from && minute < to }
        else { if minute < to { day = (day + 6) % 7; } minute >= from || minute < to };
    within && (window.days.is_empty() || window.days.iter().any(|value| weekday(value) == Some(day)))
}

fn normalized_folder(value: &str, home: &str) -> Option<String> {
    let mut path = value.trim().replace('\\', "/");
    if path.is_empty() { return None; }
    if path == "~" || path.starts_with("~/") {
        if home.is_empty() { return None; }
        path = format!("{}{}", home.trim_end_matches(['/', '\\']), &path[1..]).replace('\\', "/");
    }
    if path.starts_with("/mnt/") && path.as_bytes().get(6) == Some(&b'/') && path.as_bytes().get(5).is_some_and(u8::is_ascii_alphabetic) {
        path = format!("{}:/{}", &path[5..6], &path[7..]);
    }
    let windows = path.as_bytes().get(1) == Some(&b':') || path.starts_with("//");
    if windows { path.make_ascii_lowercase(); }
    let absolute = path.starts_with('/');
    let unc = path.starts_with("//");
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {},
            ".." => { if parts.last().is_some_and(|part: &&str| !part.ends_with(':')) { parts.pop(); } else { return None; } },
            part => parts.push(part),
        }
    }
    let prefix = if unc { "//" } else if absolute { "/" } else { "" };
    Some(format!("{prefix}{}", parts.join("/")))
}

pub fn folder_matches(folder: &str, parent: &str, home: &str) -> bool {
    let Some(folder) = normalized_folder(folder, home) else { return false };
    let Some(parent) = normalized_folder(parent, home) else { return false };
    folder == parent || folder.strip_prefix(&parent).is_some_and(|tail| parent.ends_with('/') || tail.starts_with('/'))
}

fn matches_without_intent(rule: &RoutingRule, facts: &RequestFacts) -> bool {
    if rule.tokens > facts.tokens || rule.images && !facts.images || rule.compact && !facts.compact { return false; }
    if !rule.effort.is_empty() {
        if rule.effort == "on" { if !reasoning_on(&facts.effort) { return false; } }
        else if !reasoning_rank(&facts.effort).zip(reasoning_rank(&rule.effort)).is_some_and(|(actual, wanted)| actual >= wanted) { return false; }
    }
    if !rule.agents.is_empty() && !rule.agents.iter().any(|agent| agent.eq_ignore_ascii_case(&facts.agent)) { return false; }
    if !rule.folders.is_empty() && !rule.folders.iter().any(|folder| folder_matches(&facts.folder, folder, &facts.home)) { return false; }
    if rule.except_folders.iter().any(|folder| folder_matches(&facts.folder, folder, &facts.home)) { return false; }
    rule.time.as_ref().is_none_or(|window| time_matches(window, facts.at_ms))
}

pub fn required_intents(group: &RoutingGroup, facts: &RequestFacts) -> Vec<String> {
    let mut result = Vec::new();
    if group.strategy == "manual" { return result; }
    for rule in &group.rules {
        if !rule.pause && !rule.intent.is_empty() && matches_without_intent(rule, facts) && !result.contains(&rule.intent) {
            result.push(rule.intent.clone());
        }
    }
    result
}

fn explanations(rule: &RoutingRule) -> Vec<String> {
    let mut result = Vec::new();
    if rule.tokens > 0 { result.push(format!("请求至少 {} tokens", rule.tokens)); }
    if rule.images { result.push("请求包含图片".into()); }
    if !rule.effort.is_empty() { result.push(format!("推理等级满足 {}", rule.effort)); }
    if !rule.agents.is_empty() { result.push(format!("客户端：{}", rule.agents.join(" / "))); }
    if !rule.intent.is_empty() { result.push(format!("意图：{}", rule.intent)); }
    if rule.compact { result.push("上下文压缩请求".into()); }
    if let Some(time) = &rule.time { result.push(format!("时间：{}–{} {}", time.from, time.to, time.zone)); }
    if !rule.folders.is_empty() { result.push("位于指定工作目录".into()); }
    if !rule.except_folders.is_empty() { result.push("不在排除工作目录".into()); }
    result
}

pub fn evaluate(group: &RoutingGroup, facts: &RequestFacts, classification: Option<&Classification>) -> RuleDecision {
    let mut result = RuleDecision {intents: required_intents(group, facts), ..Default::default()};
    if !group.enabled || group.hidden { return result; }
    if group.effort == "auto" && reasoning_on(&facts.effort) && group.strategy != "manual" {
        result.effort = classification.filter(|value| reasoning_rank(&value.effort).is_some()).map(|value| value.effort.clone());
    }
    for (index, rule) in group.rules.iter().enumerate() {
        if group.strategy == "manual" && !rule.pause { continue; }
        if !matches_without_intent(rule, facts) || !rule.intent.is_empty()
            && !classification.is_some_and(|value| value.intent.eq_ignore_ascii_case(&rule.intent)) { continue; }
        let targets: Vec<String> = rule.targets().map(str::to_string).collect();
        let list = if rule.pause { &mut result.excluded } else { &mut result.preferred };
        for target in &targets {
            if !list.contains(target) { list.push(target.clone()); }
            if !rule.pause && !rule.use_effort.is_empty() {
                result.effort_by_member.entry(target.clone()).or_insert_with(|| rule.use_effort.clone());
            }
        }
        result.matched.push(RuleMatch {index, targets, pause:rule.pause, reasons:explanations(rule)});
    }
    result.preferred.retain(|target| !result.excluded.contains(target));
    result.effort_by_member.retain(|target, _| !result.excluded.contains(target));
    result
}

/// Resolve each policy represented by the candidate paths. The draft outer group
/// wins over its saved version so management preview and forwarding agree.
pub fn projection_groups(group: &RoutingGroup, profiles: &RoutingProfiles, accounts: &[Value]) -> Vec<RoutingGroup> {
    let mut ids: Vec<_> = accounts.iter().flat_map(|account| account.get("routingStrategyPath").and_then(Value::as_array)
        .into_iter().flatten().filter_map(|policy| policy.get("groupId").and_then(Value::as_str)).map(str::to_string)).collect();
    ids.push(group.id.clone()); ids.sort(); ids.dedup();
    ids.into_iter().filter_map(|id| if id == group.id { Some(group.clone()) } else { profiles.groups.get(&id).cloned() }).collect()
}

/// Apply nested decisions to candidate copies. Returns rejected rows for trace;
/// account IDs and credential data are never changed.
pub fn apply_decisions(accounts: &mut Vec<Value>, decisions: &BTreeMap<String, RuleDecision>) -> Vec<Value> {
    let mut blocked = Vec::new();
    accounts.retain_mut(|account| {
        let mut ranks = Vec::new();
        let mut effort = None;
        for policy in account.get("routingStrategyPath").and_then(Value::as_array).into_iter().flatten() {
            let group = policy.get("groupId").and_then(Value::as_str).unwrap_or("");
            let member = policy.get("memberId").and_then(Value::as_str).unwrap_or("");
            if let Some(decision) = decisions.get(group) {
                if decision.excluded.iter().any(|target| target == member) {
                    blocked.push(json!({"id":super::routing::account_id(account),"candidateId":super::routing_groups::attempt_key(account),
                        "state":"paused","reason":"请求命中暂停规则","groupId":group,"memberId":member}));
                    return false;
                }
                ranks.push(decision.preferred.iter().position(|target| target == member).map(|rank| rank as u64).unwrap_or(u64::MAX));
                if let Some(level) = decision.effort_by_member.get(member).cloned().or_else(|| decision.effort.clone()) { effort = Some(level); }
            } else { ranks.push(u64::MAX); }
        }
        account["routingRulePath"] = json!(ranks);
        if let Some(object) = account.as_object_mut() { object.remove("routingRuleEffort"); }
        if let Some(effort) = effort { account["routingRuleEffort"] = effort.into(); }
        true
    });
    blocked
}

/// Management preview deliberately reads no runtime cache and makes no calls.
pub fn preview_rules(group: &RoutingGroup, profiles: &RoutingProfiles, accounts: &mut Vec<Value>, facts: &RequestFacts,
    classification: Option<&Classification>) -> Vec<Value> {
    let mut decisions = BTreeMap::new();
    let mut trace = Vec::new();
    for group in projection_groups(group, profiles, accounts) {
        let decision = evaluate(&group, facts, classification);
        trace.push(json!({"groupId":group.id,"cached":false,"decision":decision,
            "classifier":{"state":if classification.is_some() {"provided-for-preview"} else {"not-called-in-preview"}}}));
        decisions.insert(group.id, decision);
    }
    let _ = apply_decisions(accounts, &decisions);
    trace
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(rules: Value) -> RoutingGroup {
        serde_json::from_value(json!({"id":"route","name":"Route","model":"route","strategy":"order","sticky":"auto",
            "members":[{"id":"small","provider":"p","model":"small","included":true,"accounts":[]},
                       {"id":"large","provider":"p","model":"large","included":true,"accounts":[]}],"rules":rules})).unwrap()
    }

    #[test]
    fn rule_conditions_are_conjunctive_and_fallback_targets_are_ordered_once() {
        let g = group(json!([{"use":"large","tokens":1000,"images":true,"useEffort":"high"},
                            {"use":"small","effort":"high","more":["large"]}]));
        let facts = RequestFacts {tokens:1000, images:true, effort:"high".into(), ..Default::default()};
        let found = evaluate(&g, &facts, None);
        assert_eq!(found.preferred, ["large", "small"]);
        assert_eq!(found.effort_by_member.get("large").map(String::as_str), Some("high"));
        let found = evaluate(&g, &RequestFacts {images:false, ..facts}, None);
        assert_eq!(found.preferred, ["small", "large"]);
    }

    #[test]
    fn failed_classification_does_not_match_an_intent_or_override_effort() {
        let mut g = group(json!([{"use":"large","intent":"hard task"}]));
        g.effort = "auto".into();
        let facts = RequestFacts {effort:"high".into(), ..Default::default()};
        let absent = evaluate(&g, &facts, None);
        assert!(absent.preferred.is_empty());
        assert!(absent.effort.is_none());
        let found = evaluate(&g, &facts, Some(&Classification {intent:"hard task".into(), effort:"medium".into()}));
        assert_eq!(found.preferred, ["large"]);
        assert_eq!(found.effort.as_deref(), Some("medium"));
    }

    #[test]
    fn friday_window_continues_into_saturday_in_its_own_zone() {
        let g = group(json!([{"use":"large","pause":true,"time":{"from":"22:00","to":"08:00","days":["fri"],"zone":"Asia/Shanghai"}}]));
        // 2026-11-06 17:00 UTC is Saturday 01:00 in Shanghai.
        let at_ms = "2026-11-06T17:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond();
        assert_eq!(evaluate(&g, &RequestFacts {at_ms, ..Default::default()}, None).excluded, ["large"]);
        let at_ms = "2026-11-07T01:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond();
        assert!(evaluate(&g, &RequestFacts {at_ms, ..Default::default()}, None).excluded.is_empty());
    }

    #[test]
    fn folders_match_descendants_without_matching_sibling_prefixes() {
        let g = group(json!([{"use":"large","folders":["C:\\work"]},
                            {"use":"small","pause":true,"exceptFolders":["C:\\work"]}]));
        let in_work = RequestFacts {folder:"/mnt/c/work/app".into(), ..Default::default()};
        assert_eq!(evaluate(&g, &in_work, None).preferred, ["large"]);
        assert!(evaluate(&g, &in_work, None).excluded.is_empty());
        let sibling = RequestFacts {folder:"C:/work-other".into(), ..Default::default()};
        assert!(evaluate(&g, &sibling, None).preferred.is_empty());
        assert_eq!(evaluate(&g, &sibling, None).excluded, ["small"]);
        assert_eq!(evaluate(&g, &RequestFacts::default(), None).excluded, ["small"]);
    }

    #[test]
    fn paused_targets_never_survive_a_matched_preference() {
        let g = group(json!([{"use":"large","images":true},
                            {"use":"large","pause":true,"agents":["codex"]}]));
        let found = evaluate(&g, &RequestFacts {images:true, agent:"codex".into(), ..Default::default()}, None);
        assert!(found.preferred.is_empty());
        assert_eq!(found.excluded, ["large"]);
    }

    #[test]
    fn preview_applies_nested_preferences_and_pause_without_a_classifier_call() {
        let outer = group(json!([{"use":"large","images":true}]));
        let mut child = group(json!([{"use":"small","agents":["codex"],"useEffort":"low"},
            {"use":"large","pause":true,"agents":["codex"]}]));
        child.id = "child".into();
        let profiles = crate::server::config::RoutingProfiles {groups:BTreeMap::from([("child".into(),child)]),..Default::default()};
        let mut accounts = vec![json!({"id":"a","routingStrategyPath":[{"groupId":"route","memberId":"large"},{"groupId":"child","memberId":"small"}]}),
            json!({"id":"b","routingStrategyPath":[{"groupId":"route","memberId":"large"},{"groupId":"child","memberId":"large"}]})];
        let trace = preview_rules(&outer, &profiles, &mut accounts, &RequestFacts {images:true,agent:"codex".into(),..Default::default()}, None);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["routingRulePath"], json!([0,0]));
        assert_eq!(accounts[0]["routingRuleEffort"], "low");
        assert_eq!(trace.len(), 2);
    }
}
