//! Public login wait facts shared by the shell's existing polling paths.
//! A finished managed task is successful only after a confirmed account save.

use serde_json::{json, Map, Value};

const INVALID_WAIT: &str = "托管登录状态与本次流程不一致，未宣布登录成功";
const UNCONFIRMED: &str = "账号保存未确认，请查询本次状态；不会再次保存。";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq)]
pub(super) enum Outcome {
    Pending(Option<String>, Option<Value>),
    Done(Value),
    Failed(String, Option<Value>),
    Canceled(Value),
    Unreachable(String),
}

#[derive(Clone, Copy)]
pub(super) struct Owner<'a> {
    pub flow: &'a str,
    pub provider: Option<&'a str>,
    pub method_index: Option<u64>,
    pub managed: Option<bool>,
}

pub(super) fn classify(value: Value, owner: Owner<'_>) -> Outcome {
    let mut found = Vec::new();
    let mut wrappers = Vec::new();
    inspect(&value, 0, &mut found, &mut wrappers);
    if found.len() > 1 || owner.managed == Some(true) && found.is_empty()
        || owner.managed == Some(false) && !found.is_empty()
    {
        return Outcome::Failed(INVALID_WAIT.into(), None);
    }
    if let Some(record) = found.first() {
        return match managed(record, &wrappers, owner) {
            Ok(outcome) => outcome,
            Err(()) => Outcome::Failed(INVALID_WAIT.into(), None),
        };
    }
    // Keep the ordinary providers' established pending/error behavior.
    if value.get("pending").and_then(Value::as_bool) == Some(true)
        || value.get("pending").is_some_and(Value::is_object)
        || value.get("done").and_then(Value::as_bool) != Some(true)
    {
        let hint = value.get("hint").or_else(|| value.pointer("/pending/hint"))
            .and_then(Value::as_str).map(str::to_string);
        return Outcome::Pending(hint, None);
    }
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Outcome::Failed(error.to_string(), None);
    }
    Outcome::Done(value)
}

fn inspect<'a>(value: &'a Value, depth: u8, found: &mut Vec<&'a Map<String, Value>>,
    wrappers: &mut Vec<&'a Map<String, Value>>) {
    let Some(record) = value.as_object().filter(|_| depth <= 3) else { return; };
    wrappers.push(record);
    if record.get("managedLogin").and_then(Value::as_bool) == Some(true) { found.push(record); }
    for key in ["data", "payload", "session"] {
        if let Some(nested) = record.get(key) { inspect(nested, depth + 1, found, wrappers); }
    }
}

fn id(value: Option<&Value>, limit: usize) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty() && text.len() <= limit
        && text.trim() == *text && !text.chars().any(char::is_control))
}

fn optional_text(record: &Map<String, Value>, key: &str) -> Result<Option<String>, ()> {
    match record.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.len() <= 8192 => Ok(Some(text.clone())),
        _ => Err(()),
    }
}

fn optional_bool(record: &Map<String, Value>, key: &str) -> Result<Option<bool>, ()> {
    match record.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(()),
    }
}

