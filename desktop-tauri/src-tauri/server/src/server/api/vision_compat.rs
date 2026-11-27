use std::collections::HashSet;

use axum::{body::Bytes, extract::State, response::Response};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::config::vision_compat::{
    self, Fallback, Mode, ModelRef, ModelSource, OverrideMode, UnknownCapability, VisionSettings, VisionTarget,
};
use crate::server::core::{capability, providers::catalog, routing_groups};
use crate::server::errors::{self, GatewayError};
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

fn shared_target() -> Option<VisionTarget> { vision_compat::shared_target() }

/// 把旧版（全局二选一 + 模型单独配置）展开成两块的模型名单。
///
/// 旧语义是「除了单独配过的，其余模型一律按全局方式处理」，新形态只能列具体模型，
/// 所以这里把**确实会走兼容**的模型按旧语义分到两块名单里：
///   · 模型单独配置是逐个模型写死的，与目录里当下有没有这只模型无关，先原样搬过去
///     —— 只有它在名单里，用户没配账号时才不会把这条设置悄悄弄丢；
///   · 全局方式按当前目录展开：已确认支持图片的模型本来就放行，不进名单；
///     能力未知的模型只在「图片能力未知时 = 直接按设置兼容」时才参与，与运行时判定一致。
///
/// 展开只是把等价语义写成新形式，不改变任何一条请求的处理结果。
fn expand_legacy(settings: &mut VisionSettings, choices: &[Value]) {
    if !settings.is_legacy() { return; }
    let include_unknown = settings.unknown_capability == UnknownCapability::Compat;
    let overrides = settings.overrides.clone();
    let mut listed: HashSet<(String, String)> = HashSet::new();
    for entry in &overrides {
        listed.insert((entry.provider.to_lowercase(), entry.model.to_lowercase()));
        match entry.mode {
            OverrideMode::Assist => settings.assist.models.push(ModelRef::new(&entry.provider, &entry.model)),
            OverrideMode::Reroute => settings.reroute.models.push(ModelRef::new(&entry.provider, &entry.model)),
            OverrideMode::Off => {}
        }
    }
    for choice in choices {
        let provider = choice["provider"].as_str().unwrap_or("");
        let model = choice["model"].as_str().unwrap_or("");
        if provider.is_empty() || model.is_empty() { continue; }
        if listed.contains(&(provider.to_lowercase(), model.to_lowercase())) { continue; }
        match choice["capabilities"]["supportsImages"].as_bool() {
            Some(true) => continue,
            None if !include_unknown => continue,
            _ => {}
        }
        match settings.legacy_mode(provider, model) {
            Some(Mode::Assist) => settings.assist.models.push(ModelRef::new(provider, model)),
            Some(Mode::Reroute) => settings.reroute.models.push(ModelRef::new(provider, model)),
            None => {}
        }
    }
    settings.clear_legacy();
}

fn group_choices(state: &ServerState) -> Vec<Value> {
    let snapshot = state.store().routing_snapshot();
    let accounts: Vec<_> = snapshot.accounts.iter().map(|account| account.as_ref().clone()).collect();
    let profiles = crate::server::core::routing_discovery::effective_profiles(&crate::server::config::routing_profiles(), &accounts);
    profiles.groups.values().filter(|group| group.enabled && !group.kind.is_image()).map(|group| {
        let projection = routing_groups::project_with_groups(group, &profiles.groups, &accounts, &Default::default(), None);
        let images = projection.accounts.iter().any(|account| {
            let provider = crate::server::core::routing::provider_of(account);
            routing_groups::candidate_model(account).and_then(|model| routing_groups::catalog_model(provider, model))
                .and_then(|item| capability::images_for_channel(provider, &item)) == Some(true)
        });
        json!({"provider":vision_compat::GROUP_PROVIDER,"providerLabel":"路由组","model":group.model,"id":group.model,
            "name":group.name,"kind":"chat","capabilities":{"supportsImages":images},"supports_images":images,
            "accountCount":projection.accounts.len()})
    }).collect()
}

