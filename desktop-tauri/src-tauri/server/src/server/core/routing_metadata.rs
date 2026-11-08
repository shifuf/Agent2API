//! Routing display metadata. Shares the existing models.dev refresh and never
//! publishes source models or sends account credentials to metadata services.
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{OnceLock, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::routing_model_identity::canonical;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub canonical_model: String,
    pub spelling: String,
    pub display_name: String,
    pub developer: String,
    pub developer_name: String,
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    updated_at: i64,
    source: String,
    models: BTreeMap<String, ModelIdentity>,
}

static INDEX: OnceLock<RwLock<Index>> = OnceLock::new();
const MAX_CACHE_BYTES: u64 = 16 * 1024 * 1024;

fn label(id: &str) -> String {
    match id {
        "openai" => "OpenAI", "anthropic" => "Anthropic", "google" => "Google",
        "deepseek" => "DeepSeek", "qwen" | "alibaba" => "Alibaba / Qwen",
        "moonshotai" | "moonshot" => "Moonshot AI", "zhipuai" | "z-ai" | "zhipu" => "Z.AI",
        "mistral" | "mistralai" => "Mistral AI", "meta" | "meta-llama" => "Meta",
        "xai" | "x-ai" => "xAI", "cohere" => "Cohere", "bytedance" => "ByteDance",
        "tencent" => "Tencent", "baidu" => "Baidu", "minimax" => "MiniMax",
        "perplexity" => "Perplexity", "nvidia" => "NVIDIA", "microsoft" => "Microsoft",
        "xiaomi" => "Xiaomi", "stepfun" => "StepFun", "amazon" => "Amazon",
        "custom" | "" => "自定义", _ => id,
    }.into()
}

fn inferred_developer(model: &str) -> &str {
    for (prefix, developer) in [("claude", "anthropic"), ("gpt", "openai"), ("o1", "openai"),
        ("o3", "openai"), ("o4", "openai"), ("chatgpt", "openai"), ("gemini", "google"),
        ("gemma", "google"), ("deepseek", "deepseek"), ("qwen", "alibaba"), ("qwq", "alibaba"),
        ("kimi", "moonshotai"), ("moonshot", "moonshotai"), ("glm", "zhipuai"),
        ("mistral", "mistral"), ("ministral", "mistral"), ("codestral", "mistral"),
        ("devstral", "mistral"), ("llama", "meta"), ("grok", "xai"), ("minimax", "minimax"),
        ("doubao", "bytedance"), ("hunyuan", "tencent"), ("ernie", "baidu"),
        ("command", "cohere"), ("sonar", "perplexity"), ("mimo", "xiaomi"), ("step", "stepfun")] {
        if model == prefix || model.strip_prefix(prefix).is_some_and(|tail| tail.starts_with('-') || tail.chars().next().is_some_and(|c| c.is_ascii_digit())) {
            return developer;
        }
    }
    "custom"
}

fn family(model: &str) -> String {
    // A display grouping only. Never used to decide whether models can share a route.
    let parts: Vec<_> = model.split('-').filter(|part| !part.is_empty()
        && !part.chars().all(|ch| ch.is_ascii_digit())
        && !matches!(*part, "preview" | "latest" | "exp" | "beta" | "alpha")).collect();
    if parts.is_empty() { model.into() } else { parts.join("-") }
}

fn fallback(model: &str) -> ModelIdentity {
    let identity = canonical(model);
    let developer = inferred_developer(&identity);
    ModelIdentity { canonical_model: identity.clone(), spelling: model.trim().rsplit('/').next().unwrap_or(model).into(),
        display_name: model.into(), developer: developer.into(), developer_name: label(developer), family: family(&identity), cost: None }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)).map(str::to_owned)
}

fn record(model: &str, entry: &Value, names: &BTreeMap<String, String>) -> ModelIdentity {
    let canonical_id = text(entry, "canonical_model_id").or_else(|| text(entry, "canonical")).unwrap_or_else(|| model.into());
    let mut result = fallback(&canonical_id);
    if let Some((maker, _)) = canonical_id.split_once('/') {
        result.developer = maker.into();
        result.developer_name = names.get(maker).cloned().unwrap_or_else(|| label(maker));
    }
    result.display_name = text(entry, "name").unwrap_or_else(|| result.spelling.clone());
    result.family = text(entry, "family").unwrap_or(result.family);
    result.cost = entry.get("cost").filter(|value| value.is_object()).map(|cost| {
        let mut clean = serde_json::Map::new();
        for key in ["input", "output", "cache_read", "cache_write"] {
            if let Some(value) = cost.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0) { clean.insert(key.into(), json!(value)); }
        }
        Value::Object(clean)
    });
    result
}

fn build(api: &Value, models: &Value) -> Index {
    let mut index = Index { updated_at: crate::server::logging::now_ms(), source: "models.dev".into(), ..Default::default() };
    let names: BTreeMap<_, _> = api.as_object().into_iter().flatten().filter_map(|(id, value)| text(value, "name").map(|name| (id.clone(), name))).collect();
    for (id, item) in models.as_object().into_iter().flatten() {
        let result = record(id, item, &names);
        if !result.canonical_model.is_empty() { index.models.insert(canonical(id), result); }
    }
    // Source entries provide alias -> canonical mappings, while native makers win
    // over reseller names/prices. Canonical records remain authoritative.
    for (provider, owner) in api.as_object().into_iter().flatten() {
        for (id, item) in owner.get("models").and_then(Value::as_object).into_iter().flatten() {
            let Some(canonical_id) = text(item, "canonical_model_id") else { continue };
            let result = record(&canonical_id, item, &names);
            if result.canonical_model.is_empty() { continue; }
            let native = canonical_id.split('/').next() == Some(provider.as_str());
            if native || !index.models.contains_key(&result.canonical_model) { index.models.insert(result.canonical_model.clone(), result.clone()); }
            let mut alias = index.models.get(&result.canonical_model).cloned().unwrap_or(result);
            // Price is the model's known metadata, not a promise about a relay's bill.
            alias.canonical_model = canonical(&canonical_id);
            index.models.entry(canonical(id)).or_insert(alias.clone());
            if let Some(id) = text(item, "id") { index.models.entry(canonical(&id)).or_insert(alias); }
        }
    }
    index
}

