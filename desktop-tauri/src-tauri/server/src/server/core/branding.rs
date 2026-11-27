use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::db::Db;

pub const KEY: &str = "panelBranding";
pub const DEFAULT_NAME: &str = "Agent2API";
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Branding {
    display_name: String,
    logo_png: Option<String>,
}

impl Branding {
    fn public(&self) -> Value {
        let name = if self.display_name.is_empty() {
            DEFAULT_NAME
        } else {
            &self.display_name
        };
        let url = self.logo_png.as_ref().map(|png| {
            format!(
                "/api/panel/branding/logo?v={:x}",
                Sha256::digest(png.as_bytes())
            )
        });
        json!({ "displayName": name, "logoUrl": url })
    }
}

fn read(conn: &Connection) -> Result<Branding, String> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| row.get(0))
        .optional()
        .map_err(|_| "读取品牌设置失败")?;
    text.map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map(Option::unwrap_or_default)
        .map_err(|_| "品牌设置格式无效".into())
}

pub fn public(db: &Db) -> Result<Value, String> {
    db.with(read)
        .ok_or("数据库不可用")?
        .map(|brand| brand.public())
}

pub fn logo(db: &Db) -> Result<Option<(Vec<u8>, String)>, String> {
    let Some(encoded) = db.with(read).ok_or("数据库不可用")??.logo_png else {
        return Ok(None);
    };
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("品牌 Logo 过大".into());
    }
    let bytes = STANDARD
        .decode(&encoded)
        .map_err(|_| "品牌 Logo 格式无效")?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("品牌 Logo 格式无效".into());
    }
    Ok(Some((
        bytes,
        format!("\"{:x}\"", Sha256::digest(encoded.as_bytes())),
    )))
}

fn normalize_logo(data: &str) -> Result<String, String> {
    let (mime, encoded) = data.split_once(',').ok_or("品牌 Logo 必须为上传的图片")?;
    let format = match mime {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err("品牌 Logo 仅支持 PNG、JPEG 或 WebP".into()),
    };
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("品牌 Logo 超过 2 MiB".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "品牌 Logo 编码无效")?;
    if bytes.len() > MAX_BYTES || image::guess_format(&bytes).ok() != Some(format) {
        return Err("品牌 Logo 内容与格式不符".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "品牌 Logo 无法解码或尺寸过大")?;
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(decoded.thumbnail(512, 512).to_rgba8())
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "品牌 Logo 转码失败")?;
    Ok(STANDARD.encode(output.into_inner()))
}

pub fn save(db: &Db, body: Value) -> Result<Value, (i32, String)> {
    let invalid = |message: &str| (400, String::from(message));
    let object = body
        .as_object()
        .ok_or_else(|| invalid("品牌设置必须是对象"))?;
    let name = match object.get("displayName") {
        None => None,
        Some(Value::Null) => Some(String::new()),
        Some(Value::String(name))
            if name.trim().chars().count() <= 64
                && !name
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}')) =>
        {
            Some(name.trim().to_owned())
        }
        _ => return Err(invalid("显示名称不能超过 64 个字符或包含控制字符")),
    };
    let logo = match object.get("logo") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(data)) => {
            Some(Some(normalize_logo(data).map_err(|error| (400, error))?))
        }
        _ => return Err(invalid("品牌 Logo 必须为图片或空值")),
    };
    if logo.is_none() && name.is_none() {
        return Err(invalid("没有品牌设置需要保存"));
    }
    db.with_mut(|conn| -> Result<Value, String> {
        let tx = conn.transaction().map_err(|_| "保存品牌设置失败")?;
        let mut brand = read(&tx)?;
        if let Some(name) = name { brand.display_name = name; }
        if let Some(logo) = logo { brand.logo_png = logo; }
        let text = serde_json::to_string(&brand).map_err(|_| "品牌编码失败")?;
        tx.execute("INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY, text]).map_err(|_| "保存品牌设置失败")?;
        tx.commit().map_err(|_| "保存品牌设置失败")?;
        Ok(brand.public())
    }).ok_or_else(|| (503, String::from("数据库不可用")))?.map_err(|error| (500, error))
}
