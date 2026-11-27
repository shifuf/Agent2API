use std::{io, sync::Arc};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap},
    middleware::Next,
    response::Response,
};
use futures::{stream, StreamExt};
use serde_json::{json, Value};

use crate::server::{
    access,
    core::privacy::{self, stream::Events, Vault, REJECTED, UNAVAILABLE},
    errors::{management_error, GatewayError},
    http::ok_json,
    ServerState,
};

const MAX_BODY: usize = 8 * 1024 * 1024;

pub async fn get(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "隐私设置需要管理员会话");
    }
    match state.db().ok_or(UNAVAILABLE).and_then(privacy::load) {
        Ok(policy) => ok_json(policy.public()),
        Err(error) => management_error(503, error),
    }
}

pub async fn put(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "隐私设置需要管理员会话");
    }
    let Some(db) = state.db() else {
        return management_error(503, UNAVAILABLE);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return management_error(400, "隐私配置不是有效 JSON");
    };
    match privacy::write(db, &value) {
        Ok(result) => ok_json(result),
        Err((code, error)) => management_error(code, error),
    }
}

pub async fn preview(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "隐私设置需要管理员会话");
    }
    let Ok(Some(text)) = serde_json::from_slice::<Value>(&body)
        .map(|value| value["text"].as_str().map(str::to_owned))
    else {
        return management_error(400, "请输入预览文本");
    };
    let result = state
        .db()
        .ok_or(UNAVAILABLE)
        .and_then(privacy::load)
        .and_then(|policy| Vault::new(&policy.rules))
        .and_then(|vault| vault.mask(&text));
    match result {
        Ok(masked) => ok_json(json!({"text":masked})),
        Err(error) => management_error(503, error),
    }
}

fn denied(code: i32, text: &'static str) -> Response {
    GatewayError::with_status(code, text).payload_response()
}

pub async fn protect(State(state): State<ServerState>, request: Request, next: Next) -> Response {
    let policy = match state.db().ok_or(UNAVAILABLE).and_then(privacy::load) {
        Ok(policy) => policy,
        Err(_) => return denied(503, UNAVAILABLE),
    };
    if !policy.enabled {
        return next.run(request).await;
    }
    let vault = match Vault::new(&policy.rules) {
        Ok(vault) => Arc::new(vault),
        Err(_) => return denied(503, UNAVAILABLE),
    };
    let (mut head, body) = request.into_parts();
    if head.headers.contains_key(header::CONTENT_ENCODING) || head.uri.query().is_some() {
        return denied(400, REJECTED);
    }
    for name in ["authorization", "proxy-authorization", "x-api-key", "x-panel-token", "x-panel-refresh", "cookie"] { head.headers.remove(name); }
    for (name, value) in &head.headers {
        if name == header::CONTENT_LENGTH {
            continue;
        }
        if vault.matches(name.as_str())
            || value.to_str().ok().is_none_or(|text| vault.matches(text))
        {
            return denied(400, REJECTED);
        }
    }
    let Ok(bytes) = to_bytes(body, MAX_BODY).await else {
        return denied(413, REJECTED);
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return denied(400, REJECTED);
    };
    if vault.mask_json(&mut value).is_err() {
        return denied(400, REJECTED);
    }
    let Ok(safe) = serde_json::to_vec(&value) else {
        return denied(400, REJECTED);
    };
    if safe.len() > MAX_BODY {
        return denied(413, REJECTED);
    }
    head.headers.remove(header::CONTENT_LENGTH);
    let request = Request::from_parts(head, Body::from(safe));
    let response = privacy::ACTIVE
        .scope(vault.clone(), next.run(request))
        .await;
    let (mut head, body) = response.into_parts();
    head.headers.remove(header::CONTENT_LENGTH);
    let mime = head
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if mime.starts_with("text/event-stream") {
        let scope = vault.log_scope();
        let state = (body.into_data_stream(), Events::new(vault), false, scope);
        let restored = stream::try_unfold(
            state,
            |(mut input, mut events, mut done, scope)| async move {
                while !done {
                    let chunk = privacy::LOG_SCOPE
                        .scope(scope.clone(), input.next())
                        .await
                        .transpose()
                        .map_err(|_| io::Error::other("privacy stream interrupted"))?;
                    done = chunk.is_none();
                    let result = events
                        .push(chunk.as_deref().unwrap_or_default(), done)
                        .map_err(|_| io::Error::other("privacy stream unavailable"))?;
                    if !result.is_empty() {
                        return Ok::<_, io::Error>(Some((
                            Bytes::from(result),
                            (input, events, done, scope),
                        )));
                    }
                }
                Ok(None)
            },
        );
        return Response::from_parts(head, Body::from_stream(restored));
    }
    if !mime.starts_with("application/json") {
        return denied(502, "无法安全读取上游回复");
    }
    let Ok(bytes) = to_bytes(body, MAX_BODY * 2).await else {
        return denied(502, "无法安全读取上游回复");
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return denied(502, "无法安全读取上游回复");
    };
    if !head.status.is_success() {
        if value.pointer("/error/code").and_then(Value::as_str) == Some("privacy_opaque_provider") { return denied(400, "隐私模式不支持不能检查最终报文的提供商；请求未转发"); }
        return denied(
            i32::from(head.status.as_u16()),
            "请求失败；为保护隐私已省略详细错误",
        );
    }
    if value.get("error").is_some_and(|error| !error.is_null()) { return denied(502, "请求失败；为保护隐私已省略详细错误"); }
    if vault.restore_json(&mut value, "").is_err() {
        return denied(502, "无法安全读取上游回复");
    }
    match serde_json::to_vec(&value) {
        Ok(bytes) => Response::from_parts(head, Body::from(bytes)),
        Err(_) => denied(502, "无法安全读取上游回复"),
    }
}
