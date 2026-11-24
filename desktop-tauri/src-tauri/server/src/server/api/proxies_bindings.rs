//! Redacted account-to-pool management view and strict atomic binding writes.
use axum::{body::Bytes, response::Response};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::server::{errors::management_error, http::ok_json, ServerState};

/// Whitelist proxy metadata; even a legacy custom proxy's config cannot leak a
/// password or an opaque plugin secret through this new management payload.
fn public_proxy(proxy: &Value) -> Value {
    if proxy.is_null() { return Value::Null }
    let original = proxy.get("config").unwrap_or(proxy);
    let config = original.get("config").filter(|value| value.is_object()).unwrap_or(original);
    let source = config.get("source").and_then(Value::as_str).unwrap_or("");
    let mut safe_config = Map::new();
    safe_config.insert("source".into(), json!(source));
    match source {
        "pool" => { safe_config.insert("proxyId".into(), config.get("proxyId").and_then(Value::as_str).map(|id| json!(id)).unwrap_or(Value::Null)); }
        "rotate" => {
            let all = config.get("all").and_then(Value::as_bool).unwrap_or(true);
            safe_config.insert("all".into(), json!(all));
            if !all { safe_config.insert("proxyIds".into(), json!(config.get("proxyIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>())); }
        }
        "clash" => { safe_config.insert("listenerUid".into(), config.get("listenerUid").and_then(Value::as_str).map(|id| json!(id)).unwrap_or(Value::Null)); }
        _ => {}
    }
    let mut safe = Map::new();
    for key in ["source", "label", "error", "protocol", "host"] {
        if let Some(value) = proxy.get(key).and_then(Value::as_str) { safe.insert(key.to_string(), json!(value)); }
    }
    if let Some(port) = proxy.get("port").and_then(Value::as_u64) { safe.insert("port".into(), json!(port)); }
    safe.insert("config".into(), Value::Object(safe_config));
    Value::Object(safe)
}

pub(super) fn accounts(state: &ServerState) -> Vec<Value> {
    // list_accounts is the all-record, public projection; list_visible_accounts
    // intentionally hides unloaded plugin providers and would lose their bindings.
    let snapshot = state.store().list_accounts();
    let labels: HashMap<&str, &str> = snapshot.get("providers").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|provider| Some((provider.get("id")?.as_str()?, provider.get("label")?.as_str()?))).collect();
    snapshot.get("accounts").and_then(Value::as_array).into_iter().flatten().map(|account| {
        let id = account.get("id").and_then(Value::as_str).unwrap_or("");
        let provider = account.get("provider").and_then(Value::as_str).unwrap_or("");
        let name = account.get("displayName").and_then(Value::as_str).filter(|name| !name.is_empty())
            .or_else(|| account.get("name").and_then(Value::as_str).filter(|name| !name.is_empty())).unwrap_or(id);
        let provider_label = labels.get(provider).map(|label| (*label).to_string())
            .unwrap_or_else(|| crate::server::core::providers::label_of(provider));
        json!({ "id": id, "name": name, "provider": provider,
            "providerLabel": provider_label,
            "enabled": account.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            "proxy": public_proxy(account.get("proxy").unwrap_or(&Value::Null)) })
    }).collect()
}

fn payload(state: &ServerState) -> Value {
    let accounts = accounts(state);
    let mut payload = super::pool_payload_for_accounts(&accounts);
    payload["accounts"] = Value::Array(accounts);
    // These flags are for selection hints. The write rechecks the actual stored
    // pool/subscription rows inside its transaction, so a cached GET is never authority.
    let mut nodes: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    if let Some(items) = payload.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let reason = if item["enabled"] == false { Some("所选代理已禁用") }
                else if item["orphan"] == true { Some("所属订阅已删除") }
                else if item["source"] == "subscription" {
                    let provider = item["providerId"].as_str().unwrap_or("");
                    let node = item["node"].as_str().unwrap_or("");
                    if crate::server::core::subscriptions::find_enabled_state(provider) != Some(true) { Some("所属订阅已暂停或删除") }
                    else if !nodes.entry(provider.to_string()).or_insert_with(|| crate::server::core::sub_kernel::runtime::binding_nodes(provider)).contains(node) {
                        Some("节点或代理组已移除，请刷新订阅")
                    } else { None }
                } else { None };
            item["bindingError"] = reason.map(|value| json!(value)).unwrap_or(Value::Null);
        }
    }
    payload
}

pub async fn list(state: &ServerState) -> Response { ok_json(payload(state)) }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingRequest { account_ids: Vec<String>, proxy_ids: Vec<String> }

pub async fn save(state: &ServerState, body: &Bytes) -> Response {
    let request: BindingRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(_) => return management_error(400, "绑定内容必须包含账号 id 数组与代理 id 数组"),
    };
    let before = state.store().referenced_pool_ids();
    match state.store().bind_proxy_pool(&request.account_ids, &request.proxy_ids) {
        Ok(changed) => {
            // bind_proxy_pool has released the account mutex and Db transaction.
            // Listener work is queued by the existing account-management lifecycle.
            if changed > 0 { super::super::accounts::reconcile_kernel_listeners(state, &before); }
            let mut data = payload(state);
            data["changed"] = json!(changed);
            ok_json(data)
        }
        Err(error) => super::super::accounts::store_error(error),
    }
}
