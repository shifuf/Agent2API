//! 模型计价设置 API（货币、自定义模型单价、同款模型参考、提供商倍率与分时窗口、汇率刷新）。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::model_pricing::{
    self, fx, ModelPrice, ModelPricingSettings, ProviderPricingRule, RateWindow,
};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

pub async fn get_model_pricing() -> Response {
    ok_json(model_pricing::settings_view())
}

fn validate_price_input(value: &Value, tier: bool) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("模型单价必须是对象")?;
    for key in object.keys() {
        let known = matches!(key.as_str(), "input" | "output" | "cacheRead" | "cache_read"
            | "cacheWrite" | "cache_write" | "cacheWrite1h" | "cache_write_1h")
            || if tier { key == "above" } else { matches!(key.as_str(), "tiers" | "peak" | "currency") };
        if !known { return Err("模型单价包含未知字段"); }
    }
    if let Some(currency) = object.get("currency") {
        if !currency.as_str().is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "" | "usd" | "cny")) {
            return Err("单价币种必须是 usd 或 cny");
        }
    }
    if let Some(tiers) = object.get("tiers") {
        for tier in tiers.as_array().ok_or("阶梯计价必须是数组")? { validate_price_input(tier, true)?; }
    }
    Ok(())
}

pub async fn put_model_pricing(State(state): State<ServerState>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    if !crate::server::access::session_valid(&headers) {
        return errors::management_error(403, "此设置需要管理员会话");
    }
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(err) => return errors::management_error(400, err.message),
    };
    let Some(obj) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    if let Some(prices) = obj.get("modelPrices") {
        let Some(prices) = prices.as_object() else { return errors::management_error(400, "自定义单价表必须是对象"); };
        for price in prices.values() {
            if let Err(message) = validate_price_input(price, false) { return errors::management_error(400, message); }
        }
    }
    if let Some(price) = obj.get("price").filter(|price| !price.is_null()) {
        if let Err(message) = validate_price_input(price, false) { return errors::management_error(400, message); }
    }

    let mut current = model_pricing::settings();
    let mut should_reprice = false;
    let action = obj.get("action").and_then(Value::as_str).unwrap_or("");

    match action {
        "setCurrency" => {
            let Some(currency) = obj.get("currency").and_then(Value::as_str) else {
                return errors::management_error(400, "缺少 currency 参数");
            };
            current.currency = if currency.trim().eq_ignore_ascii_case("cny") {
                "cny".to_string()
            } else {
                "usd".to_string()
            };
        }
        "setModelPrice" => {
            let key = obj.get("key").and_then(Value::as_str).unwrap_or("").trim();
            if key.is_empty() || !key.contains('/') {
                return errors::management_error(400, "缺少有效的计价目标键（格式应为 提供商/模型）");
            }
            if obj.contains_key("price") {
                match obj.get("price") {
                    Some(Value::Null) => {
                        current.model_prices.remove(key);
                    }
                    Some(price_val) => {
                        let parsed: ModelPrice = match serde_json::from_value(price_val.clone()) {
                            Ok(v) => v,
                            Err(err) => {
                                return errors::management_error(400, format!("模型单价格式无效: {err}"))
                            }
                        };
                        current.model_prices.insert(key.to_string(), parsed);
                    }
                    None => {}
                }
            }
            if obj.contains_key("sameAs") {
                let same_as = obj
                    .get("sameAs")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if same_as.is_empty() {
                    current.model_same_as.remove(key);
                } else {
                    current.model_same_as.insert(key.to_string(), same_as.to_string());
                }
            }
            should_reprice = true;
        }
        "setProviderPricing" => {
            let provider = obj.get("provider").and_then(Value::as_str).unwrap_or("").trim();
            if provider.is_empty() {
                return errors::management_error(400, "缺少 provider 参数");
            }
            let mut rule = current
                .provider_pricing
                .get(provider)
                .cloned()
                .unwrap_or_default();
            if obj.contains_key("priceRate") {
                rule.price_rate = match obj.get("priceRate") {
                    Some(Value::Null) | None => None,
                    Some(val) => match val.as_f64() {
                        Some(num) => Some(num),
                        None => return errors::management_error(400, "priceRate 必须是数字或 null"),
                    },
                };
            }
            if let Some(windows_val) = obj.get("rateWindows") {
                rule.rate_windows = match serde_json::from_value::<Vec<RateWindow>>(windows_val.clone()) {
                    Ok(ws) => ws,
                    Err(err) => {
                        return errors::management_error(400, format!("分时倍率配置无效: {err}"))
                    }
                };
            }
            if rule.price_rate.is_none() && rule.rate_windows.is_empty() {
                current.provider_pricing.remove(provider);
            } else {
                current.provider_pricing.insert(provider.to_string(), rule);
            }
            should_reprice = true;
        }
        _ => {
            if let Some(currency) = obj.get("currency").and_then(Value::as_str) {
                current.currency = if currency.trim().eq_ignore_ascii_case("cny") {
                    "cny".to_string()
                } else {
                    "usd".to_string()
                };
            }
            if let Some(prices_val) = obj.get("modelPrices") {
                current.model_prices = match serde_json::from_value(prices_val.clone()) {
                    Ok(v) => v,
                    Err(err) => {
                        return errors::management_error(400, format!("自定义单价表无效: {err}"))
                    }
                };
                should_reprice = true;
            }
            if let Some(same_val) = obj.get("modelSameAs") {
                current.model_same_as = match serde_json::from_value(same_val.clone()) {
                    Ok(v) => v,
                    Err(err) => {
                        return errors::management_error(400, format!("同款模型参考表无效: {err}"))
                    }
                };
                should_reprice = true;
            }
            if let Some(prov_val) = obj.get("providerPricing") {
                current.provider_pricing = match serde_json::from_value::<std::collections::BTreeMap<String, ProviderPricingRule>>(prov_val.clone()) {
                    Ok(v) => v,
                    Err(err) => {
                        return errors::management_error(400, format!("提供商计价规则无效: {err}"))
                    }
                };
                should_reprice = true;
            }
        }
    }

    let saved = match model_pricing::save_settings(ModelPricingSettings {
        currency: current.currency,
        model_prices: current.model_prices,
        model_same_as: current.model_same_as,
        provider_pricing: current.provider_pricing,
    }) {
        Ok(view) => view,
        Err(err) => return errors::management_error(err.status_code, err.message),
    };

    if should_reprice {
        let stats = state.request_stats();
        let _ = tokio::task::spawn_blocking(move || {
            stats.reprice_recent_days();
        })
        .await;
    }

    ok_json(saved)
}

pub async fn post_refresh_fx(headers: axum::http::HeaderMap) -> Response {
    if !crate::server::access::session_valid(&headers) {
        return errors::management_error(403, "刷新汇率需要管理员会话");
    }
    match fx::refresh_live().await {
        Ok(snap) => ok_json(json!({
            "fx": snap.to_json(crate::server::logging::now_ms()),
        })),
        Err(err) => errors::management_error(502, err),
    }
}

pub async fn reprice(State(state): State<ServerState>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    if !crate::server::access::session_valid(&headers) {
        return errors::management_error(403, "重算需要管理员会话");
    }
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "无效的重算范围");
    };
    use crate::server::request_stats::PricingSelection;
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
