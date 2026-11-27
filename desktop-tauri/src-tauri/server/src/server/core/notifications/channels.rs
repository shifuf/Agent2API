use std::time::Duration;

use reqwest::{header::{HeaderName, HeaderValue}, Client};
use serde_json::{json, Value};
use url::Url;

use super::{object, Error, Fields};

pub(super) fn validate(key: &str, value: &Value) -> Result<(), Error> {
    if key == "headers" {
        let headers = object(value)?;
        if headers.len() > 32 { return Err((400, "通知请求头过多")); }
        for (name, text) in headers {
            let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| (400, "通知请求头无效"))?;
            if matches!(header.as_str(), "host" | "content-length" | "transfer-encoding" | "connection" | "proxy-authorization" | "content-type") {
                return Err((400, "不允许覆盖该通知请求头"));
            }
            HeaderValue::from_str(text.as_str().filter(|s| s.len() <= 4096).ok_or((400, "通知请求头无效"))?)
                .map_err(|_| (400, "通知请求头无效"))?;
        }
        return Ok(());
    }
    let text = value.as_str().filter(|text| text.len() <= 4096 && !text.chars().any(char::is_control)).ok_or((400, "通知参数无效"))?;
    if matches!(key, "url" | "apiBase" | "serverUrl" | "proxyUrl") {
        let url = Url::parse(text).map_err(|_| (400, "通知地址无效"))?;
        let valid_scheme = matches!(url.scheme(), "http" | "https") || (key == "proxyUrl" && matches!(url.scheme(), "socks5" | "socks5h"));
        if !valid_scheme || url.host().is_none() || url.fragment().is_some() || (key != "url" && url.query().is_some())
            || (key != "proxyUrl" && (!url.username().is_empty() || url.password().is_some())) { return Err((400, "通知地址无效")); }
    }
    if key == "botToken" && !text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte)) { return Err((400, "Telegram Bot Token 格式无效")); }
    Ok(())
}

pub(super) async fn send(kind: &str, secrets: &Fields, event: &str, title: &str, body: &str, data: &Value) -> Result<(), Error> {
    let empty = Value::Null;
    let section = secrets.get(kind).unwrap_or(&empty);
    let text = |key: &str| section.get(key).and_then(Value::as_str).unwrap_or("");
    let mut builder = Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none());
    if kind == "telegram" && !text("proxyUrl").is_empty() {
        builder = builder.no_proxy().proxy(reqwest::Proxy::all(text("proxyUrl")).map_err(|_| (400, "Telegram 代理地址无效"))?);
    }
    let client = builder.build().map_err(|_| (502, "通知连接不可用"))?;
    let request = match kind {
        "webhook" => {
            if text("url").is_empty() { return Err((400, "请先配置 Webhook 地址")); }
            let mut request = client.post(text("url")).json(&json!({"source":"Agent2API", "event":event, "title":title,
                "body":body,"timestamp":crate::server::logging::now_ms(),"data":data}));
            if let Some(headers) = section["headers"].as_object() {
                for (name, content) in headers { request = request.header(name.as_str(), content.as_str().ok_or((400, "通知请求头无效"))?); }
            }
            request
        }
        "telegram" => {
            if text("botToken").is_empty() || text("chatId").is_empty() { return Err((400, "请配置 Telegram Bot Token 和 Chat ID")); }
            let base = if text("apiBase").is_empty() { "https://api.telegram.org" } else { text("apiBase") };
            client.post(format!("{}/bot{}/sendMessage", base.trim_end_matches('/'), text("botToken")))
                .json(&json!({"chat_id":text("chatId"),"text":format!("{title}\n{body}"),"disable_web_page_preview":true}))
        }
        "bark" => {
            if text("deviceKey").is_empty() { return Err((400, "请配置 Bark Device Key")); }
            let base = if text("serverUrl").is_empty() { "https://api.day.app" } else { text("serverUrl") };
            let mut message = json!({"device_key":text("deviceKey"),"title":title,"body":body,
                "group":if text("group").is_empty() { "Agent2API" } else { text("group") }});
            if !text("sound").is_empty() { message["sound"] = json!(text("sound")); }
            client.post(format!("{}/push", base.trim_end_matches('/'))).json(&message)
        }
        _ => return Err((400, "未知通知渠道")),
    };
    let mut response = request.send().await.map_err(|_| (502, "通知请求失败或超时"))?;
    if !response.status().is_success() { return Err((502, "通知服务拒绝了请求")); }
    if kind == "webhook" { return Ok(()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| (502, "通知响应不完整"))? {
        if bytes.len() + chunk.len() > 64 * 1024 { return Err((502, "通知响应过大")); }
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| (502, "通知服务响应无效"))?;
    if (kind == "telegram" && result["ok"] != true) || (kind == "bark" && result["code"] != 200) {
        return Err((502, "通知服务未确认送达"));
    }
    Ok(())
}
