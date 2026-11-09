//! Derived same-model groups. Discovery never writes configuration or publishes
//! upstream models; explicit opt-in controls whether suggestions become routes.
use std::collections::{BTreeMap, HashSet};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::server::config::{RoutingGroup, RoutingProfiles};
use super::{custom_providers, models::model_id, providers, routing, routing_metadata};

fn stable_id(prefix: &str, identity: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let slug: String = identity.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' {ch} else {'-'})
        .take(70).collect();
    format!("{prefix}-{slug}-{}", &digest[..12])
}

pub fn source_models(accounts: &[Value]) -> Vec<Value> {
    let providers: std::collections::BTreeSet<_> = accounts.iter().filter(|account|
        account.get("hasCredentials") == Some(&Value::Bool(true)))
        .map(|account| routing::provider_of(account).to_string()).collect();
    let mut rows = Vec::new();
    for provider in providers {
        if !super::account_store::store_view::account_visible(&provider) { continue; }
        let manifest = custom_providers::get(&provider).and_then(|owner| owner.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_else(|| providers::catalog::manifest_for_provider(&provider));
        for model in manifest {
            let id = model_id(&model);
            if id.is_empty() || providers::images::model_is_image(&model) { continue; }
            // A credential must actually include this model. Disabled accounts
            // remain visible for configuration, and become usable when re-enabled.
            if !accounts.iter().any(|account| routing::provider_of(account) == provider
                && account["hasCredentials"] == true
                && super::account_store::custom_accounts::key_groups::allows_model(account, &id)) { continue; }
            rows.push(json!({"provider":provider,"model":id,"name":model.get("name")}));
        }
    }
    rows
}

fn derive(rows: &[Value]) -> Vec<RoutingGroup> {
    let mut grouped: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    for row in rows {
        let (Some(provider), Some(model)) = (row["provider"].as_str(), row["model"].as_str()) else { continue };
        let identity = routing_metadata::describe(model);
        if identity.canonical_model.is_empty() || identity.canonical_model.len() > 220 { continue; }
        let models = grouped.entry(identity.canonical_model).or_default();
        // Each service appears once, independent of how many synonymous IDs it lists.
        let replace = models.get(provider).and_then(|old| old["model"].as_str()).map_or(true, |old| model < old);
        if replace { models.insert(provider.into(), row.clone()); }
    }
    grouped.into_iter().filter(|(_, providers)| providers.len() >= 2).filter_map(|(identity, providers)| {
        let first = providers.values().next()?;
        let meta = routing_metadata::describe(first["model"].as_str()?);
        let spelling = if super::routing_model_identity::canonical(&meta.spelling) == identity { meta.spelling.to_lowercase() } else { identity.clone() };
        let model = format!("auto/{spelling}");
        let name = meta.display_name.chars().take(64).collect::<String>();
        let members: Vec<_> = providers.into_iter().map(|(provider, source)| {
            let member_id = stable_id("source", &format!("{provider}\0{}", source["model"].as_str().unwrap_or("")));
            json!({"id":member_id,"provider":provider,"model":source["model"],"included":true,"accounts":[],"accountScope":"all","weight":1})
        }).collect();
        serde_json::from_value(json!({"id":stable_id("auto",&identity),"model":model,"name":name,
            "description":"","strategy":"smart","sticky":"auto","members":members,"auto":true,"enabled":true,
            "patience":0,"context":0,"family":meta.family})).ok()
    }).collect()
}

pub fn found_groups(accounts: &[Value]) -> Vec<RoutingGroup> { derive(&source_models(accounts)) }

pub fn effective_profiles(profiles: &RoutingProfiles, accounts: &[Value]) -> RoutingProfiles {
    let mut result = profiles.clone();
    if !profiles.auto_groups_enabled { return result; }
    merge_found(&mut result, found_groups(accounts), &HashSet::new());
    result
}

fn merge_found(profiles: &mut RoutingProfiles, found: Vec<RoutingGroup>, reserved: &HashSet<String>) {
    let occupied: HashSet<_> = profiles.groups.values().map(|group| group.model.to_lowercase())
        .chain(profiles.models.keys().map(|model| model.to_lowercase())).chain(reserved.iter().cloned()).collect();
    for group in found {
        if profiles.groups.contains_key(&group.id) || occupied.contains(&group.model.to_lowercase())
            || profiles.hidden_auto_groups.contains(&group.id) { continue; }
        profiles.groups.insert(group.id.clone(), group);
    }
}

pub fn snapshot(store: &super::account_store::AccountStore) -> RoutingProfiles {
    let accounts: Vec<_> = store.routing_snapshot().accounts.iter().map(|account| account.as_ref().clone()).collect();
    effective_profiles(&crate::server::config::routing_profiles(), &accounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_two_services_and_preserves_distinct_variants() {
        let groups = derive(&[json!({"provider":"one","model":"vendor/claude-sonnet-4.5"}),
            json!({"provider":"one","model":"claude-sonnet-4-5"}), json!({"provider":"two","model":"claude-sonnet-4p5"}),
            json!({"provider":"three","model":"claude-sonnet-4-5:free"}), json!({"provider":"one","model":"other"})]);
        assert_eq!(groups.len(),1); assert_eq!(groups[0].members.len(),2);
        assert!(groups[0].members.iter().all(|member| member.accounts.is_empty()
            && member.account_scope == crate::server::config::routing_groups::RoutingAccountScope::All));
        let mut reversed = groups[0].members.clone(); reversed.reverse();
        assert_ne!(stable_id("auto","model:free"),stable_id("auto","model-free"));
    }
    #[test]
    fn edited_hidden_and_reserved_routes_are_not_replaced_by_discovery() {
        let found = derive(&[json!({"provider":"one","model":"sample"}),json!({"provider":"two","model":"sample"})]);
        assert_eq!(found.len(),1);
        let mut profiles = RoutingProfiles::default();
        profiles.hidden_auto_groups.push(found[0].id.clone());
        merge_found(&mut profiles,found.clone(),&HashSet::new()); assert!(profiles.groups.is_empty());
        profiles.hidden_auto_groups.clear();
        merge_found(&mut profiles,found.clone(),&HashSet::from([found[0].model.clone()])); assert!(profiles.groups.is_empty());
        let mut saved = found[0].clone(); saved.strategy="order".into(); saved.auto=false;
        profiles.groups.insert(saved.id.clone(),saved);
        merge_found(&mut profiles,found,&HashSet::new()); assert_eq!(profiles.groups.values().next().unwrap().strategy,"order");
    }
}
