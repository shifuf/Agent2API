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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bindings: Vec<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_card: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl ManagedModel {
    fn published(&self) -> bool {
        self.enabled && self.archived != Some(true)
    }

    fn retain_metadata(&mut self, previous: &Self) {
        // An older client only sends the original four fields. Omitted metadata
        // must survive those edits; empty strings / an empty card clear it.
        macro_rules! retain {
            ($($field:ident),+ $(,)?) => {$(
                if self.$field.is_none() { self.$field = previous.$field.clone(); }
            )+};
        }
        retain!(developer, model_type, icon, group, remark, model_card, archived);
        self.created_at = previous.created_at.clone();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BatchAction {
    Create,
    Enable,
    Disable,
    Archive,
    Restore,
    Delete,
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
    for (value, limit, label) in [
        (model.developer.as_deref(), 128, "开发者"),
        (model.icon.as_deref(), 128, "图标"),
        (model.group.as_deref(), 128, "分组"),
        (model.remark.as_deref(), 4000, "备注"),
    ] {
        if value.is_some_and(|value| {
            value.chars().count() > limit
                || value.chars().any(|ch| {
                    ch.is_control() && !(label == "备注" && matches!(ch, '\n' | '\r' | '\t'))
                })
        }) {
            return Err(format!("模型{label}过长或包含控制字符"));
        }
    }
    if model.model_type.as_deref().is_some_and(|kind| {
        !matches!(
            kind,
            "" | "chat" | "embedding" | "rerank" | "image_generation" | "video_generation"
        )
    }) {
        return Err("模型类型无效".into());
    }
    for time in [&model.created_at, &model.updated_at].into_iter().flatten() {
        if time.len() > 64 || chrono::DateTime::parse_from_rfc3339(time).is_err() {
            return Err("模型时间格式无效".into());
        }
    }
    if let Some(card) = &model.model_card {
        validate_model_card(card)?;
    }
    if model.bindings.len() > 256 {
        return Err("每个模型最多关联 256 个渠道及其上游模型".into());
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

fn validate_model_card(card: &Value) -> Result<(), String> {
    let invalid = || "模型卡片字段或数值无效".to_string();
    let object = card.as_object().ok_or_else(invalid)?;
    if serde_json::to_vec(card).map_err(|_| invalid())?.len() > 16 * 1024 {
        return Err("模型卡片过长".into());
    }
    for (key, value) in object {
        let valid = match key.as_str() {
            "toolCall" | "temperature" | "vision" => value.is_boolean(),
            "reasoning" => value.as_object().is_some_and(|reasoning| {
                reasoning.iter().all(|(key, value)| {
                    matches!(key.as_str(), "supported" | "default") && value.is_boolean()
                })
            }),
            "reasoningEfforts" => value.is_null() || text_list(value, 16, 64),
            "modalities" => value.as_object().is_some_and(|modalities| {
                modalities.iter().all(|(key, value)| {
                    matches!(key.as_str(), "input" | "output") && text_list(value, 16, 64)
                })
            }),
            "cost" => value.as_object().is_some_and(|cost| {
                cost.iter().all(|(key, value)| {
                    matches!(
                        key.as_str(),
                        "input" | "output" | "cacheRead" | "cacheWrite"
                    ) && value.as_f64().is_some_and(|number| {
                        number.is_finite() && (0.0..=1_000_000_000.0).contains(&number)
                    })
                })
            }),
            "limit" => value.as_object().is_some_and(|limit| {
                limit.iter().all(|(key, value)| {
                    matches!(key.as_str(), "context" | "output")
                        && value
                            .as_u64()
                            .is_some_and(|number| number <= 1_000_000_000_000)
                })
            }),
            "knowledge" | "releaseDate" | "lastUpdated" => value.as_str().is_some_and(|value| {
                value.chars().count() <= 64 && !value.chars().any(char::is_control)
            }),
            _ => false,
        };
        if !valid {
            return Err(invalid());
        }
    }
    Ok(())
}

fn text_list(value: &Value, count: usize, length: usize) -> bool {
    value.as_array().is_some_and(|values| {
        values.len() <= count
            && values.iter().all(|value| {
                value.as_str().is_some_and(|value| {
                    !value.is_empty()
                        && value.chars().count() <= length
                        && !value.chars().any(char::is_control)
                })
            })
    })
}

fn parse(value: &Value) -> Result<Vec<ManagedModel>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let mut items: Vec<ManagedModel> = serde_json::from_value(value.clone())
        .map_err(|_| "已保存的模型目录格式无效，未覆盖原配置")?;
    if items.len() > MAX_MODELS {
        return Err("模型数量超过上限".into());
    }
    let mut ids = HashSet::new();
    for item in &mut items {
        validate(item)?;
        // Every older consumer of list() still uses enabled. Keep archived
        // records unavailable there as well as in the new management API.
        if item.archived == Some(true) {
            item.enabled = false;
        }
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
        .find(|item| item.published() && item.id.eq_ignore_ascii_case(id.trim()))
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
        .filter(|model| model.published() && key_scope::allows_model(scope, &model.id))
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
    for model in list().into_iter().filter(ManagedModel::published) {
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
    let accounts: Vec<_> = snapshot.accounts.iter().map(|account| account.as_ref().clone()).collect();
    let profiles = super::routing_discovery::effective_profiles(&config::routing_profiles(), &accounts);
    for group in profiles.groups.values().filter(|group| group.enabled && !group.hidden) {
        let projection = super::routing_groups::project_with_groups(group, &profiles.groups, &accounts, &Default::default(), None);
        for candidate in &projection.accounts {
            result
                .entry(super::routing::provider_of(candidate).to_string())
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
        .available_providers
        .iter()
        .filter(|provider| provider_enabled(provider))
        .cloned()
        .collect();
    providers.sort();
    let mut choices = Vec::new();
    for provider in providers {
        let models = custom_providers::get(&provider)
            .and_then(|item| item.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_else(|| providers::catalog::manifest_for_provider(&provider));
        let bindings: Vec<_> = models
            .iter()
            .map(|item| Binding {
                provider: provider.clone(),
                model: model_id(item),
            })
            .collect();
        let accounts: Vec<_> = snapshot
            .accounts
            .iter()
            .filter(|account| {
                bindings
                    .iter()
                    .any(|binding| account_matches(account, binding))
            })
            .collect();
        let models: Vec<_> = models.iter().zip(&bindings)
            .filter(|(_, binding)| !binding.model.is_empty()
                && accounts.iter().any(|account| account_matches(account, binding)))
            .map(|(item, binding)| json!({ "id": binding.model,
                "name": item.get("name"), "kind": if providers::images::model_is_image(item) { "image" } else { "chat" },
                "capabilities": capability::effective(item) })).collect();
        if models.is_empty() {
            continue;
        }
        choices.push(
            json!({ "id": provider, "name": providers::label_of(&provider),
            "models": models, "accountCount": accounts.len() }),
        );
    }
    choices
}

pub fn management(store: &AccountStore) -> Result<Value, String> {
    let snapshot = config::current();
    let raw = snapshot.raw().get(KEY).unwrap_or(&Value::Null);
    let models = parse(raw)?;
    Ok(
        json!({ "models": models, "revision": revision_of(raw), "sources": choices(store),
        "routingGroups": super::routing_discovery::snapshot(store).groups.values().collect::<Vec<_>>() }),
    )
}

fn validate_sources(model: &ManagedModel, previous: Option<&ManagedModel>) -> Result<(), String> {
    let mut kind = None;
    for binding in &model.bindings {
        let item = match source(&binding.provider, &binding.model) {
            Some(item) => item,
            None if previous.is_some_and(|old| old.bindings.contains(binding)) => continue,
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
    Ok(())
}

fn check_group_conflict(model: &ManagedModel) -> Result<(), String> {
    // Routing-group writes hold the same config update lock.
    if config::routing_profiles()
        .groups
        .values()
        .any(|group| group.model.eq_ignore_ascii_case(&model.id))
    {
        return Err("对外模型 ID 已被路由组占用".into());
    }
    Ok(())
}

fn stamp(model: &mut ManagedModel, now: &str) {
    if model.created_at.is_none() {
        model.created_at = Some(now.to_string());
    }
    model.updated_at = Some(now.to_string());
    if model.archived == Some(true) {
        model.enabled = false;
    }
}

pub fn save(previous_id: &str, model: Option<ManagedModel>, expected: &str) -> Result<(), String> {
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
            let mut model = model;
            if let Some(model) = &mut model {
                if let Some(previous) = models.iter().find(|item| item.id == previous_id) {
                    model.retain_metadata(previous);
                    validate_sources(model, Some(previous))?;
                } else {
                    validate_sources(model, None)?;
                    model.created_at = None;
                }
                validate(model)?;
                check_group_conflict(model)?;
                if models
                    .iter()
                    .any(|item| item.id != previous_id && item.id.eq_ignore_ascii_case(&model.id))
                {
                    return Err("对外模型 ID 已存在".into());
                }
                stamp(model, &chrono::Utc::now().to_rfc3339());
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

fn changed_models(
    mut existing: Vec<ManagedModel>,
    action: BatchAction,
    ids: &[String],
    mut additions: Vec<ManagedModel>,
    now: &str,
) -> Result<Vec<ManagedModel>, String> {
    if action == BatchAction::Create {
        if !ids.is_empty() || additions.is_empty() || additions.len() > 100 {
            return Err("每次请选择 1–100 个新模型，不能同时指定已有模型".into());
        }
        for model in &mut additions {
            validate(model)?;
            model.created_at = None;
            stamp(model, now);
        }
        existing.extend(additions);
        // Validation is performed on the complete candidate collection before
        // assigning raw config, so a late invalid/duplicate row rolls it all back.
        return parse(&json!(existing));
    }
    if !additions.is_empty() || ids.is_empty() || ids.len() > MAX_MODELS {
        return Err("请选择要操作的模型，不能同时添加新模型".into());
    }
    let mut selected = HashSet::new();
    for id in ids {
        if !valid_id(id) || !selected.insert(id.to_ascii_lowercase()) {
            return Err("所选模型 ID 无效或重复".into());
        }
        if !existing
            .iter()
            .any(|model| model.id.eq_ignore_ascii_case(id))
        {
            return Err(format!("待操作的模型不存在：{id}"));
        }
    }
    if action == BatchAction::Delete {
        existing.retain(|model| !selected.contains(&model.id.to_ascii_lowercase()));
        return Ok(existing);
    }
    for model in existing
        .iter_mut()
        .filter(|model| selected.contains(&model.id.to_ascii_lowercase()))
    {
        match action {
            BatchAction::Enable => {
                if model.archived == Some(true) {
                    return Err("请先恢复已归档的模型，再启用".into());
                }
                model.enabled = true;
            }
            BatchAction::Disable => model.enabled = false,
            BatchAction::Archive => {
                model.archived = Some(true);
                model.enabled = false;
            }
            BatchAction::Restore => {
                model.archived = Some(false);
                model.enabled = false;
            }
            BatchAction::Create | BatchAction::Delete => unreachable!(),
        }
        stamp(model, now);
    }
    Ok(existing)
}

pub fn batch(
    action: BatchAction,
    ids: &[String],
    additions: Vec<ManagedModel>,
    expected: &str,
) -> Result<(), String> {
    config::try_update_raw_field(
        KEY,
        |raw| {
            if revision_of(raw) != expected {
                return Err("模型目录已在其他位置修改，请刷新后重试；当前草稿仍然保留".to_string());
            }
            let existing = parse(raw)?;
            for model in &additions {
                validate(model)?;
                validate_sources(model, None)?;
                check_group_conflict(model)?;
            }
            let changed = changed_models(
                existing,
                action,
                ids,
                additions,
                &chrono::Utc::now().to_rfc3339(),
            )?;
            *raw = json!(changed);
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
            ..Default::default()
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
        assert!(validate(&item).is_ok());
        item = model();
        item.bindings.push(item.bindings[0].clone());
        assert!(validate(&item).is_err());
        assert!(parse(&json!([model(), model()])).is_err());
        assert!(parse(&json!({"models": []})).is_err());
    }

    #[test]
    fn legacy_records_keep_their_publication_and_metadata_defaults() {
        let legacy = json!({"id":"legacy","name":"Old model","enabled":true,
            "bindings":[{"provider":"channel-a","model":"private-upstream"}]});
        let parsed = parse(&json!([legacy.clone()])).unwrap();
        assert!(parsed[0].published());
        assert_eq!(serde_json::to_value(&parsed[0]).unwrap(), legacy);
        let empty = parse(&json!([{"id":"standalone"}])).unwrap();
        assert!(!empty[0].published());
        assert!(empty[0].bindings.is_empty());
    }

    #[test]
    fn metadata_round_trips_and_legacy_edits_preserve_it() {
        let rich = json!({"id":"rich","name":"Model","enabled":true,"bindings":[],
            "developer":"openai","type":"chat","icon":"OpenAI","group":"gpt","remark":"First\nSecond",
            "modelCard":{"reasoning":{"supported":true,"default":false},"reasoningEfforts":["low","high"],
                "toolCall":true,"temperature":false,"vision":true,"modalities":{"input":["text","image"],"output":["text"]},
                "cost":{"input":2,"output":8,"cacheRead":0.2},"limit":{"context":200000,"output":16000},"knowledge":"2026-01"},
            "createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z","archived":false});
        let stored = parse(&json!([rich.clone()])).unwrap().remove(0);
        assert_eq!(serde_json::to_value(&stored).unwrap(), rich);
        let mut edited: ManagedModel = serde_json::from_value(
            json!({"id":"rich","name":"Renamed","enabled":true,"bindings":[]}),
        )
        .unwrap();
        edited.retain_metadata(&stored);
        assert_eq!(edited.model_card, stored.model_card);
        assert_eq!(edited.developer.as_deref(), Some("openai"));
        assert_eq!(edited.created_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert_eq!(edited.remark.as_deref(), Some("First\nSecond"));
        assert_eq!(edited.name, "Renamed");
    }

    #[test]
    fn invalid_metadata_is_rejected_without_reinterpreting_capabilities() {
        for card in [
            json!([]),
            json!({"toolCall":"yes"}),
            json!({"reasoning":{"supported":1}}),
            json!({"cost":{"input":-1}}),
            json!({"limit":{"output":1.5}}),
            json!({"modalities":{"input":"image"}}),
            json!({"unknown":true}),
        ] {
            let mut invalid = model();
            invalid.model_card = Some(card);
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = model();
        invalid.remark = Some("x".repeat(4001));
        assert!(validate(&invalid).is_err());
        invalid.remark = None;
        invalid.model_type = Some("unknown".into());
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn batches_validate_every_row_before_returning_a_new_catalog() {
        let now = "2026-11-08T00:00:00Z";
        let existing = vec![model()];
        let fresh: ManagedModel = serde_json::from_value(json!({"id":"new"})).unwrap();
        assert!(changed_models(
            existing.clone(),
            BatchAction::Create,
            &[],
            vec![fresh.clone(), model()],
            now
        )
        .is_err());
        assert!(changed_models(
            existing.clone(),
            BatchAction::Create,
            &[],
            vec![fresh.clone(); 101],
            now
        )
        .is_err());
        assert!(changed_models(
            existing.clone(),
            BatchAction::Enable,
            &["public".into(), "missing".into()],
            vec![],
            now
        )
        .is_err());
        assert!(changed_models(
            existing.clone(),
            BatchAction::Delete,
            &["public".into(), "PUBLIC".into()],
            vec![],
            now
        )
        .is_err());
        let added = changed_models(existing, BatchAction::Create, &[], vec![fresh], now).unwrap();
        assert_eq!(added.len(), 2);
        assert!(!added[1].enabled);
        assert_eq!(added[1].created_at.as_deref(), Some(now));
    }

    #[test]
    fn archived_models_stay_unpublished_until_restored_then_enabled() {
        let now = "2026-11-08T00:00:00Z";
        let ids = vec!["public".into()];
        let archived =
            changed_models(vec![model()], BatchAction::Archive, &ids, vec![], now).unwrap();
        assert!(!archived[0].enabled);
        assert!(selected(&archived, "public").is_none());
        assert!(changed_models(archived.clone(), BatchAction::Enable, &ids, vec![], now).is_err());
        let mut inconsistent = serde_json::to_value(&archived).unwrap();
        inconsistent[0]["enabled"] = true.into();
        assert!(
            !parse(&inconsistent).unwrap()[0].enabled,
            "Older list consumers must see archived models as disabled"
        );
        let restored = changed_models(archived, BatchAction::Restore, &ids, vec![], now).unwrap();
        assert!(!restored[0].enabled);
        assert_eq!(restored[0].bindings, model().bindings);
        let enabled = changed_models(restored, BatchAction::Enable, &ids, vec![], now).unwrap();
        assert!(selected(&enabled, "public").is_some());
        assert!(
            changed_models(enabled, BatchAction::Delete, &ids, vec![], now)
                .unwrap()
                .is_empty()
        );
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
