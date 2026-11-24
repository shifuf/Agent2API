//! Atomic proxy bindings. The accounts.proxy field remains the only binding state.
//!
//! Lock order: account mutex -> shared Db connection -> immediate transaction.
//! Pool, subscriptions and account rows are read inside that transaction. Subscription
//! cache validation reads local files only; it must not enter Db or acquire the kernel's
//! test/control locks. No network requests or listener reconciliation happen here.
//! Db's existing accounts update hook invalidates snapshots and notifies cloud sync.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use super::{sql, AccountStore, AccountStoreError};
use crate::server::core::{proxies, proxy_pool, proxy_rotate, sub_kernel, subscriptions};
use crate::server::logging;

pub const MAX_BINDING_ACCOUNTS: usize = 200;

pub(crate) fn validate_binding_ids(ids: &[String], maximum: usize, max_length: usize, label: &str) -> Result<(), AccountStoreError> {
    if ids.len() > maximum {
        return Err(AccountStoreError::bad_request(format!("{label}每次最多选择 {maximum} 项")));
    }
    let mut seen = HashSet::new();
    for id in ids {
        if id.is_empty() || id.trim() != id || id.chars().count() > max_length || id.chars().any(char::is_control) {
            return Err(AccountStoreError::bad_request(format!("{label} id 无效")));
        }
        if !seen.insert(id) {
            return Err(AccountStoreError::bad_request(format!("{label} id 不能重复")));
        }
    }
    Ok(())
}

fn stored_items(conn: &Connection, key: &str) -> rusqlite::Result<Vec<Value>> {
    let stored: Option<String> = conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| row.get(0)).optional()?;
    let Some(stored) = stored else { return Ok(Vec::new()) };
    let payload: Value = serde_json::from_str(&stored).map_err(|error| rusqlite::Error::FromSqlConversionFailure(
        0, rusqlite::types::Type::Text, Box::new(error),
    ))?;
    payload.get("items").and_then(Value::as_array).cloned().ok_or_else(|| rusqlite::Error::InvalidQuery)
}

struct BindingCache { names: HashSet<String>, path: std::path::PathBuf, content: String }

fn validate_target(item: &Value, subscriptions: &[Value], cached_nodes: &mut HashMap<String, BindingCache>) -> Result<(), String> {
    if !proxy_pool::is_enabled(item) {
        return Err("所选代理已禁用或来源不受支持".into());
    }
    if item.get("source").and_then(Value::as_str) == Some("subscription") {
        let provider = item.get("providerId").and_then(Value::as_str).ok_or("订阅节点缺少所属订阅")?;
        let subscription = subscriptions.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(provider))
            .ok_or("所选节点的订阅已删除")?;
        if provider.is_empty() || !provider.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_') {
            return Err("所属订阅 id 无效".into());
        }
        if subscription.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Err("所选节点的订阅已暂停".into());
        }
        let node = item.get("node").and_then(Value::as_str).filter(|node| !node.is_empty()).ok_or("订阅节点缺少名称")?;
        if !cached_nodes.contains_key(provider) {
            let path = sub_kernel::kernel_dir().join("providers").join(format!("sub_{provider}.yaml"));
            let content = std::fs::read_to_string(&path).map_err(|_| "订阅缓存未就绪，请刷新订阅后重试")?;
            if subscription.get("content").and_then(Value::as_str).filter(|stored| !stored.is_empty()).is_some_and(|stored| stored != content) {
                return Err("订阅内容正在更新，请刷新后重试".into());
            }
            let names = sub_kernel::runtime::binding_nodes(provider);
            cached_nodes.insert(provider.to_string(), BindingCache { names, path, content });
        }
        if !cached_nodes[provider].names.contains(node) {
            return Err("所选节点或代理组已从订阅移除，或组配置不可用；请刷新订阅后重试".into());
        }
        // A valid unused subscription node has no listener yet. Binding must allow it;
        // reconcile_listeners provisions its port after this transaction commits.
        return Ok(());
    }
    match proxy_pool::resolve_item(item) {
        Some(proxies::ProxyResolution::Resolved(proxy)) if !proxy.host.trim().is_empty() && proxy.port.is_some_and(|port| port > 0) => Ok(()),
        _ => Err("所选代理的地址或监听器已失效，请刷新代理列表".into()),
    }
}

