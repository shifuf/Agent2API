use axum::{body::Bytes, http::HeaderMap, response::Response};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::server::config::{self, prompt_rules};
use crate::server::core::prompt::rules::Rule;
use crate::server::errors::{self, GatewayError};
use crate::server::http::ok_json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save { rules: Vec<Rule>, revision: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview { rules: Vec<Rule>, sample: Sample }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample { client: String, model: String, provider: String }

async fn admin(headers: HeaderMap, work: impl FnOnce() -> Result<Value, GatewayError> + Send + 'static) -> Response {
    if !crate::server::access::session_valid(&headers) { return errors::management_error(403, "需要管理员登录"); }
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err(error)) => errors::management_error(error.status_code, error.message),
        Err(_) => errors::management_error(500, "条件提示词处理失败"),
    }
}

fn view() -> Value {
    let snapshot = config::current().prompt_rules;
    json!({"rules": snapshot.rules.iter().map(|entry| &entry.rule).collect::<Vec<_>>(), "revision": snapshot.revision, "error": snapshot.error})
}

pub async fn get(headers: HeaderMap) -> Response { admin(headers, || Ok(view())).await }

pub async fn put(headers: HeaderMap, body: Bytes) -> Response {
    admin(headers, move || {
        let save: Save = serde_json::from_slice(&body).map_err(|_| GatewayError::bad_request("条件提示词格式无效"))?;
        prompt_rules::save(save.rules, &save.revision)?;
        Ok(view())
    }).await
}

pub async fn preview(headers: HeaderMap, body: Bytes) -> Response {
    admin(headers, move || {
        let Preview { rules, sample } = serde_json::from_slice(&body).map_err(|_| GatewayError::bad_request("预览条件格式无效"))?;
        if [&sample.model, &sample.client, &sample.provider].iter().any(|value| value.len() > 4096 || value.chars().any(char::is_control)) {
            return Err(GatewayError::bad_request("预览条件无效"));
        }
        let compiled = prompt_rules::compile(rules).map_err(GatewayError::bad_request)?;
        let selected = compiled.iter().find(|entry| entry.matches(&sample.provider, &sample.client, &sample.model));
        Ok(json!({"ruleId": selected.map(|entry| &entry.rule.id)}))
    }).await
}
