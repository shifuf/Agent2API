use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::server::{
    access,
    core::branding,
    errors::management_error,
    http::{ok_json, parse_body},
    ServerState,
};

pub async fn get(State(state): State<ServerState>) -> Response {
    let Some(db) = state.db() else {
        return management_error(503, "数据库不可用");
    };
    match branding::public(db) {
        Ok(value) => {
            let mut response = ok_json(value);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => management_error(500, error),
    }
}

pub async fn put(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "品牌设置需要管理员会话");
    }
    let Some(db) = state.db().cloned() else {
        return management_error(503, "数据库不可用");
    };
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return management_error(400, error.message),
    };
    static DECODERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let Ok(permit) = DECODERS.try_acquire() else {
        return management_error(429, "品牌设置繁忙");
    };
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        branding::save(&db, payload)
    })
    .await
    {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err((code, message))) => management_error(code, message),
        Err(_) => management_error(500, "保存品牌设置失败"),
    }
}

pub async fn logo(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let Some(db) = state.db() else {
        return management_error(503, "数据库不可用");
    };
    let (bytes, etag) = match branding::logo(db) {
        Ok(Some(asset)) => asset,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return management_error(500, error),
    };
    let matched = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|values| {
            values
                .split(',')
                .any(|tag| tag.trim().trim_start_matches("W/") == etag)
        });
    let mut response = if matched {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Body::from(bytes).into_response()
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=0, must-revalidate"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(tag) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, tag);
    }
    response
}
