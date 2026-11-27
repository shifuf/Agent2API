use std::collections::HashSet;
use std::io::Read;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod archives;
pub mod probe;

const PACK_LIMIT: usize = 4 * 1024 * 1024;
const EXPANDED_LIMIT: usize = 16 * 1024 * 1024;
pub const BODY_LIMIT: usize = (PACK_LIMIT + 2) / 3 * 4 + 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Inspection {
    archive: String,
    sha256: String,
    #[serde(default)]
    retain: bool,
    previous_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Source {
    kind: String,
    name: String,
    revision: String,
    sha256: String,
    #[serde(default)]
    retain: bool,
    previous_sha256: Option<String>,
}

impl Source {
    fn url(&self) -> Result<String, &'static str> {
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("需要独立取得的 SHA-256"); }
        let revision = self.revision.as_str();
        match self.kind.as_str() {
            "npm" if package_name(&self.name) => {
                let release = revision.split(['-', '+']).next().unwrap_or_default();
                if revision.len() > 80 || !revision.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)) || release.split('.').count() != 3 || !release.split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())) { return Err("npm 来源必须指定固定版本"); }
                let basename = self.name.rsplit('/').next().unwrap();
                Ok(format!("https://registry.npmjs.org/{}/-/{basename}-{revision}.tgz", self.name))
            }
            "github" => {
                let parts: Vec<_> = self.name.split('/').collect();
                if parts.len() != 2 || !parts.iter().all(|part| safe_part(part) && !part.starts_with('.') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))) || revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("GitHub 来源需要仓库及完整提交 SHA"); }
                Ok(format!("https://codeload.github.com/{}/tar.gz/{revision}", self.name))
            }
            _ => Err("不支持的插件来源"),
        }
    }
}

pub async fn inspect_source(source: Source) -> Result<Value, (i32, &'static str)> {
    let url = source.url().map_err(|error| (400, error))?;
    let host = if source.kind == "npm" { "registry.npmjs.org" } else { "codeload.github.com" };
    use crate::server::{config, core::{egress, proxies}};
    let proxy = match config::update_proxy() {
        Some(setting) => match proxies::resolve_account_proxy(Some(&setting)) {
            Some(proxies::ProxyResolution::Resolved(proxy)) if proxy.port.is_some() => Some(proxy),
            _ => return Err((503, "指定的更新代理不可用")),
        },
        None => None,
    };
    let client = egress::resolved_client(proxy.as_ref(), true, host, &[]).map_err(|_| (503, "无法初始化插件下载"))?;
    let mut response = client.get(url).header("User-Agent", "Agent2API-package-inspection").timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| (502, "无法下载固定版本的插件包"))?;
    if !response.status().is_success() { return Err((502, "插件源未返回归档；不跟随重定向")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| (502, "归档下载中断"))? {
        if bytes.len() + chunk.len() > PACK_LIMIT { return Err((413, "插件归档超过限制")); }
        bytes.extend_from_slice(&chunk);
    }
    tokio::task::spawn_blocking(move || {
        let mut result = inspect_archive(&bytes, &source.sha256)?;
        if source.kind == "npm" && (result["name"] != source.name || result["version"] != source.revision) { return Err("npm 包名或版本与来源不匹配"); }
        result["source"] = json!({"kind":source.kind,"name":source.name,"revision":source.revision});
        if source.retain { archives::retain(&bytes, &mut result, source.previous_sha256.as_deref())?; }
        Ok(result)
    }).await.map_err(|_| (500, "验包未完成"))?.map_err(|error| (400, error))
}

fn safe_part(part: &str) -> bool {
    !part.is_empty() && part.len() <= 120 && part != "." && part != ".."
        && !part.ends_with('.') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-@+".contains(&byte))
}

fn package_name(name: &str) -> bool {
    let valid = |part: &str| safe_part(part) && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)) && !part.starts_with(['.', '-']);
    match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').is_some_and(|(scope, pkg)| valid(scope) && valid(pkg)),
        None => valid(name),
    }
}

fn export_path(value: &Value) -> Option<&str> {
    if let Some(path) = value.as_str() { return Some(path) }
    ["import", "default", "node", "require", "bun"].iter().find_map(|key| value.get(key).and_then(export_path))
}

pub fn inspect(request: Inspection) -> Result<Value, &'static str> {
    let bytes = STANDARD.decode(request.archive).map_err(|_| "插件归档编码错误")?;
    let mut result = inspect_archive(&bytes, &request.sha256)?;
    if request.retain { archives::retain(&bytes, &mut result, request.previous_sha256.as_deref())?; }
    Ok(result)
}

