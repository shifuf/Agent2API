//! Saved routing conditions. Validation is independent of request execution.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use super::RoutingGroup;

pub const LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingTimeWindow {
    pub from: String,
    pub to: String,
    #[serde(default)] pub days: Vec<String>,
    #[serde(default)] pub zone: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutingRule {
    #[serde(rename = "use")] pub use_member: String,
    #[serde(default)] pub more: Vec<String>,
    #[serde(default)] pub use_effort: String,
    #[serde(default)] pub tokens: u64,
    #[serde(default)] pub images: bool,
    #[serde(default)] pub effort: String,
    #[serde(default)] pub agents: Vec<String>,
    #[serde(default)] pub intent: String,
    #[serde(default)] pub compact: bool,
    #[serde(default)] pub time: Option<RoutingTimeWindow>,
    #[serde(default)] pub folders: Vec<String>,
    #[serde(default)] pub except_folders: Vec<String>,
    #[serde(default)] pub pause: bool,
}

impl RoutingRule {
    pub fn targets(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.use_member.as_str()).chain(self.more.iter().map(String::as_str))
    }
}

pub fn valid_effort(value: &str, empty: bool) -> bool {
    empty && value.is_empty() || LEVELS.contains(&value)
}

pub fn validate_levels(levels: &[String]) -> Result<(), String> {
    let mut previous = None;
    for level in levels {
        let Some(rank) = LEVELS.iter().position(|known| known == level) else { return Err("推理等级无效".into()) };
        if previous.is_some_and(|prior| prior >= rank) { return Err("推理等级需由低到高排列且不重复".into()); }
        previous = Some(rank);
    }
    Ok(())
}

pub fn clock_minutes(value: &str) -> Option<u16> {
    if value.len() != 5 || !value.is_ascii() || value.as_bytes()[2] != b':'
        || !value[..2].bytes().chain(value[3..].bytes()).all(|byte| byte.is_ascii_digit()) { return None; }
    let hour = value[..2].parse::<u16>().ok()?;
    let minute = value[3..].parse::<u16>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

pub fn weekday(value: &str) -> Option<u8> {
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].iter().position(|day| *day == value).map(|day| day as u8)
}

fn validate_strings(values: &[String], max: usize) -> bool {
    let mut seen = HashSet::new();
    values.len() <= 64 && values.iter().all(|value| !value.is_empty() && value.len() <= max
        && value.trim() == value && !value.chars().any(char::is_control) && seen.insert(value))
}

pub fn validate_rules(group: &RoutingGroup) -> Result<(), String> {
    if group.rules.len() > 128 { return Err("一个路由组最多允许 128 条规则".into()); }
    let members: HashSet<_> = group.members.iter().map(|member| member.id.as_str()).collect();
    for rule in &group.rules {
        let mut targets = HashSet::new();
        for target in rule.targets() {
            let dynamic = !group.match_patterns.is_empty() && super::routing_groups::is_dynamic_member_id(target);
            if (!members.contains(target) && !dynamic) || !targets.insert(target) {
                return Err("规则目标不在组内或重复".into());
            }
        }
        if rule.more.len() > 255 || rule.tokens > 100_000_000 || !valid_effort(&rule.use_effort, true)
            || !(valid_effort(&rule.effort, true) || rule.effort == "on") {
            return Err("规则的目标数量、token 或推理等级无效".into());
        }
        if !validate_strings(&rule.agents, 128) || !validate_strings(&rule.folders, 4096) || !validate_strings(&rule.except_folders, 4096) {
            return Err("规则客户端或工作目录包含无效、重复或过多条目".into());
        }
        if rule.intent.chars().count() > 200 || rule.intent.trim() != rule.intent || rule.intent.chars().any(char::is_control) {
            return Err("意图说明最多 200 字且不能含首尾空白或控制字符".into());
        }
        if rule.tokens == 0 && !rule.images && rule.effort.is_empty() && rule.agents.is_empty() && rule.intent.is_empty()
            && !rule.compact && rule.time.is_none() && rule.folders.is_empty() && rule.except_folders.is_empty() {
            return Err("每条规则至少需要一个条件".into());
        }
        if rule.pause && (rule.tokens != 0 || rule.images || !rule.effort.is_empty() || !rule.intent.is_empty()
            || rule.compact || !rule.more.is_empty() || !rule.use_effort.is_empty()) {
            return Err("暂停规则只接受时间、客户端与工作目录条件，并且只暂停一个成员".into());
        }
        if let Some(window) = &rule.time {
            let mut days = HashSet::new();
            if clock_minutes(&window.from).is_none() || clock_minutes(&window.to).is_none()
                || window.days.iter().any(|day| weekday(day).is_none() || !days.insert(day))
                || window.zone.len() > 128 || !window.zone.is_empty() && jiff::tz::TimeZone::get(&window.zone).is_err() {
                return Err("时间规则的时刻、星期或 IANA 时区无效".into());
            }
        }
    }
    if (group.effort == "auto" || group.rules.iter().any(|rule| !rule.intent.is_empty())) && group.classifier.is_empty() {
        return Err("意图规则和自动推理需要分类器模型".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_time_and_unsorted_levels_are_refused() {
        assert_eq!(clock_minutes("23:59"), Some(1439));
        for value in ["24:00", "1:00", "12:60", "12-00", "中:00", "+1:00", "12:+1"] { assert_eq!(clock_minutes(value), None); }
        assert!(validate_levels(&["low".into(), "high".into()]).is_ok());
        assert!(validate_levels(&["high".into(), "low".into()]).is_err());
        assert!(validate_levels(&["low".into(), "low".into()]).is_err());
    }
}
