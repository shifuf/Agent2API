use std::collections::HashMap;

use axum::{body::Bytes, extract::{Query, State}, response::Response};
use serde_json::json;

use crate::server::{
    core::login,
    errors::management_error,
    http::{ok_json, parse_body},
    ServerState,
};

pub async fn get(State(state): State<ServerState>, headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>) -> Response {
    let flow = query.get("state").map(String::as_str).unwrap_or("");
    let Some(task) = state.login().tasks().get(flow) else {
        return management_error(404, "登录任务不存在或已过期");
    };
    let snapshot = task.snapshot();
    if snapshot.managed {
        if let Err(error) = login::managed::check_source(&task, &headers) {
            return management_error(error.status_code, error.message);
        }
    }
    if snapshot.done || snapshot.canceled {
        return ok_json(json!({ "provider": snapshot.provider, "state": flow, "interaction": null }));
    }
    match login::plugin_login_interaction(&task).await {
        Ok(value) => ok_json(value),
        Err(error) => management_error(error.status_code, error.message),
    }
}

pub async fn submit(State(state): State<ServerState>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    if body.len() > 256 * 1024 {
        return management_error(413, "登录交互输入过大");
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return management_error(400, error.message),
    };
    let flow = value["state"].as_str().unwrap_or("");
    let Some(task) = state.login().tasks().get(flow) else {
        return management_error(404, "登录任务不存在或已过期");
    };
    if task.snapshot().managed {
        if let Err(error) = login::managed::check_source(&task, &headers) {
            return management_error(error.status_code, error.message);
        }
    }
    match login::plugin_login_submit(&task, value).await {
        Ok(value) => ok_json(value),
        Err(error) => management_error(error.status_code, error.message),
    }
}
