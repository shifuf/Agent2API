//! 面板登录校验设置；服务端密钥只接受写入，不随响应回传。

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;

use crate::server::{access, config, core::panel_turnstile};
use crate::server::config::captcha::CaptchaSettings;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

pub async fn get_captcha(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "登录验证设置需要管理员会话"); }
    if let Err((status, message)) = config::captcha::migrate_legacy(state.db()) {
        return errors::management_error(status, message);
    }
    let config = config::current();
    ok_json(CaptchaSettings::from_config(&config).management_json(&config, state.local_panel))
}

/// PUT /api/captcha —— body `{captchaDesktop?: bool, captchaWeb?: bool}`（或旧键
/// `captchaEnabled` 同时写两端）。
pub async fn put_captcha(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "登录验证设置需要管理员会话"); }
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    if let Err((status, message)) = config::captcha::save(object, state.db()) {
        return errors::management_error(status, message);
    }
    let config = config::current();
    let settings = CaptchaSettings::from_config(&config);
    let (desktop, web) = config.captcha_settings();
    logging::log(
        "[Security]",
        &format!(
            "机器人校验：{}，桌面端{}、网页端{}",
            settings.provider,
            if desktop { "开启" } else { "关闭" },
            if web { "开启" } else { "关闭" },
        ),
    );
    ok_json(settings.management_json(&config, state.local_panel))
}

pub async fn get_turnstile(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "登录验证设置需要管理员会话"); }
    match panel_turnstile::management(state.db()) { Ok(settings) => ok_json(settings), Err(error) => errors::management_error(503,error) }
}

pub async fn widget() -> Response {
    use axum::http::{header, HeaderValue};
    use axum::response::{Html, IntoResponse};
    let mut response = Html(include_str!("turnstile-widget.html")).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"turnstile-widget.html\""));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src data: https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

pub async fn put_turnstile(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) { return errors::management_error(403, "登录验证设置需要管理员会话"); }
    let Some(db) = state.db() else { return errors::management_error(503,panel_turnstile::UNAVAILABLE); };
    let body = match parse_body(&body) { Ok(body) => body, Err(_) => return errors::management_error(400,"登录验证设置无效") };
    match panel_turnstile::save(db,body) { Ok(result) => ok_json(result), Err((code,error)) => errors::management_error(code,error) }
}
