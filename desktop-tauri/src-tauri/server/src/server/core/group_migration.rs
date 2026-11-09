//! One atomic, repeatable transition from the two legacy model surfaces to groups.
//! The backup is kept in kv alongside the new groups; credentials are never copied
//! or rewritten here. Invalid or colliding legacy input aborts the whole update.
use std::collections::HashSet;
use std::sync::Mutex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use crate::server::config::{self, RoutingGroup, RoutingProfile, RoutingProfiles, RoutingSettings};
use super::{account_store::AccountStore, managed_models::{self, Binding}, routing};

const MIGRATION: &str = "routingGroupsMigrationV1";
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn last_error() -> Option<String> { LAST_ERROR.lock().unwrap_or_else(|error| error.into_inner()).clone() }

pub fn run(store: &AccountStore) -> Result<usize, String> {
    let accounts = routing::accounts_of(&store.list_accounts());
    let settings = config::routing_settings();
    let result = config::try_update_raw(|raw| migrate(raw, &accounts, settings, &|provider, model| {
        managed_models::source(provider, model).or_else(|| {
            super::plugin_host::rpc_cache::migration_models(provider)?.into_iter()
                .find(|item| super::models::model_id(item).eq_ignore_ascii_case(model))
        })
    }));
    *LAST_ERROR.lock().unwrap_or_else(|error| error.into_inner()) = result.as_ref().err().cloned();
    result
}

fn migrate(raw: &mut Map<String, Value>, accounts: &[Value], settings: RoutingSettings,
    source: &impl Fn(&str, &str) -> Option<Value>) -> Result<usize, String> {
    if raw.get(MIGRATION).and_then(|value| value.get("version")).and_then(Value::as_u64) == Some(1) { return Ok(0); }
    let old_models = raw.get(managed_models::KEY).cloned().unwrap_or(Value::Null);
    let old_routing = raw.get(config::KEY_ROUTING_PROFILES).cloned().unwrap_or_else(|| json!({}));
    let models = managed_models::parse(&old_models)?;
    let mut profiles: RoutingProfiles = serde_json::from_value(old_routing.clone())
        .map_err(|error| format!("旧路由配置格式无效，未迁移：{error}"))?;
    let mut occupied = HashSet::new();
    for (id, group) in &profiles.groups {
        config::routing_groups::validate(group)?;
        if id != &group.id || !occupied.insert(group.model.to_ascii_lowercase()) {
            return Err("已有路由组包含重复标识，未覆盖原配置".into());
        }
    }
    for profile in profiles.models.values().chain(profiles.global.iter()) { config::validate_routing_profile(profile)?; }
    let mut pending = Vec::new();
    for model in &models {
        let profile = profiles.models.iter().find(|(id, _)| id.eq_ignore_ascii_case(&model.id)).map(|(_, value)| value)
            .or(profiles.global.as_ref());
        let group = convert(&model.id, &model.name, model.remark.as_deref().unwrap_or(""), model.enabled && model.archived != Some(true),
            &model.bindings, model.model_type.as_deref() == Some("image_generation"), profile, &profiles, accounts, settings, source)?;
        pending.push(group);
    }
    for (id, profile) in &profiles.models {
        if models.iter().any(|model| model.id.eq_ignore_ascii_case(id)) { continue; }
        if profiles.groups.values().any(|group| group.model.eq_ignore_ascii_case(id)) {
            return Err(format!("旧模型路由「{id}」与已有路由组重名，未覆盖原配置"));
        }
        let mut providers = profile.providers.clone();
        if profile.scope() == config::RoutingProviderScope::All {
            for account in accounts {
                let provider = routing::provider_of(account).to_string();
                if !providers.contains(&provider) { providers.push(provider); }
            }
        }
        let bindings: Vec<_> = providers.into_iter().map(|provider| Binding {provider, model:id.clone()}).collect();
        pending.push(convert(id, id, "", false, &bindings, false, Some(profile), &profiles, accounts, settings, source)?);
    }
    let count = pending.len();
    for mut group in pending {
        if !occupied.insert(group.model.to_ascii_lowercase()) {
            return Err(format!("旧模型「{}」与已有路由组重名，未覆盖原配置", group.model));
        }
        let base = group.id.clone();
        let mut suffix = 1;
        while profiles.groups.contains_key(&group.id) { group.id = format!("{base}-{suffix}"); suffix += 1; }
        config::routing_groups::validate(&group)?;
        profiles.group_order.push(group.id.clone());
        profiles.groups.insert(group.id.clone(), group);
    }
    if profiles.groups.len() > config::routing_groups::MAX_GROUPS { return Err("迁移后的路由组超过数量上限，未覆盖原配置".into()); }
    profiles.models.clear();
    // Serialize everything before touching raw: transformation errors are atomic
    // even for callers that do not use the configuration transaction helper.
    let routing = serde_json::to_value(profiles).map_err(|error| error.to_string())?;
    raw.insert(MIGRATION.into(), json!({"version":1,"createdAt":crate::server::logging::now_ms(),
        "managedModels":old_models,"routingProfiles":old_routing,"migratedGroups":count}));
    raw.remove(managed_models::KEY);
    raw.insert(config::KEY_ROUTING_PROFILES.into(), routing);
    Ok(count)
}

