//! Explicit public model catalog. Upstream discovery never publishes a model.
//! Bindings point at upstream IDs, not other public aliases, so resolution is one hop.

use super::{
    account_store::{custom_accounts::key_groups, AccountStore},
    capability, custom_providers,
    key_scope::{self, KeyScope},
    models::{list_item, model_id},
    providers, routing,
};
use crate::server::config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const KEY: &str = "managedModels";
const MAX_MODELS: usize = 2000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub bindings: Vec<Binding>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 128
        && !id.chars().any(|ch| ch.is_whitespace() || ch.is_control())
}

pub fn validate(model: &ManagedModel) -> Result<(), String> {
    if !valid_id(&model.id) {
        return Err("对外模型 ID 必须为 1–128 个字符，不能包含空白或控制字符".into());
    }
    if model.name.chars().count() > 128 || model.name.chars().any(char::is_control) {
        return Err("模型名称过长或包含控制字符".into());
    }
    if model.bindings.is_empty() || model.bindings.len() > 256 {
        return Err("请选择 1–256 个渠道及其上游模型".into());
    }
    let mut seen = HashSet::new();
    for binding in &model.bindings {
        if !valid_id(&binding.model)
            || binding.provider.is_empty()
            || binding.provider.len() > 256
            || binding
                .provider
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control())
        {
            return Err("渠道或上游模型 ID 无效".into());
        }
        if !seen.insert(binding.provider.to_ascii_lowercase()) {
            return Err("同一对外模型在每个渠道只能关联一个上游模型；复杂回退可使用路由组".into());
        }
    }
    Ok(())
}

fn parse(value: &Value) -> Result<Vec<ManagedModel>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let items: Vec<ManagedModel> = serde_json::from_value(value.clone())
        .map_err(|_| "已保存的模型目录格式无效，未覆盖原配置")?;
    if items.len() > MAX_MODELS {
        return Err("模型数量超过上限".into());
    }
    let mut ids = HashSet::new();
    for item in &items {
        validate(item)?;
        if !ids.insert(item.id.to_ascii_lowercase()) {
            return Err("对外模型 ID 重复".into());
        }
    }
    Ok(items)
}

pub fn list() -> Vec<ManagedModel> {
    // Corrupt catalog fails closed. The management API reports the parse error.
    parse(config::current().raw().get(KEY).unwrap_or(&Value::Null)).unwrap_or_default()
}

fn revision_of(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}

fn selected<'a>(items: &'a [ManagedModel], id: &str) -> Option<&'a ManagedModel> {
    items
        .iter()
        .find(|item| item.enabled && item.id.eq_ignore_ascii_case(id.trim()))
}

pub fn source(provider: &str, model: &str) -> Option<Value> {
    super::routing_groups::catalog_model(provider, model)
}

pub fn target(provider: &str, requested: &str) -> Option<String> {
    let items = list();
    let binding = selected(&items, requested)?
        .bindings
        .iter()
        .find(|binding| binding.provider.eq_ignore_ascii_case(provider))?;
    source(&binding.provider, &binding.model).map(|item| model_id(&item))
}

