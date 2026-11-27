use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use futures::StreamExt;
use reqwest::{Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{store, types::{self, TaskPlugin, TASK_SCRIPT_TARGET}};
use crate::server::{config, core::{egress, plugin_host, proxies, update}, logging};

const CATALOG: &str = "https://cdn.agent2api.dev/agent2api/feeds/plugins/catalog.json";
const LIMIT: usize = 2 * 1024 * 1024;
static CACHE: Mutex<Option<(config::UpdateChannels, i64, Vec<Asset>)>> = Mutex::new(None);

#[derive(Clone)]
struct Asset {
    id: String,
    name: String,
    version: String,
    tag: String,
    file: String,
    url: Url,
    sha256: String,
    size: usize,
}

fn hex_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) }
fn component(value: &str) -> bool {
    !value.is_empty() && value.len() <= 180 && !value.contains("..") && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

impl Asset {
    fn permits(&self, url: &Url) -> bool {
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.query().is_some() || url.fragment().is_some() { return false; }
        let path: Vec<_> = url.path_segments().into_iter().flatten().collect();
        match (url.host_str(), path.as_slice()) {
            (Some("agent2api.dev"), ["downloads", "plugins", id, tag, name]) => *id == self.id && *tag == self.tag && *name == self.file,
            (Some("cdn.agent2api.dev"), ["agent2api", "plugins", id, tag, hash, name]) => *id == self.id && *tag == self.tag && self.sha256.eq_ignore_ascii_case(hash) && *name == self.file,
            _ => false,
        }
    }
}

fn release_asset(entry: &Value, release: &Value, channels: config::UpdateChannels) -> Option<Asset> {
    let id = entry["id"].as_str().filter(|id| types::valid_slug(id))?;
    if release["draft"].as_bool() == Some(true) { return None; }
    let detail = &entry["detail"]["release"];
    let tag = release["tag_name"].as_str().filter(|tag| component(tag))?;
    let (prefix, suffix) = detail["tag"].as_str().unwrap_or("v{version}").split_once("{version}")?;
    let version = tag.strip_prefix(prefix)?.strip_suffix(suffix)?;
    update::compare_versions(version, version)?;
    if !channels.accepts(release["prerelease"].as_bool().unwrap_or(false) || version.contains('-')) { return None; }
    let template = detail["asset"].as_str().unwrap_or("{id}-{version}-{target}.zip");
    if !template.contains("{target}") { return None; }
    let file = template.replace("{id}", id).replace("{version}", version).replace("{target}", TASK_SCRIPT_TARGET);
    if !component(&file) || !file.ends_with(".zip") { return None; }
    let mut assets = release["assets"].as_array()?.iter().filter(|item| item["name"].as_str() == Some(&file));
    let item = assets.next()?;
    if assets.next().is_some() { return None; }
    let sha256 = item["digest"].as_str()?.strip_prefix("sha256:").filter(|digest| hex_digest(digest))?.to_ascii_lowercase();
    let size = usize::try_from(item["size"].as_u64()?).ok().filter(|size| (1..=LIMIT).contains(size))?;
    let url = Url::parse(item["browser_download_url"].as_str()?).ok()?;
    let result = Asset { id:id.into(), name:entry["name"].as_str().unwrap_or(id).chars().take(100).collect(), version:version.into(), tag:tag.into(), file, url, sha256, size };
    result.permits(&result.url).then_some(result)
}

fn parse_catalog(bytes: &[u8], channels: config::UpdateChannels) -> Result<Vec<Asset>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "任务插件目录格式无效")?;
    if value["schema"] != 1 { return Err("任务插件目录版本无效".into()); }
    let entries = value["plugins"].as_array().filter(|items| items.len() <= 200).ok_or("任务插件目录大小无效")?;
    let mut result = BTreeMap::new();
    for entry in entries.iter().filter(|entry| entry["category"] == "scheduled_task") {
        let releases: &[Value] = entry["releases"].as_array().map(Vec::as_slice).unwrap_or_else(|| std::slice::from_ref(&entry["release"]));
        for release in releases {
            if let Some(candidate) = release_asset(entry, release, channels) {
                let previous: Option<&Asset> = result.get(&candidate.id);
                if previous.is_none_or(|old| update::compare_versions(&candidate.version, &old.version) == Some(1)) { result.insert(candidate.id.clone(), candidate); }
            }
        }
    }
    Ok(result.into_values().collect())
}