#[allow(clippy::too_many_arguments)]
fn convert(id: &str, name: &str, description: &str, enabled: bool, bindings: &[Binding], image_hint: bool,
    profile: Option<&RoutingProfile>, profiles: &RoutingProfiles, accounts: &[Value], settings: RoutingSettings,
    source: &impl Fn(&str, &str) -> Option<Value>) -> Result<RoutingGroup, String> {
    let mut settings = profiles.settings_for("", settings);
    if let Some(profile) = profile {
        if let Some(strategy) = &profile.strategy { settings.strategy = config::RouteStrategy::from_id(strategy); }
        if let Some(sticky) = &profile.sticky { settings.sticky = config::StickyMode::from_id(sticky); }
    }
    let mut bindings = bindings.to_vec();
    if let Some(profile) = profile {
        bindings.sort_by_key(|binding| profile.providers.iter().position(|id| id == &binding.provider).unwrap_or(usize::MAX));
    }
    let mut kinds = HashSet::new();
    let mut members = Vec::new();
    for (index, binding) in bindings.iter().enumerate() {
        if let Some(item) = source(&binding.provider, &binding.model) {
            kinds.insert(super::providers::images::model_is_image(&item));
        } else if !super::plugin_host::serves_provider(&binding.provider)
            && super::plugin_host::PackRegistry::load().provider_enabled(&binding.provider) {
            // Plugin catalogs are restored asynchronously. Do not guess chat and
            // permanently mark the migration complete before that catalog is ready.
            return Err(format!("提供商「{}」的模型清单尚未加载，稍后重试迁移", binding.provider));
        }
        let included = profile.map_or(true, |profile| profile.includes_provider(&binding.provider));
        let restricted = profile.is_some_and(|profile| !profile.excluded_accounts.is_empty()
            || profile.account_order.get(&binding.provider).is_some_and(|ids| !ids.is_empty()));
        let mut selected = profile.and_then(|profile| profile.account_order.get(&binding.provider)).cloned().unwrap_or_default();
        let mut provider_accounts: Vec<_> = accounts.iter().filter(|account| routing::provider_of(account) == binding.provider).collect();
        provider_accounts.sort_by_key(|account| account.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX));
        for account in provider_accounts {
            if let Some(id) = routing::account_id(account) { if !selected.iter().any(|known| known == id) { selected.push(id.into()); } }
        }
        if let Some(profile) = profile { selected.retain(|id| !profile.excluded_accounts.contains(id)); }
        members.push(json!({"id":format!("member-{index}"),"provider":binding.provider,"model":binding.model,
            "included":included,"accountScope":if restricted {"selected"} else {"all"},
            "accounts":if restricted {selected} else {Vec::new()}}));
    }
    if kinds.len() > 1 { return Err(format!("旧模型「{id}」同时关联对话和生图渠道，请先分开配置；原数据已保留")); }
    let image = kinds.iter().next().copied().unwrap_or(image_hint);
    let digest = format!("{:x}", Sha256::digest(id.to_ascii_lowercase().as_bytes()));
    serde_json::from_value(json!({"id":format!("migrated-{}", &digest[..24]),"model":id,
        "name":if name.trim().is_empty() {id.chars().take(64).collect::<String>()} else {name.chars().take(64).collect::<String>()},
        "description":description.chars().take(500).collect::<String>(),"kind":if image {"image"} else {"chat"},
        "enabled":enabled,"strategy":settings.strategy.as_str(),"sticky":settings.sticky.as_str(),"members":members}))
        .map_err(|error| format!("迁移模型「{id}」失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Map<String, Value> {
        json!({"managedModels":[{"id":"AliasCase","enabled":true,"bindings":[{"provider":"custom-a","model":"wire"}]}],
            "routingProfiles":{"models":{"aliascase":{"providers":["custom-a"],"accountOrder":{"custom-a":["missing","excluded","kept"]},"excludedAccounts":["excluded"],"strategy":"rotate","sticky":"turn"}}},
            "apiKeys":[{"allowedModels":["AliasCase","unavailable"]}]}).as_object().unwrap().clone()
    }
    #[test]
    fn migration_keeps_missing_selected_accounts_and_keys_and_is_idempotent() {
        let mut raw = fixture(); let original = raw.clone();
        let accounts = vec![json!({"id":"kept","provider":"custom-a"}),json!({"id":"excluded","provider":"custom-a"})];
        assert_eq!(migrate(&mut raw, &accounts, Default::default(), &|_,_| None).unwrap(), 1);
        let group = raw[config::KEY_ROUTING_PROFILES]["groups"].as_object().unwrap().values().next().unwrap();
        assert_eq!(group["model"], "AliasCase"); assert_eq!(group["strategy"], "rotate"); assert_eq!(group["sticky"], "turn");
        assert_eq!(group["members"][0]["accounts"], json!(["missing","kept"]));
        assert_eq!(raw["apiKeys"], original["apiKeys"]);
        assert_eq!(raw[MIGRATION]["managedModels"], original["managedModels"]);
        let once = raw.clone(); assert_eq!(migrate(&mut raw, &accounts, Default::default(), &|_,_| None).unwrap(), 0); assert_eq!(raw, once);
    }
    #[test]
    fn migration_does_not_modify_corrupt_or_colliding_input() {
        let mut raw = fixture(); raw["managedModels"] = json!([{"id":"AliasCase","enabled":true,"bindings":[]},{"id":"aliascase","bindings":[]}]);
        let before = raw.clone(); assert!(migrate(&mut raw, &[], Default::default(), &|_,_| None).is_err()); assert_eq!(raw,before);
        let mut raw = fixture(); raw[config::KEY_ROUTING_PROFILES]["groups"] = json!({"existing":{"id":"existing","model":"aliascase","name":"Existing","strategy":"order","sticky":"off","members":[]}});
        let before = raw.clone(); assert!(migrate(&mut raw, &[], Default::default(), &|_,_| None).is_err()); assert_eq!(raw,before);
    }
    #[test]
    fn missing_sources_keep_image_kind_and_orphan_profiles_stay_disabled() {
        let mut raw = fixture(); raw["managedModels"][0]["type"] = "image_generation".into();
        raw[config::KEY_ROUTING_PROFILES]["models"]["orphan"] = json!({"providers":["custom-a"]});
        migrate(&mut raw, &[], Default::default(), &|_,_| None).unwrap();
        let groups = raw[config::KEY_ROUTING_PROFILES]["groups"].as_object().unwrap();
        assert_eq!(groups.values().find(|group| group["model"] == "AliasCase").unwrap()["kind"], "image");
        assert_eq!(groups.values().find(|group| group["model"] == "orphan").unwrap()["enabled"], false);
    }
}
