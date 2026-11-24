use agent2api_provider_protocol as proto;
use serde_json::Value;
use super::{context::Context, resources::Resources};
use super::super::script::RequestBody;

/// 原受控 CatPaw 轮次不能借通用 HTTP/WS 通道重新构造；别名路径同样拒绝。
pub(super) fn catpaw_creation_url(raw: &str) -> Result<bool, proto::WireError> {
    let invalid = || proto::WireError::with_code("CatPaw 网络路径无效", "bad_params");
    let parsed = url::Url::parse(raw).map_err(|_| invalid())?;
    if parsed.host_str() != Some("ai.catpaw.meituan.com") { return Ok(false); }
    let mut path = parsed.path().to_string();
    if path.len() > 8192 { return Err(invalid()); }
    for _ in 0..4 {
        if !path.contains('%') { break; }
        let mut decoded = Vec::with_capacity(path.len());
        let bytes = path.as_bytes();
        let mut index = 0;
        let hex = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'), b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10), _ => None,
        };
        while index < bytes.len() {
            let byte = if bytes[index] == b'%' {
                let high = hex(*bytes.get(index + 1).ok_or_else(invalid)?).ok_or_else(invalid)?;
                let low = hex(*bytes.get(index + 2).ok_or_else(invalid)?).ok_or_else(invalid)?;
                index += 3;
                high * 16 + low
            } else { let byte = bytes[index]; index += 1; byte };
            if byte.is_ascii_control() || byte == b'\\' { return Err(invalid()); }
            decoded.push(byte);
        }
        path = String::from_utf8(decoded).map_err(|_| invalid())?;
    }
    if path.contains('%') { return Err(invalid()); }
    let mut segments = Vec::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        match segment.split(';').next().unwrap_or("") {
            "" | "." => {}, ".." => { segments.pop(); }, segment => segments.push(segment),
        }
    }
    let canonical = format!("/{}", segments.join("/")).to_ascii_lowercase();
    Ok(canonical == "/api/agent/conversation" || canonical.starts_with("/api/agent/conversation/"))
}

pub(super) fn deadline(context: &Context, params: &Value, started: tokio::time::Instant) -> Result<tokio::time::Instant, proto::WireError> {
    let Some(value) = params.get("timeout_ms") else { return Ok(context.call_deadline); };
    context.permission("http.timeout.v1")?;
    let millis = value.as_u64().ok_or_else(|| proto::WireError::with_code("请求期限必须是非负整数毫秒", "bad_params"))?
        .clamp(1000, 600_000);
    Ok((started + std::time::Duration::from_millis(millis)).min(context.call_deadline))
}

fn name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-[]".contains(&byte))
}

pub(super) fn body(context: &Context, params: &Value) -> Result<Option<RequestBody>, proto::WireError> {
    let resource = params.get("body_resource").filter(|value| !value.is_null());
    let multipart = params.get("multipart").filter(|value| !value.is_null());
    if resource.is_some() as u8 + multipart.is_some() as u8 + params.get("body").is_some_and(|value| !value.is_null()) as u8 > 1 {
        return Err(super::error("请求正文不能同时使用多种传输形式"));
    }
    if let Some(resource) = resource {
        context.permission("resources.v1")?;
        return Ok(Some(RequestBody::Bytes(context.blobs.raw(resource.as_str().ok_or_else(super::errors::protocol)?)?)));
    }
    let Some(multipart) = multipart else { return Ok(None) };
    context.permission("resources.v1")?;
    Ok(Some(RequestBody::Multipart(form(&context.blobs, multipart)?)))
}

fn form(resources: &Resources, multipart: &Value) -> Result<reqwest::multipart::Form, proto::WireError> {
    let fields = multipart["fields"].as_object().filter(|fields| fields.len() <= 64).ok_or_else(super::errors::protocol)?;
    let files = multipart["files"].as_array().filter(|files| files.len() <= 16).ok_or_else(super::errors::protocol)?;
    let mut total = 0;
    let mut form = reqwest::multipart::Form::new();
    for (key, value) in fields {
        if !name(key) || !value.is_string() { return Err(super::errors::protocol()); }
        let text = value.as_str().unwrap_or("");
        total += text.len();
        if total > 1024 * 1024 { return Err(super::error("上传文本字段过大")); }
        form = form.text(key.clone(), text.to_string());
    }
    for file in files {
        let field = file["field"].as_str().unwrap_or("");
        let filename = file["filename"].as_str().unwrap_or("");
        if !name(field) || !name(filename) { return Err(super::errors::protocol()); }
        let bytes = resources.raw(file["resource"].as_str().ok_or_else(super::errors::protocol)?)?;
        total += bytes.len();
        if total > 96 * 1024 * 1024 { return Err(super::error("上传总量超过资源限制")); }
        let part = reqwest::multipart::Part::stream(reqwest::Body::from(bytes))
            .file_name(filename.to_string()).mime_str(file["content_type"].as_str().unwrap_or("application/octet-stream"))
            .map_err(|_| super::error("上传文件类型无效"))?;
        form = form.part(field.to_string(), part);
    }
    Ok(form)
}
