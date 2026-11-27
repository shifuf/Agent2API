use axum::{body::Bytes, extract::State, http::HeaderMap, response::Response};
use crate::server::{access, core::{blocking, upstream::vision_compat}, errors::{management_error, GatewayError}, http::ok_json, ServerState};

async fn manage(state: ServerState, headers: HeaderMap, body: Option<Bytes>) -> Response {
    if !access::session_valid(&headers) { return management_error(403, "需要管理员登录"); }
    let result = blocking::run(move || match body {
        None => Ok(vision_compat::view(state.store())),
        Some(bytes) => vision_compat::save(state.store(), serde_json::from_slice(&bytes).map_err(|_| GatewayError::bad_request("视觉替代设置无效"))?),
    }).await.and_then(|value| value);
    match result { Ok(value) => ok_json(value), Err(error) => management_error(error.status_code, error.message) }
}
pub async fn get(State(state): State<ServerState>, headers: HeaderMap) -> Response { manage(state, headers, None).await }
pub async fn put(State(state): State<ServerState>, headers: HeaderMap, bytes: Bytes) -> Response { manage(state, headers, Some(bytes)).await }
