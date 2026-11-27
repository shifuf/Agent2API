use axum::{body::Bytes, http::HeaderMap, response::Response};
use serde_json::Value;
use crate::server::{access, config, core::model_pricing::{self, ModelPricingSettings, KEY_MODEL_PRICING}, errors, http::ok_json, logging};

pub async fn get() -> Response {
    let mut value = serde_json::to_value(model_pricing::settings()).unwrap_or_default();
    value["fx"] = model_pricing::fx::current_rate().to_json(logging::now_ms());
    ok_json(value)
}

pub async fn put(headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "此设置需要管理员会话"); }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else { return errors::management_error(400, "无效的 JSON"); };
    let Some(object) = payload.as_object() else { return errors::management_error(400, "计价设置必须为对象"); };
    if object.is_empty() || object.keys().any(|key| !matches!(key.as_str(), "currency" | "modelPrices" | "modelSameAs" | "providerPricing")) || object.get("currency").is_some_and(|value| !matches!(value.as_str(), Some("usd" | "cny"))) {
        return errors::management_error(400, "不支持的计价设置");
    }
    let result = config::try_update_raw_field(KEY_MODEL_PRICING, |slot| {
        let mut merged = slot.as_object().cloned().unwrap_or_default();
        merged.extend(object.clone());
        let next = serde_json::from_value::<ModelPricingSettings>(Value::Object(merged)).map_err(|_| (400, "计价规则格式错误".to_owned()))?;
        let normalized = next.normalized().map_err(|message| (400, message))?;
        *slot = serde_json::to_value(normalized).map_err(|_| (500, "无法保存计价规则".to_owned()))?;
        Ok(())
    }, || (500, "计价规则写入失败".to_owned()));
    match result { Ok(()) => get().await, Err((status, message)) => errors::management_error(status, message) }
}

pub async fn refresh(headers: HeaderMap) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "刷新汇率需要管理员会话"); }
    match model_pricing::fx::refresh_live().await {
        Ok(snapshot) => ok_json(snapshot.to_json(logging::now_ms())),
        Err(_) => errors::management_error(502, "无法刷新汇率，已保留本地读数"),
    }
}

pub async fn reprice(axum::extract::State(state): axum::extract::State<crate::server::ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "重算需要管理员会话"); }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else { return errors::management_error(400, "无效的请求编号"); };
    use crate::server::request_stats::PricingSelection;
    let Some(object) = payload.as_object() else { return errors::management_error(400, "无效的重算范围"); };
    let selection = match (object.len(), payload["id"].as_str(), payload["fromMs"].as_i64(), payload["toMs"].as_i64()) {
        (1, Some(id), None, None) if !id.trim().is_empty() && id.len() <= 160 => PricingSelection::Id(id.to_owned()),
        (2, None, Some(from_ms), Some(to_ms)) if from_ms >= 0 && to_ms > from_ms && to_ms - from_ms <= 32 * 86_400_000 => PricingSelection::Period { from_ms, to_ms },
        _ => return errors::management_error(400, "请选择请求编号或不超过 32 天的时间段"),
    };
    let stats = state.request_stats();
    match tokio::task::spawn_blocking(move || stats.reprice(selection)).await {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err((status, message))) => errors::management_error(status, message),
        Err(_) => errors::management_error(500, "重算未完成"),
    }
}
