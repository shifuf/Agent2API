//! Explicit, single-account credential inspection. Never included in account snapshots.
use axum::http::{header::CACHE_CONTROL, HeaderMap, HeaderValue};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::{access, errors::management_error, http::ok_json, ServerState};

pub fn details(state: &ServerState, headers: &HeaderMap, id: &str) -> Response {
    // A gateway Key, even one allowing all models, is not an administrator credential.
    // Keep the legacy environment Key and authenticated desktop/panel sessions working.
    let administrator = access::session_valid(headers)
        || super::model_access::authenticate(headers, "").is_ok_and(|access| access.source.api_key.source == "env");
    let mut response = if !administrator {
        management_error(403, "查看密钥详情需要管理员登录")
    } else {
        let record = state.store().with_lock(|guard| state.store().record_by_id(guard, id));
        match record {
            None => management_error(404, "账号不存在或凭证不可读取"),
            Some(record) => {
                // Only saved authentication fields; never return arbitrary account settings
                // or proxy credentials. pluginSecret is the provider's opaque credential.
                let mut fields: Vec<Value> = [
                    "apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token",
                    "jwt", "modelAppKey", "modelAppSecret", "accessKeyId", "secretAccessKey", "securityToken",
                    "access_key_id", "secret_access_key", "security_token", "secretKey", "password",
                    "balanceToken", "workbuddyWebSession", "oauth_context", "pluginSecret",
                ].iter().filter_map(|key| {
                    let value = record.get(key)?;
                    let text = match value {
                        Value::String(text) if !text.trim().is_empty() => text.clone(),
                        Value::Object(fields) if !fields.is_empty() => serde_json::to_string_pretty(value).ok()?,
                        Value::Array(items) if !items.is_empty() => serde_json::to_string_pretty(value).ok()?,
                        _ => return None,
                    };
                    Some(json!({ "key": key, "value": text }))
                }).collect();
                if let Some(query) = record.get("balanceQuery") {
                    for key in ["accessToken", "password", "token"] {
                        if let Some(value) = query.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
                            fields.push(json!({ "key": format!("balanceQuery.{key}"), "value": value }));
                        }
                    }
                }
                ok_json(json!({ "id": record.id(), "provider": record.provider(), "noAuth": record.no_auth(),
                    "desktop": record.is_desktop(), "fields": fields }))
            }
        }
    };
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
