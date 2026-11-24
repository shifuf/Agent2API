//! Adapted from fixed upstream 33f5e797 tasks/settings.rs; retain local durable
//! save errors and the published growthSchedule markers under one CONFIG write.
use serde_json::{json, Map, Value};
use super::Definition;
use crate::server::config;

const KEY: &str = "pluginTaskSettings";

pub(super) fn from_raw(raw: &Map<String, Value>, provider: &str, original: &Definition) -> Definition {
    let mut task = original.clone();
    if let Some(key) = &task.legacy_config.clone() { apply(&mut task, raw.get(key)); }
    apply(&mut task, raw.get(KEY).and_then(|all| all.get(provider)).and_then(|items| items.get(&original.id)));
    if original.legacy_config.as_ref().and_then(|key| raw.get(key)).and_then(|value| value.get("enabled")) == Some(&Value::Bool(false)) {
        task.enabled = false;
    }
    task.times.sort(); task.times.dedup();
    task
}

fn apply(task: &mut Definition, value: Option<&Value>) {
    let Some(value) = value else { return };
    if let Some(enabled) = value["enabled"].as_bool() { task.enabled = enabled; }
    if let Some(items) = value["times"].as_array() {
        let mut times: Vec<_> = items.iter().filter_map(Value::as_str)
            .filter_map(super::super::super::schedules::normalize_time).collect();
        times.sort(); times.dedup();
        if !times.is_empty() { task.times = times; task.interval_ms = None; }
    }
}

fn merge(value: &mut Value, patch: &Value) -> Result<(), String> {
    if value.is_null() { *value = json!({}); }
    let fields = value.as_object_mut().ok_or("已有任务配置格式无效，未覆盖")?;
    for (key, value) in patch.as_object().ok_or("任务设置无效")? { fields.insert(key.clone(), value.clone()); }
    Ok(())
}

pub(super) fn save(provider: &str, task: &Definition, patch: &Value) -> Result<(), String> {
    let mut patch = patch.clone();
    if let Some(items) = patch.get("times").and_then(Value::as_array) {
        let mut times = items.iter().filter_map(Value::as_str).filter_map(super::super::super::schedules::normalize_time).collect::<Vec<_>>();
        times.sort(); times.dedup();
        patch["times"] = json!(times);
    }
    config::try_update_raw(|raw| {
        let effective = from_raw(raw, provider, task);
        let patch = if task.legacy_config.is_some() {
            let mut next = effective.clone();
            apply(&mut next, Some(&patch));
            json!({ "enabled": next.enabled, "times": next.times })
        } else { patch };
        let all = raw.entry(KEY).or_insert_with(|| json!({}));
        let providers = all.as_object_mut().ok_or("任务设置格式无效，未覆盖")?;
        let provider_value = providers.entry(provider).or_insert_with(|| json!({}));
        let tasks = provider_value.as_object_mut().ok_or("提供商任务设置格式无效，未覆盖")?;
        merge(tasks.entry(&task.id).or_insert(Value::Null), &patch)?;
        if let Some(key) = &task.legacy_config {
            let legacy = raw.entry(key).or_insert_with(|| json!({}));
            // The published old UI clears only its planned-window dedup marks
            // when the user actually changes the configured times.
            if patch.get("times").is_some_and(|times| times != &json!(effective.times)) {
                let fields = legacy.as_object_mut().ok_or("已有旅行配置格式无效，未覆盖")?;
                fields.insert("lastFiredDate".into(), Value::Null);
                fields.insert("lastFiredTime".into(), Value::Null);
                fields.remove("firedTimes");
            }
            merge(legacy, &patch)?;
        }
        Ok(())
    })
}

