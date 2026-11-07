//! Channel credential groups. Keys remain ordinary encrypted account rows.

use std::collections::HashSet;
use serde_json::{json, Value};
use super::{identity, AccountStore, AccountStoreError, StoredAccount, sql, next_free_priority, token_tail_of};
use crate::server::logging;
use crate::server::core::account_store::read_rows;

#[derive(Clone, Debug)]
pub struct KeyGroup {
    pub id: String,
    pub name: String,
    pub api_keys: Vec<String>,
    pub account_ids: Vec<String>,
    pub models: Vec<String>,
    pub enabled: bool,
}

fn strings(value: Option<&Value>, field: &str, max_len: usize) -> Result<Vec<String>, String> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let values = value.as_array().ok_or_else(|| format!("{field} 必须是数组"))?;
    if values.len() > 512 { return Err(format!("{field} 最多 512 项")); }
    let mut result = Vec::new();
    for value in values {
        let text = value.as_str().ok_or_else(|| format!("{field} 每项必须是字符串"))?.trim();
        if text.is_empty() { continue; }
        if text.chars().count() > max_len { return Err(format!("{field} 内容过长")); }
        if !result.iter().any(|item: &String| item == text) { result.push(text.to_string()); }
    }
    Ok(result)
}

pub fn parse_groups(value: &Value) -> Result<Vec<KeyGroup>, String> {
    let groups = value.as_array().ok_or("keyGroups 必须是数组")?;
    if groups.is_empty() || groups.len() > 64 { return Err("渠道需要 1–64 个 Key 分组".into()); }
    let mut result = Vec::new();
    let mut used_ids = HashSet::new();
    let mut used_keys = HashSet::new();
    let mut used_accounts = HashSet::new();
    for (index, value) in groups.iter().enumerate() {
        let object = value.as_object().ok_or("Key 分组必须是对象")?;
        let id = object.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty())
            .map(|id| id.trim().to_string()).unwrap_or_else(|| format!("group-{}", index + 1));
        if id.len() > 128 || !used_ids.insert(id.clone()) { return Err("Key 分组 ID 重复或过长".into()); }
        let name = object.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if name.chars().count() > 100 { return Err("Key 分组名称过长".into()); }
        let api_keys = strings(object.get("apiKeys"), "apiKeys", super::MAX_API_KEY_LENGTH)?;
        let account_ids = strings(object.get("accountIds"), "accountIds", 128)?;
        if api_keys.is_empty() && account_ids.is_empty() { return Err("每个 Key 分组至少需要一把 Key".into()); }
        for key in &api_keys { if !used_keys.insert(key.clone()) { return Err("同一把 Key 不能属于多个分组".into()); } }
        for id in &account_ids { if !used_accounts.insert(id.clone()) { return Err("同一账号不能属于多个分组".into()); } }
        if !object.contains_key("models") { return Err("每个 Key 分组必须显式选择 models".into()); }
        let models = strings(object.get("models"), "models", 128)?;
        let enabled = match object.get("enabled") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err("enabled 必须是布尔值".into()),
        };
        result.push(KeyGroup { id, name, api_keys, account_ids, models, enabled });
    }
    Ok(result)
}

/// Legacy accounts remain unrestricted. Explicit empty/malformed group metadata
/// never becomes a wildcard, including when every other candidate is exhausted.
pub fn allows_model(account: &Value, upstream_model: &str) -> bool {
    let Some(group) = account.get("keyGroup") else { return true };
    group.get("enabled").and_then(Value::as_bool) == Some(true)
        && group.get("models").and_then(Value::as_array).is_some_and(|models| {
            models.iter().any(|model| model.as_str().is_some_and(|model| model.eq_ignore_ascii_case(upstream_model.trim())))
        })
}

/// Routing-group candidates already contain a resolved upstream model. Ordinary
/// requests still need the channel alias mapping, exactly as forwarding does.
pub fn allows_request(account: &Value, requested: &str, selected_upstream: Option<&str>) -> bool {
    if account.get("keyGroup").is_none() { return true; }
    let upstream = selected_upstream.map(str::to_string).unwrap_or_else(|| {
        crate::server::core::custom_providers::wire_model_for(
            crate::server::core::routing::provider_of(account), requested).0
    });
    allows_model(account, &upstream)
}

/// Only these nonsecret fields may reach management responses and route snapshots.
pub fn public_metadata(group: &Value) -> Value {
    let models: Vec<&str> = group.get("models").and_then(Value::as_array).into_iter()
        .flatten().filter_map(Value::as_str).collect();
    json!({
        "id": group.get("id").and_then(Value::as_str).unwrap_or(""),
        "name": group.get("name").and_then(Value::as_str).unwrap_or(""),
        "enabled": group.get("enabled").and_then(Value::as_bool) == Some(true),
        "models": models,
    })
}

pub fn selected_models(groups: &[KeyGroup]) -> Vec<Value> {
    let mut models: Vec<Value> = Vec::new();
    for group in groups {
        for model in &group.models {
            if !models.iter().any(|item| item.get("id").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(model))) {
                models.push(json!({ "id": model, "enabled": true }));
            }
        }
    }
    models
}

