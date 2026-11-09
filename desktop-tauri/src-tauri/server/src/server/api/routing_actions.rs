//! Atomic routing collection operations; all imports remain disabled until review.
use std::collections::HashSet;
use axum::{body::Bytes, extract::State, response::Response};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::server::{config, errors, http::{ok_json, parse_body}, ServerState};
use crate::server::core::{routing, routing_discovery, routing_groups};

pub fn revision(profiles: &config::RoutingProfiles) -> String {
    format!("{:x}",Sha256::digest(serde_json::to_vec(profiles).unwrap_or_default()))
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Action {
    action: String,
    #[serde(default)] revision: String,
    #[serde(default)] id: String,
    #[serde(default)] ids: Vec<String>,
    #[serde(default)] enabled: Option<bool>,
    #[serde(default)] hidden: Option<bool>,
    #[serde(default)] name: Option<String>,
    #[serde(default)] model: Option<String>,
    #[serde(default)] groups: Vec<config::RoutingGroup>,
    #[serde(default)] version: Option<u32>,
}

pub async fn post_action(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body).and_then(|value| serde_json::from_value::<Action>(value)
        .map_err(|error| errors::GatewayError::bad_request(error.to_string()))) {
        Ok(value) => value, Err(error) => return errors::management_error(400,error.message),
    };
    if payload.action == "refreshMetadata" {
        let result = crate::server::core::model_meta::refresh(true, 86_400_000).await;
        let mut body = super::routing_groups::groups_json(&state); body["refreshResult"] = result;
        return ok_json(body);
    }
    match tokio::task::spawn_blocking(move || apply(&state,payload)).await {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err(error)) => errors::management_error(if error.starts_with("路由配置已在其他位置修改") {409} else {400},error),
        Err(error) => errors::management_error(500,error.to_string()),
    }
}

fn copied(group: &config::RoutingGroup, payload: &Action) -> config::RoutingGroup {
    let mut result = group.clone();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    result.id = format!("route-{stamp:x}");
    result.model = payload.model.clone().unwrap_or_else(|| format!("group/{}",result.id));
    result.name = payload.name.clone().unwrap_or_else(|| format!("{} · 副本",group.name.chars().take(58).collect::<String>()));
    result.enabled=false; result.auto=false; result.hidden=false;
    result
}

fn validate_collection(profiles:&config::RoutingProfiles,accounts:&[Value]) -> Result<(),String> {
    if profiles.groups.len()>config::routing_groups::MAX_GROUPS {return Err("路由组数量已达上限".into())}
    let effective = routing_discovery::effective_profiles(profiles,accounts);
    let mut seen=HashSet::new();
    for group in profiles.groups.values() {
        config::routing_groups::validate(group)?;
        config::routing_groups::validate_graph(group,&effective.groups)?;
        if !seen.insert(group.model.to_lowercase()) {
            return Err("对外模型 ID 已被其他路由组占用".into());
        }
    }
    Ok(())
}

fn apply(state:&ServerState,payload:Action)->Result<Value,String> {
    let accounts=routing::accounts_of(&state.store().list_visible_accounts());
    let found=routing_discovery::found_groups(&accounts);
    let mut selected=None; let mut imported=Vec::new();
    config::try_update_raw_field(config::KEY_ROUTING_PROFILES,|raw| {
        let map=serde_json::Map::from_iter([(config::KEY_ROUTING_PROFILES.to_string(),raw.clone())]);
        let mut profiles=(*config::routing_profiles_from_raw(&map)).clone();
        if revision(&profiles)!=payload.revision { return Err("路由配置已在其他位置修改，请刷新后重试；草稿未丢失".into()) }
        match payload.action.as_str() {
            "discovery" => {profiles.auto_groups_enabled=payload.enabled.ok_or("缺少自动发现开关")?;}
            "hide" => {
                if !found.iter().any(|group| group.id==payload.id) && !profiles.hidden_auto_groups.contains(&payload.id) {return Err("自动路由组不存在".into())}
                let hidden=payload.hidden.ok_or("缺少隐藏开关")?;
                profiles.hidden_auto_groups.retain(|id|id!=&payload.id);
                if hidden {profiles.hidden_auto_groups.push(payload.id.clone());}
            }
            "copy" => {
                let source=profiles.groups.get(&payload.id).or_else(||found.iter().find(|group|group.id==payload.id)).ok_or("路由组不存在")?;
                let copy=copied(source,&payload); selected=Some(copy.id.clone());
                profiles.groups.insert(copy.id.clone(),copy);
            }
            "import" => {
                if payload.version.is_some_and(|version|version!=1) {return Err("不支持此路由导出版本".into())}
                if payload.groups.is_empty() || payload.groups.len()>100 {return Err("每次可导入 1 到 100 个路由组".into())}
                for group in &payload.groups {
                    if profiles.groups.contains_key(&group.id) {return Err(format!("路由组标识已存在：{}",group.id))}
                    let mut group=group.clone(); group.enabled=false; group.auto=false; group.hidden=false;
                    // Dropping only a directory condition would broaden a rule.
                    // Omit that entire local-machine rule from portable imports.
                    group.rules.retain(|rule|rule.folders.is_empty() && rule.except_folders.is_empty());
                    routing_groups::validate_members(&group,None,&accounts)?;
                    imported.push(group.id.clone()); profiles.groups.insert(group.id.clone(),group);
                }
            }
            "arrange" => {
                let all:HashSet<_>=profiles.groups.keys().chain(found.iter().map(|group|&group.id)).cloned().collect();
                if payload.ids.len()>config::routing_groups::MAX_GROUPS || payload.ids.iter().any(|id|!all.contains(id))
                    || payload.ids.iter().collect::<HashSet<_>>().len()!=payload.ids.len() {return Err("路由组顺序无效".into())}
                profiles.group_order=payload.ids.clone();
            }
            _=>return Err("未知的路由操作".into()),
        }
        validate_collection(&profiles,&accounts)?;
        *raw=json!(profiles); Ok(())
    },||"路由配置保存失败，未应用修改".to_string())?;
    state.upstream().clear_route_sticky(None,None);
    crate::server::core::providers::catalog::invalidate();
    let mut response=super::routing_groups::groups_json(state);
    if let Some(id)=selected {response["selectedId"]=id.into();}
    if !imported.is_empty() {response["importedIds"]=json!(imported);}
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collection_revision_covers_publication_and_hidden_state() {
        let mut profiles=config::RoutingProfiles::default(); let before=revision(&profiles);
        profiles.auto_groups_enabled=true;assert_ne!(before,revision(&profiles));
        let before=revision(&profiles);profiles.hidden_auto_groups.push("auto-one".into());assert_ne!(before,revision(&profiles));
    }
}