pub(super) fn legacy_fired(task: &Definition, planned_at: i64) -> bool {
    let Some(key) = &task.legacy_config else { return false };
    let Some(offset) = chrono::FixedOffset::east_opt(task.utc_offset_minutes * 60) else { return true };
    let Some(local) = chrono::DateTime::from_timestamp_millis(planned_at).map(|at| at.with_timezone(&offset)) else { return true };
    let date = local.format("%Y-%m-%d").to_string();
    let time = local.format("%H:%M").to_string();
    config::with_raw(|raw| raw.get(key).is_some_and(|value| value["lastFiredDate"] == date
        && value["firedTimes"].as_array().is_some_and(|times| times.iter().any(|value| value == &time)))).unwrap_or(true)
}

pub(super) fn remember_legacy(task: &Definition, planned_at: i64, result: &Value) -> Result<(), String> {
    let Some(key) = &task.legacy_config else { return Ok(()) };
    let now = crate::server::core::beijing::now();
    let planned = chrono::DateTime::from_timestamp_millis(planned_at).map(|at| at.with_timezone(now.offset()));
    let date = planned.as_ref().unwrap_or(&now).format("%Y-%m-%d").to_string();
    let time = planned.filter(|_| planned_at > 0).map(|at| at.format("%H:%M").to_string());
    config::try_update_raw_field(key, |value| {
        if value.is_null() { *value = json!({}); }
        let fields = value.as_object_mut().ok_or("旅行记录格式无效")?;
        let mut fired = if fields.get("lastFiredDate") == Some(&json!(date)) {
            fields.get("firedTimes").and_then(Value::as_array).cloned().unwrap_or_default()
        } else { Vec::new() };
        if let Some(time) = time { if !fired.contains(&json!(time)) { fired.push(json!(time)); } }
        fields.insert("lastFiredDate".into(), json!(date));
        fields.insert("lastFiredTime".into(), json!(now.format("%H:%M").to_string()));
        fields.insert("firedTimes".into(), json!(fired));
        fields.insert("lastResult".into(), result.clone());
        Ok(())
    }, || "旅行结果保存失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn travel() -> Definition {
        serde_json::from_value(json!({"id":"travel","label":"猫猫旅行巡检","enabled":true,
            "times":["09:00","21:00"],"utc_offset_minutes":480,"legacy_config":"growthSchedule"})).unwrap()
    }

    #[test]
    fn partial_overrides_keep_legacy_fields_and_sort_calendar_times() {
        let raw = json!({"growthSchedule":{"enabled":true,"times":["21:00","08:00","8:00"]},
            "pluginTaskSettings":{"workbuddy":{"travel":{"enabled":true}}}});
        let effective = from_raw(raw.as_object().unwrap(), "workbuddy", &travel());
        assert!(effective.enabled);
        assert_eq!(effective.times, ["08:00", "21:00"]);
        let raw = json!({"growthSchedule":{"enabled":false,"times":["18:00"]},
            "pluginTaskSettings":{"workbuddy":{"travel":{"times":["08:00"],"enabled":true}}}});
        let effective = from_raw(raw.as_object().unwrap(), "workbuddy", &travel());
        assert!(!effective.enabled, "the legacy master switch continues to stop the task");
        assert_eq!(effective.times, ["08:00"]);
    }

    #[test]
    fn calendar_next_slot_uses_latest_definition_without_execution_time_drift() {
        // 2026-11-24 10:00 in UTC+8; an 08:00 task finishing 17 minutes late
        // must keep tomorrow's 08:00 rather than add 24 hours to completion.
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-24T10:17:00+08:00").unwrap().timestamp_millis();
        let raw = json!({"growthSchedule":{"enabled":true,"times":["18:00"]},
            "pluginTaskSettings":{"workbuddy":{"travel":{"times":["08:00"]}}}});
        let latest = from_raw(raw.as_object().unwrap(), "workbuddy", &travel());
        let (_, delay, planned) = super::super::interval(&latest, now);
        assert_eq!(planned, chrono::DateTime::parse_from_rfc3339("2026-11-24T08:00:00+08:00").unwrap().timestamp_millis());
        assert_eq!(now + delay, chrono::DateTime::parse_from_rfc3339("2026-11-25T08:00:00+08:00").unwrap().timestamp_millis());
    }
}