fn outbound() -> Result<Client, String> {
    let proxy = match config::update_proxy() {
        Some(setting) => match proxies::resolve_account_proxy(Some(&setting)) {
            Some(proxies::ProxyResolution::Resolved(proxy)) if proxy.port.is_some() => Some(proxy),
            _ => return Err("任务插件更新代理不可用".into()),
        },
        None => None,
    };
    egress::resolved_client(proxy.as_ref(), false, "", &[]).map_err(|_| "无法建立任务插件更新连接".into())
}

async fn fetch(http: &Client, mut url: Url, asset: Option<&Asset>, limit: usize, destination: impl Fn(&Url) -> Url) -> Result<Vec<u8>, String> {
    let request = async {
        for _ in 0..=3 {
            if !asset.map_or_else(|| url.as_str() == CATALOG, |asset| asset.permits(&url)) { return Err("任务插件下载地址不受信任".into()); }
            let response = http.get(destination(&url)).header(reqwest::header::ACCEPT_ENCODING, "identity").send().await.map_err(|_| "任务插件下载连接失败")?;
            if response.status().is_redirection() {
                let location = response.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok()).ok_or("任务插件下载跳转无效")?;
                url = url.join(location).map_err(|_| "任务插件下载跳转无效")?;
                continue;
            }
            if response.status().as_u16() != 200 || response.content_length().is_some_and(|size| size > limit as u64) { return Err("任务插件下载响应无效".into()); }
            let mut data = Vec::new();
            let mut chunks = response.bytes_stream();
            while let Some(chunk) = chunks.next().await {
                let chunk = chunk.map_err(|_| "任务插件下载中断")?;
                if chunk.len() > limit - data.len() { return Err("任务插件下载过大".into()); }
                data.extend_from_slice(&chunk);
            }
            return Ok(data);
        }
        Err("任务插件下载跳转次数过多".into())
    };
    tokio::time::timeout(Duration::from_secs(20), request).await.map_err(|_| "任务插件下载超时")?
}

