//! 网关 API Key 管理（网关 Key 页）：
//!
//! - `GET    /api/keys`          → `{keys: [{id,name,key,masked,enabled,createdAt,
//!                                  allowedProviders,allowedModels}], authRequired,
//!                                  providers, modelsByProvider}`
//! - `POST   /api/keys`          `{name?, key?, allowedProviders?, allowedModels?}` 新增；
//!                               key 留空自动生成
//! - `PATCH  /api/keys/{id}`     `{name?, enabled?, allowedProviders?, allowedModels?}`
//! - `DELETE /api/keys/{id}`
//!
//! 写接口都返回最新列表。明文 key 随列表返回：这是本机管理界面，用户要能随时复制
//! 某把 Key 给某个客户端；掩码只用于列表折叠展示。
//!
//! ── R9：可用提供商 / 可用模型（参考 OmniProxy）──────────────────
//! 两个白名单数组随记录读写，**空数组 = 不限制**（语义与字段说明见
//! `core::api_keys` 的模块头）。列表响应额外带两个候选表，让界面**不必维护
//! 第二份事实**：
//!   · `providers`（`{id,label,count}`）——只列启用、具有可用账号和上游模型的
//!     渠道，与模型编辑器的上游候选共用账号、凭据和 Key 分组权限判据。
//!   · `modelsByProvider`（渠道 → 手动发布的对外模型名）——「可用模型」候选。
//!     界面按所选渠道取并集；渠道未选择 = 全渠道，因此展示完整手动目录。
//!     已保存的失效限制仍保留在 Key 的白名单中，由界面单独展示并允许明确移除，
//!     不混入候选列表，也不因候选消失而自动清空限制。
//!
//! 写入侧在这一层做校验（`is_allowed_provider_id` 判 id 认不认识、元素必须是
//! 字符串），读取侧则一律宽容（理由见 `core::api_keys` 的模块头那条硬不变量：
//! 升级绝不能让已有 Key 失效）。校验放在写入侧而不是 core：core 是「存取 + 判定」，
//! 把「哪些值算合法」集中在一处入口更好改。

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::api_keys;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

fn list_json(state: &ServerState) -> Value {
    let entries = api_keys::list();
    let usable_key_count = entries.iter().filter(|entry| entry.is_usable()).count()
        + usize::from(crate::server::config::parse::env_api_key_value().is_some());
    let keys: Vec<Value> = entries.iter().map(api_keys::ApiKeyEntry::public_json).collect();
    // 候选只来自当前可用的上游；存量限制由各 Key 自身保留，不反向补回候选。
    let providers: Vec<_> = crate::server::core::managed_models::choices(&state.store())
        .into_iter()
        .map(|source| json!({ "id": source["id"], "label": source["name"],
            "count": source["accountCount"] }))
        .collect();
    json!({
        "keys": keys,
        "authRequired": true,
        "usableKeyCount": usable_key_count,
        "providers": providers,
        // 「可用模型」多选的候选：**每家 → 对外名清单**，界面按当前勾了哪几家
        // 取并集（见模块头那一节与 catalog::models_by_provider 的说明）。
        // 一次给全表而不是「按勾选返回并集」：勾选要即时联动，本地取并集零往返，
        // 也避免了「响应回来时用户已经改了勾选」的竞态。
        "modelsByProvider": crate::server::core::providers::catalog::models_by_provider(&state.store()),
    })
}

/// 「可用提供商」白名单里的一个 id 算不算数。
///
/// 两条路都算：内置家（注册表判据 `providers::is_known_provider_id`）与**当前真实
/// 存在**的自定义家（`custom-` 前缀且存储里有记录，判据见
/// `custom_providers::is_custom_provider_id`）。
///
/// 自定义家曾经在候选表里缺席、在写入校验里被拒：界面选不到、手写也会被
/// 400 挡回，而运行期的限制判定（`key_scope::allows_provider`）本来只把 provider id
/// 当字符串比（小写、忽略首尾空白）—— 校验比执行更严，用户看到的就是「自定义家
/// 不能拿来限定 Key」。
///
/// 为什么不放宽成「凡 `custom-` 前缀一律放行」：前缀对不上存储记录的是手改数据塞
/// 进来的死 id（没有协议与基址，转发必然失败），认它等于让一把 Key 的可用范围里
/// 躺着一个永远不可用的家 —— 那正是 `is_custom_provider_id` 要挡的东西。
fn is_allowed_provider_id(id: &str) -> bool {
    crate::server::core::providers::is_known_provider_id(id)
        || crate::server::core::custom_providers::is_custom_provider_id(id)
}