fn load_channel_accounts(conn: &rusqlite::Connection, provider: &str) -> rusqlite::Result<Vec<StoredAccount>> {
    read_rows::provider(conn, provider)?.into_iter().map(|row| {
        read_rows::decode(row).map(|(_, record)| record).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text,
                format!("渠道账号读取失败，未修改任何分组：{}", error.describe()).into())
        })
    }).collect()
}

impl AccountStore {
    /// Replace the complete channel credential groups atomically. Existing rows
    /// retain their IDs, proxy, cooldowns and individual enabled state.
    pub fn save_custom_key_groups(&self, provider: &str, groups: &[KeyGroup], defaults: &Value) -> Result<Vec<Value>, AccountStoreError> {
        if !provider.starts_with(crate::server::core::custom_providers::ID_PREFIX) {
            return Err(AccountStoreError::bad_request("不是自定义渠道"));
        }
        let guard = self.guard();
        let existing = self.with_conn(&guard, |conn| load_channel_accounts(conn, provider))?;
        let mut used = HashSet::new();
        let mut records = Vec::new();
        let mut priorities = self.with_conn(&guard, sql::priorities_all)?;
        for group in groups {
            let mut members = Vec::new();
            for id in &group.account_ids {
                let record = existing.iter().find(|record| record.id() == id)
                    .ok_or_else(|| AccountStoreError::bad_request("分组引用的账号不存在或属于其他渠道"))?;
                members.push(record.clone());
            }
            for key in &group.api_keys {
                if let Some(record) = existing.iter().find(|record| record.fields().get("apiKey").and_then(Value::as_str) == Some(key.as_str())) {
                    members.push(record.clone());
                } else {
                    let id = identity::new_id(provider, key).map_err(AccountStoreError::bad_request)?;
                    if self.with_conn(&guard, |conn| sql::load_by_id(conn, &id))?.is_some() {
                        return Err(AccountStoreError::bad_request("账号 ID 已被占用"));
                    }
                    let priority = next_free_priority(&priorities);
                    if priorities.contains(&priority) { return Err(AccountStoreError::bad_request("账号优先级号段已满，无法添加更多 Key")); }
                    priorities.push(priority);
                    let mut fields = serde_json::Map::new();
                    fields.insert("id".into(), id.into());
                    fields.insert("provider".into(), provider.into());
                    fields.insert("name".into(), format!("{} · {}", if group.name.is_empty() { &group.id } else { &group.name }, token_tail_of(key)).into());
                    fields.insert("apiKey".into(), key.clone().into());
                    fields.insert("tokenTail".into(), token_tail_of(key).into());
                    fields.insert("priority".into(), priority.into());
                    fields.insert("enabled".into(), true.into());
                    fields.insert("source".into(), "manual".into());
                    fields.insert("addedAt".into(), logging::now_ms().into());
                    if let Some(query) = defaults.get("balanceQuery").and_then(Value::as_object) {
                        let mut normalized = serde_json::Map::new();
                        super::normalize_balance_query_patch(&mut normalized, query).map_err(AccountStoreError::bad_request)?;
                        fields.insert("balanceQuery".into(), Value::Object(normalized));
                    }
                    members.push(StoredAccount::from_map(fields));
                }
            }
            for mut record in members {
                if !used.insert(record.id().to_string()) { return Err(AccountStoreError::bad_request("同一把 Key 不能重复或属于多个分组")); }
                record.set("keyGroup", json!({ "id": group.id, "name": group.name, "models": group.models, "enabled": group.enabled }));
                record.set_updated_at(logging::now_ms());
                records.push(record);
            }
        }
        self.with_conn_mut(&guard, |conn| {
            let tx = conn.transaction()?;
            for record in &existing {
                if !used.contains(record.id()) { sql::delete(&tx, record.id())?; }
            }
            for record in &records {
                if existing.iter().any(|old| old.id() == record.id()) { sql::update_in_place(&tx, record)?; }
                else { sql::put(&tx, record)?; }
            }
            tx.commit()
        })?;
        Ok(records.iter().map(|record| self.public_account(record)).collect())
    }

