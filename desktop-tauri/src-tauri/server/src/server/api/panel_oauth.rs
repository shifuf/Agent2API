use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr};

use crate::server::{
    access,
    core::panel_oauth::{self as oauth, flow, Error, Provider},
    errors::management_error,
    http::{ok_json, parse_body},
    ServerState,
};

fn error((status, message): Error) -> Response {
    management_error(status, message)
}
fn sensitive(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
fn registered_origin(headers: &HeaderMap, expected: &str, initiate: bool) -> bool {
    let actual = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok());
    let Some(host) = actual else { return false };
    let Ok(candidate) = oauth::canonical_origin(&format!("https://{host}")) else {
        return false;
    };
    candidate == expected
        && (!initiate
            || headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                == Some(expected))
}

pub async fn get(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "OAuth 设置需要管理员会话");
    }
    match oauth::load(state.db()) {
        Ok(settings) => sensitive(ok_json(settings.admin())),
        Err(err) => error(err),
    }
}

pub async fn put(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    if !access::session_valid(&headers) {
        return management_error(403, "OAuth 设置需要管理员会话");
    }
    let Some(db) = state.db() else {
        return management_error(503, oauth::UNAVAILABLE);
    };
    let Ok(body) = parse_body(&body) else {
        return management_error(400, "OAuth 设置无效");
    };
    match oauth::save(db, body) {
        Ok(settings) => sensitive(ok_json(settings.admin())),
        Err(err) => error(err),
    }
}

pub async fn start(
    State(state): State<ServerState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        provider: Provider,
        mode: String,
        captcha: Option<String>,
    }
    let Ok(input) = serde_json::from_slice::<Request>(&body) else {
        return management_error(400, "OAuth 请求无效");
    };
    let session = match input.mode.as_str() {
        "bind" => match access::oauth_cookie_session(&headers) {
            Some(session) => Some(session),
            None => return management_error(403, "绑定身份需要当前网页管理员会话"),
        },
        "login" => None,
        _ => return management_error(400, "OAuth 请求无效"),
    };
    let Some(admin) = access::oauth_admin_stamp() else {
        return management_error(403, oauth::DENIED);
    };
    let settings = match oauth::load(state.db()) {
        Ok(value) => value,
        Err(err) => return error(err),
    };
    if !registered_origin(&headers, &settings.origin, true) {
        return management_error(403, "请从预设 HTTPS 面板站点发起 OAuth");
    }
    if session.is_none() {
        if access::login_locked(addr.ip()) {
            return management_error(429, "登录尝试过多");
        }
        if let Err(response) =
            super::panel::check_captcha(&json!({"captcha":input.captcha}), &state).await
        {
            return response;
        }
    }
    match flow::start(&settings, input.provider, admin, session) {
        Ok(started) => {
            let Ok(cookie) = HeaderValue::from_str(&started.cookie) else {
                return management_error(503, oauth::UNAVAILABLE);
            };
            let mut response = sensitive(ok_json(json!({"url":started.url})));
            response.headers_mut().insert(header::SET_COOKIE, cookie);
            response
        }
        Err(err) => error(err),
    }
}

pub async fn callback(
    State(state): State<ServerState>,
    Path(provider): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let result = complete(&state, &provider, &query, &headers, addr).await;
    sensitive(result.unwrap_or_else(error))
}

async fn complete(
    state: &ServerState,
    provider: &str,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    addr: SocketAddr,
) -> Result<Response, Error> {
    let denied = (403, oauth::DENIED);
    let provider = Provider::parse(provider)?;
    let settings = oauth::load(state.db())?;
    if !registered_origin(headers, &settings.origin, false) {
        return Err(denied);
    }
    let state_key = query.get("state").ok_or(denied)?;
    let cookies = access::cookie_values(headers, flow::COOKIE);
    if cookies.len() != 1 {
        return Err(denied);
    }
    let session = access::oauth_cookie_session(headers);
    let flow = flow::take(
        provider,
        state_key,
        &cookies[0],
        &settings.origin,
        session.as_deref(),
    )?;
    if query.contains_key("error") {
        return Err((400, "OAuth 授权已取消，请返回登录页重试"));
    }
    if flow.revision != settings.revision || settings.client(provider).enabled == false {
        return Err(denied);
    }
    if access::login_locked(addr.ip()) && flow.bind_session.is_none() {
        return Err((429, "登录尝试过多"));
    }
    let subject = flow::identity(
        &flow,
        settings.client(provider),
        query.get("code").map(String::as_str).unwrap_or_default(),
    )
    .await?;
    let admin = access::oauth_admin_stamp().ok_or(denied)?;
    if flow.bind_session.is_some() && flow.bind_session != access::oauth_cookie_session(headers) {
        return Err(denied);
    }
    if let Err(err) = oauth::authorize(
        state.db().ok_or((503, oauth::UNAVAILABLE))?,
        &flow,
        &subject,
        &admin,
    ) {
        if err.0 == 403 && flow.bind_session.is_none() {
            access::record_login_failure(addr.ip());
            crate::server::core::notifications::login(false);
        }
        return Err(err);
    }
    let mut response = StatusCode::SEE_OTHER.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/"));
    if flow.bind_session.is_none() {
        access::clear_login_failures(addr.ip());
        crate::server::core::notifications::login(true);
        let session = access::IssuedSession::new_session();
        let cookie = HeaderValue::from_str(&format!("{}; Secure", session.session_cookie))
            .map_err(|_| (503, oauth::UNAVAILABLE))?;
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

pub fn providers(state: &ServerState) -> Value {
    let available = access::oauth_admin_stamp()
        .and_then(|admin| {
            oauth::load(state.db())
                .ok()
                .map(|settings| settings.public(&admin))
        })
        .unwrap_or_default();
    json!(available)
}