/// 从请求体里读一个白名单数组（`None` = 请求体里没这个键 = **不动**）。
///
/// 三态与 `model_rules` 的 `reasoning` 同一取舍（见那个 handler 的说明）：
/// 键缺失 → `None`（不改），空数组 → `Some(vec![])`（清成不限制），
/// 有内容 → `Some(list)`。一律按「空 = 清空」处理会让旧版前端（它不发这两个键）
/// 每次改名都顺手把限制抹掉 —— 那是静默的数据丢失。
///
/// 新增的未知渠道 ID 返回 400；PATCH 可以保留当前 Key 已保存的未知 ID。
/// 删除渠道不会改变授权范围，只有用户明确清除最后一项时才变为不限制。
fn parse_allowlist(
    object: &serde_json::Map<String, Value>,
    key: &str,
    check_provider: bool,
    retained_providers: &[String],
) -> Result<Option<Vec<String>>, Response> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let items = match value {
        // null 与空数组同义（都是「清成不限制」）—— JSON 客户端两种写法都常见
        Value::Null => return Ok(Some(Vec::new())),
        Value::Array(items) => items,
        _ => return Err(errors::management_error(400, format!("{key} 必须是字符串数组"))),
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(errors::management_error(400, format!("{key} 的元素必须是字符串")));
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if check_provider && !is_allowed_provider_id(text)
            && !retained_providers.iter().any(|known| known.eq_ignore_ascii_case(text)) {
            return Err(errors::management_error(400, format!("未知的渠道: {text}")));
        }
        if out.iter().any(|known: &String| known.eq_ignore_ascii_case(text)) {
            continue;
        }
        out.push(text.to_string());
    }
    Ok(Some(out))
}

fn body_object(body: &Bytes) -> Result<serde_json::Map<String, Value>, Response> {
    let payload = parse_body(body).map_err(|error| errors::management_error(400, error.message))?;
    payload
        .as_object()
        .cloned()
        .ok_or_else(|| errors::management_error(400, "请求体必须是 JSON 对象"))
}

/// 面板管理员已注册时，拒绝让「最后一把启用的 Key」消失（删除或停用）。
///
/// 管理员一注册，`/api/*` 就要求会话或 Key 认证（`require_api_key` 的
/// panel_auth 分支）。桌面壳现在有会话通道（`panel_session`：登录后带
/// `x-panel-token`），**但也有走到 Key 的场合** —— 登录页本身要在没有会话时
/// 打开、会话失效后的兜底、以及 `AGENT2API_ALLOW_NO_KEY` 之类不经过登录的部署。
/// 一把启用的 Key 都不剩时，这些路径全都会被闸门挡在外面，而建 Key 本身也要
/// 先过闸门（死锁）。所以保留这条保护：先建新的、再动旧的。注册前的免鉴权
/// 模式不受影响。
fn guard_last_active_key(entries: &[api_keys::ApiKeyEntry], target_id: &str, action: &str) -> Result<(), Response> {
    if !crate::server::access::panel_auth_enabled() {
        return Ok(());
    }
    let Some(target) = entries.iter().find(|entry| entry.id == target_id) else {
        return Ok(()); // 不存在的 id 交给原有的 404 路径
    };
    if !target.enabled {
        return Ok(()); // 动的是已停用的 Key，启用数不会变
    }
    if entries.iter().filter(|entry| entry.enabled).count() > 1 {
        return Ok(());
    }
    Err(errors::management_error(
        400,
        format!(
            "面板管理员已注册，至少要保留一把启用的网关 Key（桌面端管理界面靠它访问）：请先创建新的 Key，再{action}这一把"
        ),
    ))
}

/// GET /api/keys
pub async fn list_keys(State(state): State<ServerState>) -> Response {
    ok_json(list_json(&state))
}

