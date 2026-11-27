use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::server::{config, core::{account_store::AccountStore, key_scope::KeyScope, providers::{catalog, images::ImageOperation}}, errors::GatewayError};

const KEY: &str = "toolImageGeneration";
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ImageTarget { pub model: String }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ImageConfig {
    pub generation: ImageTarget, pub editing: Option<ImageTarget>, pub max_images: u32, pub max_concurrency: u32,
    pub retention_hours: u32, pub storage_mb: u32,
}
impl Default for ImageConfig {
    fn default() -> Self { Self { generation: ImageTarget::default(), editing: None, max_images: 1, max_concurrency: 2, retention_hours: 1, storage_mb: 64 } }
}
impl ImageConfig {
    fn bounded(&self) -> bool { (1..=4).contains(&self.max_images) && (1..=4).contains(&self.max_concurrency) && (1..=24).contains(&self.retention_hours) && (64..=512).contains(&self.storage_mb) }
}
pub fn load() -> Option<ImageConfig> {
    serde_json::from_value(config::current().raw().get(KEY)?.clone()).ok().filter(ImageConfig::bounded)
}
pub fn target(config: &ImageConfig, operation: ImageOperation) -> Result<&ImageTarget, GatewayError> {
    match operation { ImageOperation::Generate => Some(&config.generation), ImageOperation::Edit => config.editing.as_ref() }
        .ok_or_else(|| GatewayError::with_status(503, "未配置图片路由组"))
}
pub fn allowed(store: &AccountStore, model: &str, scope: Option<&KeyScope>, operation: ImageOperation) -> Result<(), GatewayError> {
    let flag = if operation == ImageOperation::Edit { "supports_image_editing" } else { "supports_image_generation" };
    if !model.is_empty() && catalog::models_response(store, scope)["data"].as_array().is_some_and(|rows| rows.iter().any(|row|
        row["id"].as_str() == Some(model) && row["routing_group"] == true && row["kind"] == "image" && row[flag] == true)) { return Ok(()); }
    Err(GatewayError::with_status(404, "图片路由组不可用或不在此 Key 的授权范围内").with_code("model_not_found"))
}
pub fn view(store: &AccountStore) -> Value {
    let models = catalog::models_response(store, None)["data"].as_array().into_iter().flatten().filter(|row| row["kind"] == "image" && row["routing_group"] == true).cloned().collect::<Vec<_>>();
    json!({"config":load(), "models": models})
}
pub fn save(store: &AccountStore, config: Option<ImageConfig>) -> Result<Value, GatewayError> {
    if let Some(settings) = &config {
        if !settings.bounded() { return Err(GatewayError::bad_request("图片数量、并发、保留时间或存储容量超出限制")); }
        allowed(store, &settings.generation.model, None, ImageOperation::Generate)?;
        if let Some(edit) = &settings.editing { allowed(store, &edit.model, None, ImageOperation::Edit)?; }
    }
    crate::server::config::try_update_raw_field(KEY, |stored| { *stored=json!(config); Ok(()) }, || GatewayError::new("图片工具设置保存失败"))?;
    Ok(view(store))
}