    pub fn custom_key_groups_public(&self, provider: &str) -> Vec<Value> {
        let legacy_models: Vec<Value> = crate::server::core::custom_providers::models_of(provider).iter()
            .filter_map(|model| model.get("id").cloned()).collect();
        let records = {
            let guard = self.guard();
            self.records_for_provider(&guard, provider)
        };
        let mut groups: Vec<Value> = Vec::new();
        for record in records {
            let value = record.to_value();
            let group = value.get("keyGroup").map(public_metadata).unwrap_or_else(|| json!({
                "id": format!("legacy-{}", record.id()), "name": record.name(), "enabled": record.enabled(), "models": legacy_models,
            }));
            let id = group.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or(record.id());
            let index = groups.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .unwrap_or_else(|| {
                    groups.push(json!({"id":id,"name":group.get("name"),"enabled":group.get("enabled"),"models":group.get("models"),"accountIds":[],"keys":[]}));
                    groups.len() - 1
                });
            if let Some(ids) = groups[index].get_mut("accountIds").and_then(Value::as_array_mut) { ids.push(record.id().into()); }
            if let Some(keys) = groups[index].get_mut("keys").and_then(Value::as_array_mut) {
                keys.push(json!({"accountId":record.id(),"tail":value.get("tokenTail"),"name":record.name()}));
            }
        }
        groups
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn groups_require_explicit_models_and_unique_credentials() {
        assert!(parse_groups(&json!([{ "name":"A", "apiKeys":["a"], "models":[] }])).is_ok());
        assert!(parse_groups(&json!([{ "apiKeys":["a"], "models":["m"] }, {"apiKeys":["a"],"models":["n"]}])).is_err());
        assert!(parse_groups(&json!([{ "apiKeys":["a"], "models":"m" }])).is_err());
        assert!(parse_groups(&json!([{ "apiKeys":["a"] }])).is_err());
    }

    #[test]
    fn explicit_empty_or_disabled_group_does_not_allow_any_model() {
        assert!(allows_model(&json!({}), "m"));
        assert!(!allows_model(&json!({"keyGroup":{"enabled":true,"models":[]}}), "m"));
        assert!(!allows_model(&json!({"keyGroup":{"enabled":false,"models":["m"]}}), "m"));
        assert!(allows_model(&json!({"keyGroup":{"enabled":true,"models":["m"]}}), "M"));
        assert!(!allows_model(&json!({"keyGroup":{"enabled":true,"models":["n"]}}), "m"));
    }

    #[test]
    fn retained_account_cannot_appear_in_two_groups() {
        assert!(parse_groups(&json!([
            {"id":"a","accountIds":["account"],"models":["m"]},
            {"id":"b","accountIds":["account"],"models":["n"]}
        ])).is_err());
    }

    #[test]
    fn disjoint_key_groups_only_allow_their_selected_upstream_models() {
        let accounts = [
            json!({"id":"a","keyGroup":{"enabled":true,"models":["gpt-upstream"]}}),
            json!({"id":"b","keyGroup":{"enabled":true,"models":["claude-upstream"]}}),
            json!({"id":"c","keyGroup":{"enabled":false,"models":["gpt-upstream"]}}),
        ];
        let allowed: Vec<_> = accounts.iter().filter(|account| allows_model(account, "gpt-upstream"))
            .map(|account| account["id"].as_str().unwrap()).collect();
        assert_eq!(allowed, vec!["a"]);
        assert!(accounts.iter().all(|account| !allows_model(account, "unselected")));
    }

    #[test]
    fn routing_group_selection_checks_upstream_model_instead_of_public_alias() {
        let account = json!({"provider":"custom-test","keyGroup":{"enabled":true,"models":["upstream"]}});
        assert!(allows_request(&account, "public-alias", Some("upstream")));
        assert!(!allows_request(&account, "upstream", Some("other-upstream")));
    }

    #[test]
    fn channel_reads_reject_corrupt_rows_before_replacement() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE accounts (provider TEXT, data TEXT)").unwrap();
        conn.execute("INSERT INTO accounts VALUES (?1, ?2)", rusqlite::params!["custom-a", r#"{"id":"old","provider":"custom-a"}"#]).unwrap();
        conn.execute("INSERT INTO accounts VALUES (?1, ?2)", rusqlite::params!["custom-a", "broken json"]).unwrap();
        assert!(load_channel_accounts(&conn, "custom-a").is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert!(load_channel_accounts(&conn, "custom-other").unwrap().is_empty());
    }

    #[test]
    fn public_group_metadata_does_not_expose_credentials_or_unknown_fields() {
        let public = public_metadata(&json!({"id":"g","name":"Test","enabled":true,"models":["m"],
            "apiKeys":["secret"],"apiKey":"secret","unknown":"private"}));
        assert_eq!(public, json!({"id":"g","name":"Test","enabled":true,"models":["m"]}));
        assert_eq!(public_metadata(&Value::Null)["models"], json!([]));
        assert_eq!(public_metadata(&Value::Null)["enabled"], false);
    }

    #[test]
    fn invalid_retained_account_aborts_before_removing_existing_accounts() {
        let (db, _temp) = crate::server::db::test_temp::TempDb::open("key-groups-invalid-reference");
        let original = json!({"id":"old","provider":"custom-a","apiKey":"secret","enabled":true});
        db.with(|conn| conn.execute("INSERT INTO accounts (id,provider,priority,enabled,added_at,data) VALUES ('old','custom-a',1,1,0,?1)", [original.to_string()])).unwrap().unwrap();
        let store = AccountStore::with_db(Some(db.clone()));
        let groups = parse_groups(&json!([{ "id":"g", "accountIds":["missing"], "models":["m"] }])).unwrap();
        let error = store.save_custom_key_groups("custom-a", &groups, &json!({})).unwrap_err();
        assert_eq!(error.status_code, 400);
        let guard = store.guard();
        let records = store.with_conn(&guard, |conn| load_channel_accounts(conn, "custom-a")).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].to_value(), original);
    }
}
