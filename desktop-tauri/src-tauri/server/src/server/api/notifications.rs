use axum::body::Bytes;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::Response;
use serde_json::Value;

use crate::server::{access, core::notifications, errors::management_error, http::{ok_json, parse_body}};

fn admin(headers: &HeaderMap) -> Result<(), Response> {
    if access::session_valid(headers) { Ok(()) } else { Err(management_error(403, "系统通知需要管理员会话")) }
}

fn reply(value: Result<Value, notifications::Error>) -> Response {
    let mut response = match value { Ok(value) => ok_json(value), Err((status, message)) => management_error(status, message) };
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn get(headers: HeaderMap) -> Response {
    if let Err(response) = admin(&headers) { return response; }
    reply(notifications::get())
}

pub async fn put(headers: HeaderMap, body: Bytes) -> Response {
    if let Err(response) = admin(&headers) { return response; }
    match parse_body(&body) {
        Ok(value) => reply(notifications::save(&value)),
        Err(_) => management_error(400, "通知设置不是有效的 JSON"),
    }
}

pub async fn test(headers: HeaderMap, body: Bytes) -> Response {
    if let Err(response) = admin(&headers) { return response; }
    match parse_body(&body) {
        Ok(value) => reply(notifications::test(&value).await),
        Err(_) => management_error(400, "通知参数不是有效的 JSON"),
    }
}