fn managed(record: &Map<String, Value>, wrappers: &[&Map<String, Value>], owner: Owner<'_>) -> Result<Outcome, ()> {
    let provider = id(record.get("provider"), 128).ok_or(())?;
    let flow = id(record.get("flow"), 512).ok_or(())?;
    let method_index = record.get("methodIndex").and_then(Value::as_u64).filter(|value| *value <= MAX_SAFE_INTEGER).ok_or(())?;
    if flow != owner.flow || owner.provider.is_some_and(|expected| expected != provider)
        || owner.method_index.is_some_and(|expected| expected != method_index) { return Err(()); }
    let phase = record.get("phase").and_then(Value::as_str).ok_or(())?;
    let (terminal, expected_saved) = match phase {
        "waiting" => (false, json!(false)),
        "saving" => (false, Value::Null),
        "saved" => (true, json!(true)),
        "failed" | "canceled" => (true, json!(false)),
        "unconfirmed" => (true, Value::Null),
        _ => return Err(()),
    };
    let pending = optional_bool(record, "pending")?;
    let done = optional_bool(record, "done")?;
    if record.get("saved") != Some(&expected_saved)
        || terminal && (done != Some(true) || pending == Some(true))
        || !terminal && (pending != Some(true) || done == Some(true))
        || wrappers.iter().any(|wrapper| wrapper.get("success") == Some(&json!(false))
            || phase == "saved" && wrapper.get("ok") == Some(&json!(false))) { return Err(()); }
    let error = optional_text(record, "error")?;
    if error.as_ref().is_some_and(|error| !error.is_empty()) && matches!(phase, "waiting" | "saving" | "saved") { return Err(()); }
    let hint = optional_text(record, "hint")?;
    let instructions = optional_text(record, "instructions")?;
    let mut public = json!({ "managedLogin": true, "provider": provider, "flow": flow, "methodIndex": method_index,
        "phase": phase, "saved": expected_saved });
    if let Some(pending) = pending { public["pending"] = json!(pending); }
    if let Some(done) = done { public["done"] = json!(done); }
    if let Some(text) = &instructions { public["instructions"] = json!(text); }
    if let Some(text) = &hint { public["hint"] = json!(text); }
    if let Some(text) = &error { public["error"] = json!(text); }
    if phase == "saved" {
        let summary = record.get("session").and_then(Value::as_object).ok_or(())?;
        if summary.get("provider").and_then(Value::as_str) != Some(provider)
            || id(summary.get("accountUid"), 512).is_none() && id(summary.get("accountId"), 512).is_none() { return Err(()); }
        let mut session = json!({ "provider": provider });
        for key in ["accountUid", "accountId"] {
            match summary.get(key) {
                None | Some(Value::Null) => {},
                Some(value) => { session[key] = json!(id(Some(value), 512).ok_or(())?); }
            }
        }
        for (key, limit) in [("nickname", 512), ("edition", 512), ("warning", 8192)] {
            if let Some(text) = summary.get(key).and_then(Value::as_str).filter(|text| text.len() <= limit) {
                session[key] = json!(text);
            }
        }
        if let Some(saved) = summary.get("proxySaved").and_then(Value::as_bool) { session["proxySaved"] = json!(saved); }
        public["session"] = session;
        return Ok(Outcome::Done(public));
    }
    Ok(match phase {
        "waiting" | "saving" => Outcome::Pending(hint, Some(public)),
        "canceled" => Outcome::Canceled(public),
        "unconfirmed" => Outcome::Failed(UNCONFIRMED.into(), Some(public)),
        _ => Outcome::Failed(error.filter(|text| !text.is_empty())
            .unwrap_or_else(|| "托管登录未确认保存账号，未宣布登录成功".into()), Some(public)),
    })
}

