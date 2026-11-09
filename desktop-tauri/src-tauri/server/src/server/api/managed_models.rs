//! Read-only compatibility for old clients. Public models are routing groups.
use crate::server::{core::managed_models, errors::management_error, http::ok_json, ServerState};
use axum::{body::Bytes, extract::State, response::Response};
use serde_json::json;

pub async fn get_catalog(State(state): State<ServerState>) -> Response {
    ok_json(json!({"models":[],"choices":managed_models::choices(state.store()),
        "retired":true,"replacement":"/api/routing/groups"}))
}

pub async fn save_model(State(_state): State<ServerState>, _body: Bytes) -> Response {
    management_error(410, "模型管理已合并到路由组，请在路由页面创建或修改路由组")
}