fn unpack(bytes: &[u8], asset: &Asset, trusted: &[(&str, &str)]) -> Result<TaskPlugin, String> {
    if bytes.len() != asset.size || format!("{:x}", Sha256::digest(bytes)) != asset.sha256 { return Err("任务插件包大小或摘要校验失败".into()); }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "任务插件 ZIP 无效")?;
    if zip.len() > 16 { return Err("任务插件 ZIP 条目过多".into()); }
    let (mut manifest, mut script) = (None, None);
    for index in 0..zip.len() {
        let file = zip.by_index(index).map_err(|_| "读取任务插件 ZIP 失败")?;
        let (slot, limit) = match file.name() {
            "pack.json" => (&mut manifest, 128 * 1024),
            "script.js" | "plugin.js" => (&mut script, types::MAX_SCRIPT_BYTES + 64 * 1024),
            "icon.png" | "icon.webp" | "icon.svg" => continue,
            _ => return Err("任务插件 ZIP 包含不支持的路径".into()),
        };
        if slot.is_some() || file.size() > limit as u64 { return Err("任务插件 ZIP 条目重复或过大".into()); }
        let mut text = String::new();
        file.take(limit as u64 + 1).read_to_string(&mut text).map_err(|_| "任务插件 ZIP 内容无效")?;
        if text.len() > limit { return Err("任务插件 ZIP 条目过大".into()); }
        *slot = Some(text);
    }
    let script = script.ok_or("任务插件 ZIP 缺少脚本")?;
    let manifest: Value = serde_json::from_str(&manifest.ok_or("任务插件 ZIP 缺少清单")?).map_err(|_| "任务插件清单无效")?;
    if manifest["id"] != asset.id || manifest["version"] != asset.version { return Err("任务插件清单与所选版本不符".into()); }
    let sig = &manifest["signature"];
    if !sig["algorithm"].as_str().is_some_and(|alg| alg.eq_ignore_ascii_case("ed25519")) { return Err("任务插件缺少受信任签名".into()); }
    let key = trusted.iter().find(|(id, _)| Some(*id) == sig["key_id"].as_str()).map(|(_, key)| *key).filter(|key| hex_digest(key)).ok_or("任务插件签名密钥不受信任")?;
    let mut public_key = [0; 32];
    for (index, byte) in public_key.iter_mut().enumerate() { *byte = u8::from_str_radix(&key[index*2..index*2+2],16).map_err(|_| "任务插件公钥无效")?; }
    let public_key = VerifyingKey::from_bytes(&public_key).map_err(|_| "任务插件公钥无效")?;
    let signature = STANDARD.decode(sig["value"].as_str().ok_or("任务插件缺少签名")?).ok().and_then(|bytes| Signature::from_slice(&bytes).ok()).ok_or("任务插件签名格式无效")?;
    let payload = format!("task-script-v1\n{}\n{}\n{:x}", asset.id, asset.version, Sha256::digest(script.as_bytes()));
    public_key.verify_strict(payload.as_bytes(), &signature).map_err(|_| "任务插件签名校验失败")?;
    let mut plugin = types::parse_single_file(&script, "official").map_err(|_| "任务插件脚本声明无效或需要未开放的权限")?;
    if plugin.id != asset.id || plugin.version != asset.version { return Err("任务插件脚本与所选版本不符".into()); }
    plugin.source = "official".into(); plugin.signed = true; plugin.enabled = false; plugin.notify_allowed = false; plugin.icon.clear();
    Ok(plugin)
}

pub fn snapshot() -> Value {
    let channels = plugin_host::settings::current().channels();
    let cache = CACHE.lock().unwrap_or_else(|err| err.into_inner());
    let Some((_, time, items)) = cache.as_ref().filter(|(old,_,_)| *old == channels) else { return json!({"items":[],"checkedAt":null}); };
    json!({"checkedAt":time,"items":items.iter().map(|item| json!({"id":item.id,"name":item.name,"version":item.version,"sha256":item.sha256,"size":item.size})).collect::<Vec<_>>()})
}

pub async fn refresh() -> Result<Value, String> {
    let channels = plugin_host::settings::current().channels();
    let contents = fetch(&outbound()?, Url::parse(CATALOG).map_err(|_| "任务插件目录地址无效")?, None, LIMIT, Url::clone).await?;
    let items = parse_catalog(&contents, channels)?;
    *CACHE.lock().map_err(|_| "任务插件目录不可用")? = Some((channels, logging::now_ms(), items));
    Ok(snapshot())
}

pub async fn install(id: &str, sha256: &str) -> Result<TaskPlugin, String> {
    let channels = plugin_host::settings::current().channels();
    let asset = CACHE.lock().map_err(|_| "任务插件目录不可用")?.as_ref().filter(|(old,_,_)| *old == channels)
        .and_then(|(_,_,items)| items.iter().find(|item| item.id == id && item.sha256 == sha256)).cloned().ok_or("请先刷新目录并选择有效版本")?;
    if store::get_plugin(id)?.is_some() { return Err("任务插件已存在，未覆盖".into()); }
    let bytes = fetch(&outbound()?, asset.url.clone(), Some(&asset), asset.size, Url::clone).await?;
    store::create_plugin(unpack(&bytes, &asset, plugin_host::OFFICIAL_PUBKEYS)?)
}

#[cfg(test)]
mod tests;
