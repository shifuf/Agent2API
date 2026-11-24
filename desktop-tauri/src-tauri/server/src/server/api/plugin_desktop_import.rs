use std::collections::HashMap;

use axum::{body::Bytes, extract::{Query, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde_json::json;

use crate::server::{
    access::local_session,
    core::plugin_host::wasm::native::chatglm::{self, ImportError},
    http::{ok_json, parse_body},
    ServerState,
};

fn failure(error: ImportError) -> Response {
    let status = StatusCode::from_u16(error.status() as u16).unwrap_or(StatusCode::BAD_REQUEST);
    (status, Json(json!({ "success": false, "error": { "type": error.code(), "message": error.message() } }))).into_response()
}

pub async fn status(headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    let Some(manager) = local_session::capture_headers(&headers) else { return failure(ImportError::forbidden()); };
    if query.len() != 1 || !query.contains_key("intent") { return failure(ImportError::invalid_request()); }
    match chatglm::status(manager, &query["intent"]) {
        Ok(value) => ok_json(value),
        Err(error) => failure(error),
    }
}

pub async fn action(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(manager) = local_session::capture_headers(&headers) else { return failure(ImportError::forbidden()); };
    if body.len() > 4096 { return failure(ImportError::invalid_request()); }
    let Ok(value) = parse_body(&body) else { return failure(ImportError::invalid_request()); };
    let Some(fields) = value.as_object() else { return failure(ImportError::invalid_request()); };
    let action = value["action"].as_str().unwrap_or("");
    let intent = value["intent"].as_str().unwrap_or("");
    let result = match action {
        "prepare" if fields.len() == 1 => chatglm::prepare(manager),
        "cancel" if fields.len() == 2 && fields.contains_key("intent") => chatglm::cancel(manager, intent),
        "confirm" if fields.len() == 3 && fields.contains_key("intent") && value["confirmed"] == true => {
            chatglm::confirm(manager, intent, state.store().clone())
        }
        _ => return failure(ImportError::invalid_request()),
    };
    match result {
        Ok(value) => ok_json(value),
        Err(error) => failure(error),
    }
}