pub fn carriers(requested: &str) -> Vec<String> {
    let items = list();
    selected(&items, requested)
        .map(|item| {
            item.bindings
                .iter()
                .filter(|binding| {
                    provider_enabled(&binding.provider)
                        && source(&binding.provider, &binding.model).is_some()
                })
                .map(|binding| binding.provider.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn provider_enabled(provider: &str) -> bool {
    super::account_store::store_view::account_visible(provider)
        && custom_providers::get(provider).map_or(true, |item| {
            item.get("enabled") != Some(&Value::Bool(false))
        })
}

fn account_matches(account: &Value, binding: &Binding) -> bool {
    routing::provider_of(account).eq_ignore_ascii_case(&binding.provider)
        && account.get("enabled") != Some(&Value::Bool(false))
        && account.get("hasCredentials").and_then(Value::as_bool) == Some(true)
        && key_groups::allows_model(account, &binding.model)
}

fn available(
    binding: &Binding,
    accounts: &[std::sync::Arc<Value>],
    scope: Option<&KeyScope>,
) -> bool {
    key_scope::allows_provider(scope, &binding.provider)
        && provider_enabled(&binding.provider)
        && accounts
            .iter()
            .any(|account| account_matches(account, binding))
}

pub fn public_models(store: &AccountStore, scope: Option<&KeyScope>) -> Vec<Value> {
    let snapshot = store.routing_snapshot();
    let mut result = Vec::new();
    for model in list()
        .into_iter()
        .filter(|model| model.enabled && key_scope::allows_model(scope, &model.id))
    {
        let candidate = model
            .bindings
            .iter()
            .filter(|binding| {
                snapshot.available_providers.contains(&binding.provider)
                    && available(binding, &snapshot.accounts, scope)
            })
            .find_map(|binding| {
                source(&binding.provider, &binding.model).map(|item| (binding, item))
            });
        let Some((binding, upstream)) = candidate else {
            continue;
        };
        let mut item = list_item(&upstream, &binding.provider);
        item["id"] = model.id.clone().into();
        item["name"] = if model.name.is_empty() {
            model.id
        } else {
            model.name
        }
        .into();
        item["managed"] = true.into();
        result.push(item);
    }
    result
}

pub fn models_by_provider(store: &AccountStore) -> Value {
    let snapshot = store.routing_snapshot();
    let mut result: HashMap<String, Vec<String>> = HashMap::new();
    for model in list().into_iter().filter(|model| model.enabled) {
        for binding in &model.bindings {
            if snapshot.available_providers.contains(&binding.provider)
                && available(binding, &snapshot.accounts, None)
                && source(&binding.provider, &binding.model).is_some()
            {
                result
                    .entry(binding.provider.clone())
                    .or_default()
                    .push(model.id.clone());
            }
        }
    }
    for group in config::routing_profiles().groups.values() {
        for member in group.members.iter().filter(|member| {
            super::routing_groups::available_member_model(member, &snapshot.accounts, None)
                .is_some()
        }) {
            result
                .entry(member.provider.clone())
                .or_default()
                .push(group.model.clone());
        }
    }
    for models in result.values_mut() {
        models.sort();
        models.dedup();
    }
    json!(result)
}

pub fn choices(store: &AccountStore) -> Vec<Value> {
    let snapshot = store.routing_snapshot();
    let mut providers: Vec<String> = snapshot
        .accounts
        .iter()
        .map(|account| routing::provider_of(account).to_string())
        .collect();
    providers.extend(
        custom_providers::list()
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string)),
    );
    providers.sort();
    providers.dedup();
    providers.into_iter().filter(|provider| super::account_store::store_view::account_visible(provider)).map(|provider| {
        let models = custom_providers::get(&provider).and_then(|item| item.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_else(|| providers::catalog::manifest_for_provider(&provider));
        let models: Vec<_> = models.iter().map(|item| json!({ "id": model_id(item),
            "name": item.get("name"), "kind": if providers::images::model_is_image(item) { "image" } else { "chat" },
            "capabilities": capability::effective(item) })).collect();
        json!({ "id": provider, "name": providers::label_of(&provider), "models": models,
            "accountCount": snapshot.accounts.iter().filter(|account| routing::provider_of(account) == provider).count() })
    }).collect()
}

pub fn management(store: &AccountStore) -> Result<Value, String> {
    let snapshot = config::current();
    let raw = snapshot.raw().get(KEY).unwrap_or(&Value::Null);
    let models = parse(raw)?;
    Ok(
        json!({ "models": models, "revision": revision_of(raw), "sources": choices(store),
        "routingGroups": config::routing_profiles().groups.values().collect::<Vec<_>>() }),
    )
}

pub fn save(previous_id: &str, model: Option<ManagedModel>, expected: &str) -> Result<(), String> {
    let previous = list().into_iter().find(|item| item.id == previous_id);
    if let Some(model) = &model {
        validate(model)?;
        let mut kind = None;
        for binding in &model.bindings {
            let item = match source(&binding.provider, &binding.model) {
                Some(item) => item,
                None if previous
                    .as_ref()
                    .is_some_and(|old| old.bindings.contains(binding)) =>
                {
                    continue
                }
                None => {
                    return Err(format!(
                        "渠道中找不到上游模型 {}，请刷新候选列表",
                        binding.model
                    ))
                }
            };
            let image = providers::images::model_is_image(&item);
            if kind.is_some_and(|previous| previous != image) {
                return Err("同一个对外模型不能混合对话模型和生图模型".into());
            }
            kind = Some(image);
        }
    }
    config::try_update_raw_field(
        KEY,
        |raw| {
            if revision_of(raw) != expected {
                return Err("模型目录已在其他位置修改，请刷新后重试；当前草稿仍然保留".to_string());
            }
            let mut models = parse(raw)?;
            if !previous_id.is_empty() && !models.iter().any(|item| item.id == previous_id) {
                return Err("待修改的模型不存在".into());
            }
            if let Some(model) = &model {
                // Routing-group saves use the same config update lock. Check here so
                // concurrent saves cannot publish two endpoints with the same name.
                if config::routing_profiles()
                    .groups
                    .values()
                    .any(|group| group.model.eq_ignore_ascii_case(&model.id))
                {
                    return Err("对外模型 ID 已被路由组占用".into());
                }
                if models
                    .iter()
                    .any(|item| item.id != previous_id && item.id.eq_ignore_ascii_case(&model.id))
                {
                    return Err("对外模型 ID 已存在".into());
                }
            }
            models.retain(|item| item.id != previous_id);
            if let Some(model) = model {
                models.push(model);
            }
            if models.len() > MAX_MODELS {
                return Err("模型数量已达上限".into());
            }
            *raw = json!(models);
            Ok(())
        },
        || "模型目录保存失败，未应用修改".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> ManagedModel {
        ManagedModel {
            id: "public".into(),
            name: "".into(),
            enabled: true,
            bindings: vec![Binding {
                provider: "channel-a".into(),
                model: "private-upstream".into(),
            }],
        }
    }

    #[test]
    fn absent_and_empty_catalog_publish_nothing() {
        assert_eq!(parse(&Value::Null).unwrap(), vec![]);
        assert_eq!(parse(&json!([])).unwrap(), vec![]);
    }
    #[test]
    fn only_explicit_enabled_names_resolve() {
        let mut item = model();
        assert!(selected(&[item.clone()], "private-upstream").is_none());
        assert!(selected(&[item.clone()], " PUBLIC ").is_some());
        item.enabled = false;
        assert!(selected(&[item], "public").is_none());
    }
    #[test]
    fn invalid_bindings_and_duplicate_ids_are_rejected() {
        let mut item = model();
        item.bindings.clear();
        assert!(validate(&item).is_err());
        item = model();
        item.bindings.push(item.bindings[0].clone());
        assert!(validate(&item).is_err());
        assert!(parse(&json!([model(), model()])).is_err());
        assert!(parse(&json!({"models": []})).is_err());
    }
    #[test]
    fn group_credential_policy_uses_bound_upstream_model() {
        let account = json!({"provider":"channel-a","enabled":true,"hasCredentials":true,"keyGroup":{"enabled":true,"models":["private-upstream"]}});
        assert!(account_matches(&account, &model().bindings[0]));
        assert!(!account_matches(
            &account,
            &Binding {
                provider: "channel-a".into(),
                model: "public".into()
            }
        ));
        assert!(!account_matches(
            &account,
            &Binding {
                provider: "channel-b".into(),
                model: "private-upstream".into()
            }
        ));
        let mut missing_credentials = account.clone();
        missing_credentials["hasCredentials"] = false.into();
        assert!(!account_matches(&missing_credentials, &model().bindings[0]));
    }
}
