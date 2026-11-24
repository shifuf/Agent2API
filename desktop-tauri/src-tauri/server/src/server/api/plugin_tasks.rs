use axum::{body::Bytes, extract::State, response::Response};
use serde_json::{json, Value};

use crate::server::{
    core::plugin_host::wasm::tasks,
    errors::management_error,
    http::{ok_json, parse_body},
    ServerState,
};

pub async fn list() -> Response {
    ok_json(json!({ "tasks": tasks::snapshot() }))
}

fn input(body: &Bytes, keys: &[&str]) -> Result<Value, Response> {
    if body.len() > 64 * 1024 {
        return Err(management_error(413, "插件任务输入过大"));
    }
    let value = parse_body(body).map_err(|error| management_error(400, error.message))?;
    if value.as_object().is_none_or(|object| object.keys().any(|key| !keys.contains(&key.as_str())))
        || value["provider"].as_str().is_none_or(|id| id.is_empty() || id.len() > 128)
        || value["task"].as_str().is_none_or(|id| id.is_empty() || id.len() > 64) {
        return Err(management_error(400, "插件任务请求格式无效"));
    }
    Ok(value)
}

pub async fn configure(body: Bytes) -> Response {
    let value = match input(&body, &["provider", "task", "settings"]) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match tasks::configure(
        value["provider"].as_str().unwrap_or(""),
        value["task"].as_str().unwrap_or(""),
        &value["settings"],
    ) {
        Ok(saved) => ok_json(json!({ "saved": saved, "tasks": tasks::snapshot() })),
        Err(error) => management_error(400, error),
    }
}

pub async fn run(State(state): State<ServerState>, body: Bytes) -> Response {
    let value = match input(&body, &["provider", "task", "background"]) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if value.get("background").is_some_and(|value| !value.is_boolean()) {
        return management_error(400, "后台任务选项无效");
    }
    let provider = value["provider"].as_str().unwrap_or("");
    let id = value["task"].as_str().unwrap_or("");
    let result = if value["background"] == true {
        tasks::launch(state.store().clone(), provider, id)
    } else {
        tasks::run(state.store(), provider, id, true).await
    };
    match result {
        Ok(value) => ok_json(value),
        Err(error) => management_error(400, error),
    }
}