fn view(state: &ServerState) -> Result<Value, GatewayError> {
    let snapshot = vision_compat::current();
    let settings = snapshot.settings.as_ref().map_err(|error| GatewayError::new(error.clone()))?;
    let mut choices = routing_groups::choices(&state.store());
    for choice in &mut choices {
        let provider = choice["provider"].as_str().unwrap_or("");
        let model = choice["model"].as_str().unwrap_or("");
        let images = routing_groups::catalog_model(provider, model)
            .and_then(|item| capability::images_for_channel(provider, &item));
        choice["capabilities"]["supportsImages"] = json!(images);
    }
    choices.extend(group_choices(state));
    let legacy = settings.is_legacy();
    let mut settings = settings.clone();
    expand_legacy(&mut settings, &choices);
    // 两块设置折成规则列表（旧配置到这里就换成新形状）；再把规则投影回两块，
    // 手机端与旧界面按两块读写，投影让它们继续看到真实配置。
    settings.fold_blocks();
    settings.project_blocks();
    let mut config = serde_json::to_value(&settings).map_err(|error| GatewayError::new(error.to_string()))?;
    if settings.rules.len() <= 1 {
        let rule = settings.rules.first();
        config["sources"] = json!(rule.into_iter().flat_map(|rule| &rule.models)
            .filter(|entry| entry.provider == vision_compat::GROUP_PROVIDER).map(|entry| &entry.model).collect::<Vec<_>>());
        config["target"] = json!(rule.and_then(|rule| rule.target.as_ref())
            .filter(|target| target.provider == vision_compat::GROUP_PROVIDER).map(|target| target.model.as_str()).unwrap_or(""));
    }
    Ok(json!({
        "config": config, "revision": snapshot.revision,
        "models": choices, "sharedTarget": shared_target(),
        "maxTargets": vision_compat::MAX_TARGETS, "maxModels": vision_compat::MAX_MODELS,
        "legacyExpanded": legacy,
    }))
}

fn response(result: Result<Value, GatewayError>) -> Response {
    match result {
        Ok(value) => ok_json(value),
        Err(error) => errors::management_error(error.status_code, error.message),
    }
}

pub async fn get_settings(State(state): State<ServerState>) -> Response {
    match tokio::task::spawn_blocking(move || view(&state)).await {
        Ok(result) => response(result),
        Err(error) => errors::management_error(500, error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveSettings {
    config: Value,
    revision: String,
    /// 旧版客户端会带这个字段（保存前的人工授权确认）。现在改完即生效，不再校验它，
    /// 保留声明只是为了不让老客户端直接拿到 400。
    #[serde(default)]
    #[allow(dead_code)]
    consent: bool,
}

fn validate_available(state: &ServerState, target: &VisionTarget) -> Result<(), GatewayError> {
    if target.provider == vision_compat::GROUP_PROVIDER {
        if !group_choices(state).iter().any(|choice| choice["model"].as_str().is_some_and(|model| model.eq_ignore_ascii_case(&target.model))
            && choice["supports_images"] == true) {
            return Err(GatewayError::bad_request("所选视觉路由组没有可用的图片成员"));
        }
        return Ok(());
    }
    let item = routing_groups::catalog_model(&target.provider, &target.model)
        .ok_or_else(|| GatewayError::bad_request("所选视觉模型已不在提供商目录中，请重新选择"))?;
    if capability::images_for_channel(&target.provider, &item) != Some(true) {
        return Err(GatewayError::bad_request("请选择已确认支持图片的视觉模型；能力未声明时请先在模型管理中确认"));
    }
    if !catalog::forwarding_providers(&target.model).contains(&target.provider) {
        return Err(GatewayError::bad_request("所选视觉模型尚未启用，请先在模型管理中启用"));
    }
    Ok(())
}

pub async fn put_settings(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body).and_then(|value| serde_json::from_value::<SaveSettings>(value)
        .map_err(|error| GatewayError::bad_request(format!("图片兼容设置不完整：{error}")))) {
        Ok(payload) => payload,
        Err(error) => return response(Err(error)),
    };
    match tokio::task::spawn_blocking(move || {
        // 校验按「折成规则之后」的那一份来（手机端发的只有两块设置）；
        // 但保存仍交原始载荷给 config::save —— 「同一种方式已有多条规则」那条
        // 拦截要在它那边判，它才拿得到保存前的旧配置。
        if payload.config.get("sources").is_some() && payload.config.get("rules").is_none()
            && vision_compat::current().settings.as_ref().is_ok_and(|settings| settings.rules.len() > 1) {
            return Err(GatewayError::bad_request("已有多条图片兼容规则，请使用完整规则编辑器，未覆盖现有配置"));
        }
        let settings = vision_compat::settings_from_value(&payload.config).map_err(GatewayError::bad_request)?;
        let mut normalized = settings.clone();
        normalized.fold_blocks();
        vision_compat::validate(&normalized).map_err(GatewayError::bad_request)?;
        if normalized.enabled {
            for rule in normalized.rules.iter().filter(|rule| rule.enabled && !rule.models.is_empty()) {
                match rule.mode {
                    Mode::Assist => {
                        let target = match rule.source {
                            ModelSource::Shared => shared_target(),
                            ModelSource::Custom => rule.target.clone(),
                        }.ok_or_else(|| GatewayError::bad_request("请先配置辅助识图的视觉模型"))?;
                        validate_available(&state, &target)?;
                    }
                    Mode::Reroute => {
                        if rule.fallback == Fallback::Designated {
                            for target in &rule.targets { validate_available(&state, target)?; }
                        }
                    }
                }
            }
        }
        vision_compat::save(settings, &payload.revision)?;
        view(&state)
    }).await {
        Ok(result) => response(result),
        Err(error) => errors::management_error(500, error.to_string()),
    }
}