/// Compute the one original budget before opening a window or waiting. Later
/// progress updates only subtract elapsed monotonic time from that deadline.
pub(super) fn start_budget_ms(started: &Value, now_ms: u64, limit_ms: u64) -> Result<u64, &'static str> {
    let mut remaining = limit_ms;
    for key in ["remainingMs", "timeoutMs"] {
        if let Some(value) = started.get(key) {
            let value = value.as_u64().filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or("后端返回的登录期限无效")?;
            remaining = remaining.min(value);
        }
    }
    for key in ["expiresAt", "deadline"] {
        if let Some(value) = started.get(key) {
            let value = value.as_u64().filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER)
                .ok_or("后端返回的登录期限无效")?;
            remaining = remaining.min(value.saturating_sub(now_ms));
        }
    }
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner() -> Owner<'static> {
        Owner { flow: "managed_original", provider: Some("catpaw"), method_index: Some(2), managed: Some(true) }
    }

    fn wait(phase: &str, saved: Value) -> Value {
        let pending = matches!(phase, "waiting" | "saving");
        let mut value = json!({ "managedLogin": true, "provider": "catpaw", "flow": "managed_original",
            "methodIndex": 2, "phase": phase, "saved": saved, "pending": pending, "done": !pending });
        if phase == "saved" {
            value["session"] = json!({ "provider": "catpaw", "accountId": "account-original", "nickname": "Visible name" });
        }
        value
    }

    fn rejected(value: Value) -> bool {
        matches!(classify(value, owner()), Outcome::Failed(_, None))
    }

    #[test]
    fn managed_finish_requires_confirmed_save_and_original_account_summary() {
        assert!(rejected(wait("saved", json!(false))));
        let mut value = wait("saved", json!(true));
        value["session"] = json!({ "provider": "catpaw", "nickname": "Nickname alone is not a saved account" });
        assert!(rejected(value));
        let value = wait("saved", json!(true));
        assert!(matches!(classify(value, owner()), Outcome::Done(_)));
    }

    #[test]
    fn failed_or_unconfirmed_save_never_becomes_done_success() {
        let value = wait("unconfirmed", Value::Null);
        let Outcome::Failed(message, Some(progress)) = classify(value, owner()) else {
            panic!("a terminal uncertain save must remain an explicit failed save fact");
        };
        assert!(!message.is_empty());
        assert_eq!(progress["saved"], Value::Null);
        assert_eq!(progress["phase"], "unconfirmed");
        assert!(progress.get("session").is_none());
        assert!(matches!(classify(wait("failed", json!(false)), owner()), Outcome::Failed(_, Some(_))));
    }

    #[test]
    fn task_and_method_identity_cannot_change_during_shell_polling() {
        for (key, replacement) in [("flow", json!("managed_replacement")), ("provider", json!("trae")), ("methodIndex", json!(3))] {
            let mut value = wait("saved", json!(true));
            value[key] = replacement;
            assert!(rejected(value), "accepted changed {key}");
        }
        assert!(rejected(json!({ "done": true, "session": { "accountId": "previous-account" } })));
    }

    #[test]
    fn nested_wait_fact_cannot_be_overridden_by_outer_ok_or_conflicting_record() {
        let saved = wait("saved", json!(true));
        assert!(matches!(classify(json!({ "ok": true, "payload": saved }), owner()), Outcome::Done(_)));
        assert!(rejected(json!({ "ok": false, "payload": wait("saved", json!(true)) })));
        assert!(rejected(json!({ "success": false, "payload": wait("saved", json!(true)) })));
        assert!(rejected(json!({ "payload": wait("saved", json!(true)), "data": wait("unconfirmed", Value::Null) })));
    }

    #[test]
    fn malformed_state_is_rejected_before_projecting_or_announcing_success() {
        for value in [
            wait("saved", Value::Null), wait("saving", json!(false)), wait("unconfirmed", json!(true)),
            wait("unknown", json!(false)),
            { let mut value = wait("saved", json!(true)); value["pending"] = json!(true); value },
            { let mut value = wait("waiting", json!(false)); value["done"] = json!(true); value },
            { let mut value = wait("saved", json!(true)); value["error"] = json!("not saved"); value },
            { let mut value = wait("saved", json!(true)); value["methodIndex"] = json!(2.5); value },
            { let mut value = wait("saved", json!(true)); value["session"]["provider"] = json!("other"); value },
        ] { assert!(rejected(value)); }
    }

    #[test]
    fn managed_wait_progress_and_summary_do_not_export_credentials() {
        let mut value = wait("saved", json!(true));
        value["accessToken"] = json!("private-top-level-test-value");
        value["session"]["accessToken"] = json!("private-summary-test-value");
        value["session"]["source"] = json!({ "credentials": "private-test-value" });
        let Outcome::Done(value) = classify(value, owner()) else { panic!("valid saved response rejected"); };
        assert!(value.get("accessToken").is_none());
        assert!(value["session"].get("accessToken").is_none());
        assert!(value["session"].get("source").is_none());
        let mut value = wait("saving", Value::Null);
        value["hint"] = json!("Saving in progress");
        let Outcome::Pending(Some(hint), Some(value)) = classify(value, owner()) else { panic!("saving lost its fact"); };
        assert_eq!(hint, "Saving in progress");
        assert_eq!(value["saved"], Value::Null);
    }

    #[test]
    fn canceled_fact_remains_canceled_and_cannot_import_an_old_session() {
        let mut value = wait("canceled", json!(false));
        value["session"] = json!({ "accountUid": "old-account", "provider": "catpaw" });
        let Outcome::Canceled(value) = classify(value, owner()) else { panic!("cancellation reported as success"); };
        assert_eq!(value["saved"], false);
        assert!(value.get("session").is_none());
    }

    #[test]
    fn ordinary_wait_keeps_existing_pending_and_error_contract() {
        let owner = Owner { managed: Some(false), provider: None, method_index: None, flow: "ordinary" };
        assert_eq!(classify(json!({ "pending": { "hint": "Waiting" } }), owner), Outcome::Pending(Some("Waiting".into()), None));
        assert_eq!(classify(json!({ "done": true, "error": "Original error" }), owner), Outcome::Failed("Original error".into(), None));
        assert_eq!(classify(json!({ "done": true, "session": { "accountUid": "account" } }), owner), Outcome::Done(json!({ "done": true, "session": { "accountUid": "account" } })));
    }

    #[test]
    fn original_start_deadline_is_bounded_and_cannot_be_reset_by_longer_values() {
        assert_eq!(start_budget_ms(&json!({ "remainingMs": 2500 }), 1000, 300_000), Ok(2500));
        assert_eq!(start_budget_ms(&json!({ "remainingMs": 2500, "expiresAt": 1800 }), 1000, 300_000), Ok(800));
        assert_eq!(start_budget_ms(&json!({ "remainingMs": 900_000, "timeoutMs": 900_000 }), 1000, 300_000), Ok(300_000));
        assert_eq!(start_budget_ms(&json!({ "remainingMs": 0 }), 1000, 300_000), Ok(0));
        assert_eq!(start_budget_ms(&json!({ "expiresAt": 999 }), 1000, 300_000), Ok(0));
        assert!(start_budget_ms(&json!({ "remainingMs": -1 }), 1000, 300_000).is_err());
        assert!(start_budget_ms(&json!({ "remainingMs": "300000" }), 1000, 300_000).is_err());
    }
}