/// POST /api/keys
pub async fn create_key(State(state): State<ServerState>, body: Bytes) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
    let key = object.get("key").and_then(Value::as_str);
    // 新建时两个键缺失 = 空列表（= 不限制）；这里与 PATCH 的三态不同：
    // 新建的记录本来就没有旧值可保护，「没给」与「给空」结果相同
    let allowed_providers = match parse_allowlist(&object, "allowedProviders", true, &[]) {
        Ok(value) => value.unwrap_or_default(),
        Err(response) => return response,
    };
    let allowed_models = match parse_allowlist(&object, "allowedModels", false, &[]) {
        Ok(value) => value.unwrap_or_default(),
        Err(response) => return response,
    };
    match api_keys::add(name, key, allowed_providers, allowed_models) {
        Ok(entry) => {
            logging::log("[Config]", &format!("✅ 新增 API Key「{}」，客户端需带 Authorization: Bearer <key>", entry.name));
            let mut payload = list_json(&state);
            if let Some(map) = payload.as_object_mut() {
                map.insert("created".to_string(), entry.public_json());
            }
            ok_json(payload)
        }
        Err(message) => errors::management_error(400, message),
    }
}

/// PATCH /api/keys/{id}
pub async fn update_key(State(state): State<ServerState>, Path(id): Path<String>, body: Bytes) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let name = object.get("name").and_then(Value::as_str);
    let enabled = object.get("enabled").and_then(Value::as_bool);
    let entries = api_keys::list();
    let Some(current) = entries.iter().find(|entry| entry.id == id) else {
        return errors::management_error(404, "Key 不存在");
    };
    // 三态：键缺失 → None（不动）。旧版前端只发 name/enabled，走的就是这条路
    //（所以升级后「改个名字」不会把限制清掉，见 `api_keys::update` 的说明）
    let allowed_providers = match parse_allowlist(&object, "allowedProviders", true, &current.allowed_providers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let allowed_models = match parse_allowlist(&object, "allowedModels", false, &[]) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(false) = enabled {
        // 停用受与删除同一道约束：它同样会让「启用的 Key」归零
        if let Err(response) = guard_last_active_key(&entries, &id, "停用") {
            return response;
        }
    }
    match api_keys::update(&id, name, enabled, allowed_providers, allowed_models) {
        Ok(entry) => {
            logging::log(
                "[Config]",
                &format!("API Key「{}」已更新（{}）", entry.name, if entry.enabled { "启用" } else { "停用" }),
            );
            ok_json(list_json(&state))
        }
        Err(message) => errors::management_error(404, message),
    }
}

/// DELETE /api/keys/{id}
pub async fn delete_key(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    if let Err(response) = guard_last_active_key(&api_keys::list(), &id, "删除") {
        return response;
    }
    match api_keys::remove(&id) {
        Ok(()) => {
            logging::log("[Config]", "API Key 已删除；模型调用仍需携带启用的 Key");
            ok_json(list_json(&state))
        }
        Err(message) => errors::management_error(404, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_key_may_keep_its_deleted_channel_but_new_keys_may_not_select_it() {
        let body = json!({"allowedProviders":[" CUSTOM-deleted ", "custom-deleted"]});
        let object = body.as_object().unwrap();
        let retained = vec!["custom-deleted".to_string()];
        assert_eq!(parse_allowlist(object, "allowedProviders", true, &retained).unwrap(), Some(vec!["CUSTOM-deleted".into()]));
        assert!(parse_allowlist(object, "allowedProviders", true, &[]).is_err());
        assert!(parse_allowlist(object, "allowedProviders", true, &["custom-other".into()]).is_err());
    }

    #[test]
    fn patch_preserves_omission_and_explicit_clear_semantics() {
        let retained = vec!["custom-deleted".to_string()];
        assert_eq!(parse_allowlist(json!({}).as_object().unwrap(), "allowedProviders", true, &retained).unwrap(), None);
        assert_eq!(parse_allowlist(json!({"allowedProviders":[]}).as_object().unwrap(), "allowedProviders", true, &retained).unwrap(), Some(vec![]));
    }
}