fn cache_path() -> std::path::PathBuf { crate::paths::config_dir().join("routing-model-metadata.json") }
fn current() -> &'static RwLock<Index> { INDEX.get_or_init(|| RwLock::new(load())) }
fn load() -> Index {
    let embedded: Value = serde_json::from_str(include_str!("model_meta/modelsdev.json")).unwrap_or_default();
    let mut index = build(&Value::Null, &embedded["models"]);
    // Embedded map keys are compressed; index by each actual canonical ID.
    index.models = index.models.into_values().map(|record| (record.canonical_model.clone(), record)).collect();
    index.updated_at = embedded["generatedAt"].as_i64().unwrap_or(0);
    index.source = "builtin".into();
    let path = cache_path();
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= MAX_CACHE_BYTES) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(cached) = serde_json::from_slice::<Index>(&bytes) {
                if !cached.models.is_empty() && cached.models.len() < 100_000 {
                    index = cached;
                    index.source = "cache".into();
                }
            }
        }
    }
    // Public catalog is already normalized and contains only model metadata.
    let public_path = crate::paths::config_dir().join("public-model-catalog.json");
    if std::fs::metadata(&public_path).is_ok_and(|meta| meta.len() <= MAX_CACHE_BYTES) {
        if let Ok(bytes) = std::fs::read(public_path) {
            if let Ok(public) = serde_json::from_slice::<super::public_model_catalog::CatalogSnapshot>(&bytes) { merge_public(&mut index, &public); }
        }
    }
    index
}

pub fn describe(model: &str) -> ModelIdentity {
    current().read().ok().and_then(|index| index.models.get(&canonical(model)).cloned()).unwrap_or_else(|| fallback(model))
}

pub fn status() -> Value {
    match current().read() {
        Ok(index) => json!({"source":index.source,"updatedAt":index.updated_at,"count":index.models.len(),
            "stale":crate::server::logging::now_ms().saturating_sub(index.updated_at)>86_400_000}),
        Err(_) => json!({"source":"unavailable","count":0,"updatedAt":0,"stale":true}),
    }
}

/// Called only after the existing metadata refresh has successfully parsed both
/// upstream documents. A failed download never replaces this last-good index.
pub fn update(api: &Value, models: &Value) {
    let index = build(api, models);
    if index.models.is_empty() { return; }
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let persisted = (|| -> Result<(), Box<dyn std::error::Error>> {
            std::fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&serde_json::to_vec(&index)?)?;
            file.as_file().sync_all()?;
            file.persist(&path)?;
            Ok(())
        })();
        if let Err(error) = persisted { crate::server::logging::log("[Routing]", &format!("路由模型元数据缓存写入失败: {error}")); }
    }
    if let Ok(mut slot) = current().write() { *slot = index; }
    super::providers::catalog::invalidate();
}

fn merge_public(index: &mut Index, public: &super::public_model_catalog::CatalogSnapshot) {
    for developer in &public.providers {
        for model in &developer.models {
            let key = canonical(&model.id);
            let item = index.models.entry(key).or_insert_with(|| fallback(&model.id));
            item.developer = developer.id.clone(); item.developer_name = developer.name.clone();
            item.display_name = model.name.clone();
            if let Some(family) = &model.family { item.family = family.clone(); }
        }
    }
}

pub fn update_public(public: &super::public_model_catalog::CatalogSnapshot) {
    if let Ok(mut index) = current().write() { merge_public(&mut index, public); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_uses_manufacturer_and_canonical_alias_not_reseller() {
        let api = json!({"deepseek":{"name":"DeepSeek","models":{"deepseek-chat":{"canonical_model_id":"deepseek/deepseek-v3","name":"DeepSeek V3","cost":{"input":0.2,"output":0.4}}}},
            "relay":{"name":"Relay","models":{"vendor/deepseek-chat":{"canonical_model_id":"deepseek/deepseek-v3","name":"Relay Special"}}}});
        let index = build(&api, &json!({"deepseek/deepseek-v3":{"name":"DeepSeek V3"}}));
        let alias = &index.models["deepseek-chat"];
        assert_eq!(alias.developer_name,"DeepSeek"); assert_eq!(alias.canonical_model,"deepseek-v3");
        assert_eq!(alias.display_name,"DeepSeek V3"); assert_eq!(alias.cost.as_ref().unwrap()["input"],0.2);
        assert!(!index.models.contains_key("deepseek-v3:free"));
    }
    #[test]
    fn unknowns_keep_identity_and_offline_prefixes_have_vendor_names() {
        assert_eq!(fallback("my-unknown:variant").canonical_model,"my-unknown:variant");
        assert_eq!(fallback("openrouter/claude-sonnet-4.5").developer_name,"Anthropic");
        assert_eq!(fallback("my-unknown").developer,"custom");
    }
}