fn inspect_archive(bytes: &[u8], sha256: &str) -> Result<Value, &'static str> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("需要独立取得的 SHA-256"); }
    if bytes.is_empty() || bytes.len() > PACK_LIMIT { return Err("插件归档超过限制"); }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if !digest.eq_ignore_ascii_case(sha256) { return Err("插件归档 SHA-256 不匹配"); }
    let mut unpacked = Vec::new();
    let mut decoder = flate2::bufread::GzDecoder::new(bytes);
    decoder.by_ref().take(EXPANDED_LIMIT as u64 + 1).read_to_end(&mut unpacked).map_err(|_| "无效的 gzip 插件归档")?;
    if unpacked.len() > EXPANDED_LIMIT || !decoder.into_inner().is_empty() { return Err("插件归档过大或含多个数据段"); }
    let mut archive = tar::Archive::new(unpacked.as_slice());
    let mut root = String::new();
    let mut files = HashSet::new();
    let mut seen = HashSet::new();
    let mut manifest = None;
    for (index, entry) in archive.entries().map_err(|_| "无效的 tar 插件归档")?.enumerate() {
        if index >= 2048 { return Err("插件归档条目过多") }
        let mut entry = entry.map_err(|_| "插件归档条目损坏")?;
        let kind = entry.header().entry_type();
        if index == 0 && kind.is_pax_global_extensions() && entry.size() <= 256 {
            let mut fields = entry.pax_extensions().map_err(|_| "Git 归档元数据损坏")?.ok_or("缺少 Git 元数据")?;
            let field = fields.next().transpose().map_err(|_| "Git 归档元数据损坏")?.ok_or("缺少 Git 提交信息")?;
            if field.key_bytes() != b"comment" || field.value_bytes().len() != 40 || !field.value_bytes().iter().all(u8::is_ascii_hexdigit) || fields.next().is_some() { return Err("不支持的全局归档元数据"); }
            continue;
        }
        if !kind.is_file() && !kind.is_dir() { return Err("插件归档不允许链接或特殊文件") }
        let bytes = entry.path_bytes();
        let full = std::str::from_utf8(&bytes).map_err(|_| "无效的归档路径")?.trim_end_matches('/');
        if full.len() > 400 || !full.split('/').all(safe_part) || !seen.insert(full.to_ascii_lowercase()) { return Err("插件归档路径非法或重复") }
        let (prefix, relative) = full.split_once('/').unwrap_or((full, ""));
        if root.is_empty() { root = prefix.to_owned(); }
        if root != prefix || (relative.is_empty() && !kind.is_dir()) { return Err("插件归档必须只包含一个包目录") }
        if kind.is_file() {
            files.insert(relative.to_owned());
            if relative == "package.json" {
                if entry.size() > 128 * 1024 { return Err("插件清单过大"); }
                manifest = Some(serde_json::from_reader::<_, Value>(&mut entry).map_err(|_| "插件清单格式错误")?);
            }
        }
    }
    let manifest = manifest.ok_or("缺少 package.json")?;
    let name = manifest["name"].as_str().filter(|name| package_name(name)).ok_or("插件包名无效")?;
    let version = manifest["version"].as_str().filter(|version| !version.is_empty() && version.len() <= 80 && version.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))).ok_or("插件版本无效")?;
    let exports = &manifest["exports"];
    let declared = export_path(&exports["./server"]).or_else(|| manifest["main"].as_str()).or_else(|| export_path(&exports["."])).or_else(|| export_path(exports));
    let entry = if let Some(declared) = declared {
        let path = declared.strip_prefix("./").unwrap_or(declared);
        if !path.split('/').all(safe_part) || !files.contains(path) { return Err("声明的插件入口不存在或不在包内") }
        path
    } else {
        ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"].into_iter().find(|entry| files.contains(*entry)).ok_or("找不到脚本入口")?
    };
    if !entry.rsplit_once('.').is_some_and(|(_, ext)| matches!(ext, "mjs" | "js" | "cjs" | "ts" | "tsx")) { return Err("插件入口不是脚本文件") }
    let scripts = &manifest["scripts"];
    let lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"].iter().any(|key| scripts.get(key).is_some());
    Ok(json!({"name":name,"version":version,"entry":entry,"sha256":digest,"fileCount":files.len(),"lifecycleScripts":lifecycle,"installed":false,"executed":false}))
}