impl AccountStore {
    /// Strict batch: any invalid input or missing/stale target rejects every write.
    /// Empty account selection is a no-op; empty proxy selection clears only those accounts.
    pub fn bind_proxy_pool(&self, account_ids: &[String], proxy_ids: &[String]) -> Result<usize, AccountStoreError> {
        validate_binding_ids(account_ids, MAX_BINDING_ACCOUNTS, 256, "账号")?;
        validate_binding_ids(proxy_ids, proxy_rotate::MAX_IDS, 100, "代理")?;
        if account_ids.is_empty() { return Ok(0) }
        let proxy = match proxy_ids {
            [] => Value::Null,
            [id] => json!({ "source": "pool", "proxyId": id }),
            ids => json!({ "source": "rotate", "all": false, "proxyIds": ids }),
        };
        let guard = self.guard();
        let result = self.with_conn_mut(&guard, |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let pool = if proxy_ids.is_empty() { Vec::new() } else { stored_items(&tx, proxy_pool::KV_KEY)? };
            let subscription_rows = if proxy_ids.iter().any(|id| pool.iter().any(|item|
                item.get("id").and_then(Value::as_str) == Some(id) && item.get("source").and_then(Value::as_str) == Some("subscription"))) {
                stored_items(&tx, subscriptions::KV_KEY)?
            } else { Vec::new() };
            let mut cached_nodes = HashMap::new();
            for id in proxy_ids {
                let Some(item) = pool.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)) else {
                    return Ok(Err(AccountStoreError::bad_request("所选代理不存在或已删除，请刷新代理列表")));
                };
                if let Err(reason) = validate_target(item, &subscription_rows, &mut cached_nodes) {
                    return Ok(Err(AccountStoreError::bad_request(reason)));
                }
            }
            let mut records = Vec::with_capacity(account_ids.len());
            for id in account_ids {
                let Some(record) = sql::load_by_id(&tx, id)? else {
                    return Ok(Err(AccountStoreError::bad_request("所选账号不存在或已删除，请刷新账号列表")));
                };
                records.push(record);
            }
            let now = logging::now_ms();
            let mut changed = 0;
            for mut record in records {
                if record.proxy() == proxy { continue }
                record.set_proxy(proxy.clone());
                record.set_updated_at(now);
                sql::update_in_place(&tx, &record)?;
                changed += 1;
            }
            // The kernel may atomically replace a remote subscription cache while
            // account SQL runs. Reject and roll back if the exact content checked
            // above changed; local subscription edits also need their cache applied.
            if cached_nodes.values().any(|cached| std::fs::read_to_string(&cached.path).ok().as_deref() != Some(cached.content.as_str())) {
                return Ok(Err(AccountStoreError::bad_request("订阅内容已变更，请刷新后重试")));
            }
            tx.commit()?;
            Ok(Ok(changed))
        })?;
        drop(guard);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::state::StoredAccount;
    use crate::server::db::test_temp::TempDb;

    fn fixture(label: &str) -> (AccountStore, crate::server::db::Db, TempDb) {
        let (db, temporary) = TempDb::open(label);
        db.with_mut(|conn| {
            for (id, priority) in [("one", 0), ("two", 1)] {
                let record = StoredAccount::from_value(json!({ "id": id, "provider": "missing-plugin", "name": id,
                    "priority": priority, "enabled": id == "one", "proxy": null,
                    "pluginSecret": { "nested": { "token": "retained-private-token" } }, "unknownFutureField": [1, 2, 3] })).unwrap();
                sql::put(conn, &record).unwrap();
            }
            conn.execute("INSERT INTO kv(key, value) VALUES (?1, ?2)", rusqlite::params![proxy_pool::KV_KEY,
                json!({ "items": [{ "id": "exit-one", "source": "manual", "enabled": true, "protocol": "http", "host": "127.0.0.1", "port": 8080 },
                    { "id": "exit-two", "source": "manual", "enabled": true, "protocol": "http", "host": "127.0.0.1", "port": 8081 },
                    { "id": "disabled", "source": "manual", "enabled": false, "host": "127.0.0.1", "port": 8082 }] }).to_string()]).unwrap();
        }).unwrap();
        (AccountStore::with_db(Some(db.clone())), db, temporary)
    }
    fn raw(db: &crate::server::db::Db, id: &str) -> Value { db.with(|conn| sql::load_by_id(conn, id).unwrap().unwrap().to_value()).unwrap() }

    #[test]
    fn binding_changes_only_proxy_and_preserves_unloaded_provider_secrets() {
        let (store, db, _temporary) = fixture("proxy-binding-preserve");
        let before = raw(&db, "two");
        assert_eq!(store.bind_proxy_pool(&["one".into(), "two".into()], &["exit-two".into(), "exit-one".into()]).unwrap(), 2);
        let after = raw(&db, "two");
        assert_eq!(after["proxy"], json!({ "source": "rotate", "all": false, "proxyIds": ["exit-two", "exit-one"] }));
        for field in ["id", "provider", "priority", "enabled", "pluginSecret", "unknownFutureField"] { assert_eq!(after[field], before[field]); }
        assert_eq!(store.bind_proxy_pool(&["two".into()], &[]).unwrap(), 1);
        assert_eq!(raw(&db, "two")["proxy"], Value::Null);
        assert_eq!(raw(&db, "one")["proxy"]["source"], "rotate");
    }

    #[test]
    fn unknown_or_disabled_inputs_reject_all_accounts_before_writing() {
        let (store, db, _temporary) = fixture("proxy-binding-invalid");
        for (accounts, proxies) in [
            (vec!["one".into(), "missing".into()], vec!["exit-one".into()]),
            (vec!["one".into(), "two".into()], vec!["exit-one".into(), "disabled".into()]),
            (vec!["one".into(), "two".into()], vec!["exit-one".into(), "missing".into()]),
            (vec!["one".into(), "one".into()], vec!["exit-one".into()]),
        ] {
            assert!(store.bind_proxy_pool(&accounts, &proxies).is_err());
            assert_eq!(raw(&db, "one")["proxy"], Value::Null);
            assert_eq!(raw(&db, "two")["proxy"], Value::Null);
        }
    }

    #[test]
    fn failure_on_second_sql_update_rolls_back_first_update() {
        let (store, db, _temporary) = fixture("proxy-binding-rollback");
        db.with(|conn| conn.execute_batch("CREATE TRIGGER binding_failure BEFORE UPDATE ON accounts WHEN OLD.id = 'two' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;").unwrap()).unwrap();
        assert!(store.bind_proxy_pool(&["one".into(), "two".into()], &["exit-one".into()]).is_err());
        assert_eq!(raw(&db, "one")["proxy"], Value::Null);
        assert_eq!(raw(&db, "two")["proxy"], Value::Null);
    }
}
