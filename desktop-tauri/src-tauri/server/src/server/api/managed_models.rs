use crate::server::{
    core::managed_models::{self, ManagedModel},
    errors::management_error,
    http::ok_json,
    ServerState,
};
use axum::{body::Bytes, extract::State, response::Response};
use serde::Deserialize;

pub async fn get_catalog(State(state): State<ServerState>) -> Response {
    match managed_models::management(state.store()) {
        Ok(data) => ok_json(data),
        Err(error) => management_error(400, error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveModel {
    #[serde(default)]
    previous_id: String,
    model: Option<ManagedModel>,
    revision: String,
}

pub async fn save_model(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload: SaveModel = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return management_error(400, "模型配置格式无效"),
    };
    if payload.model.is_none() && payload.previous_id.is_empty() {
        return management_error(400, "请选择要删除的模型");
    }
    match managed_models::save(&payload.previous_id, payload.model, &payload.revision) {
        Ok(()) => get_catalog(State(state)).await,
        Err(error) => management_error(400, error),
    }
}
