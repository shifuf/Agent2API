//! 可选 Images 扩展的过线形态；与插件 SDK 的 images 模块保持一致。

use serde::Deserialize;
use serde_json::Value;

pub const CAPABILITIES_METHOD: &str = "images.capabilities";
pub const GENERATE_METHOD: &str = "images.generate";
pub const EDIT_METHOD: &str = "images.edit";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageOperation {
    Generate,
    Edit,
}

impl ImageOperation {
    pub fn method(self) -> &'static str {
        match self {
            Self::Generate => GENERATE_METHOD,
            Self::Edit => EDIT_METHOD,
        }
    }

    pub fn tool(self) -> &'static str {
        match self {
            Self::Generate => "generate_images",
            Self::Edit => "edit_images",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Generate => "图片生成",
            Self::Edit => "图片编辑",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Generate => "/v1/images/generations",
            Self::Edit => "/v1/images/edits",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageResponseKind {
    Openai,
    Gemini,
    ModelscopeAsync,
    /// WorkBuddy：`{code, msg, data:{data:[…], usage:{credit}}}` 一层信封。
    Workbuddy,
    /// 豆包工作：出图是对话流里的一次 agent 任务（SSE 的 `gen_image_block`），
    /// 带水印的预览与**无水印原图**都在流里（后者在 `rich_media_layout_block`），
    /// 流里没给才去调官方去水印接口。见 `core/upstream/images.rs` 的 `doubao_body`。
    Doubao,
}

#[derive(Deserialize)]
pub struct ImageRequestPlan {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub response: ImageResponseKind,
}

pub fn model_is_image(model: &Value) -> bool {
    model
        .get("kind")
        .or_else(|| model.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("image"))
        || model
            .get("output_modalities")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("image")))
}

pub fn provider_model_is_image(provider: &str, requested: &str) -> bool {
    let wire = super::catalog::wire_target_for_provider(requested, provider, None);
    wire_model_is_image(provider, &wire.model)
}

pub fn source_provider_model_is_image(provider: &str, requested: &str) -> bool {
    let wire = super::catalog::source_wire_target_for_provider(requested, provider);
    wire_model_is_image(provider, &wire.model)
}

fn wire_model_is_image(provider: &str, model: &str) -> bool {
    super::catalog::manifest_for_provider(provider)
        .iter()
        .find(|item| super::super::models::model_id(item).eq_ignore_ascii_case(model))
        .is_some_and(model_is_image)
}

pub fn operation_providers(model: &str, operation: ImageOperation) -> Vec<String> {
    super::catalog::forwarding_providers(model)
        .into_iter()
        .filter(|provider| {
            super::adapter::adapter_by_id(provider).is_some_and(|adapter| match operation {
                ImageOperation::Generate => adapter.supports_image_generation(),
                ImageOperation::Edit => adapter.supports_image_editing(),
            })
        })
        .filter(|provider| {
            let wire = super::catalog::wire_target_for_provider(model, provider, None);
            super::catalog::manifest_for_provider(provider).iter()
                .find(|item| super::super::models::model_id(item).eq_ignore_ascii_case(&wire.model))
                .is_some_and(|item| match operation {
                    ImageOperation::Generate => model_is_image(item) && item.get("supports_image_generation").and_then(Value::as_bool) != Some(false),
                    ImageOperation::Edit => provider_model_supports_editing(provider, item),
                })
        })
        .collect()
}

pub fn provider_model_supports_generation(provider: &str, model: &Value) -> bool {
    model_is_image(model) && model.get("supports_image_generation").and_then(Value::as_bool) != Some(false)
        && super::adapter::adapter_by_id(provider).is_some_and(|adapter| adapter.supports_image_generation())
}

pub fn provider_model_supports_editing(provider: &str, model: &Value) -> bool {
    model_is_image(model)
        && super::adapter::adapter_by_id(provider)
            .is_some_and(|adapter| adapter.supports_image_editing())
        && model.get("supports_image_editing").and_then(Value::as_bool) != Some(false)
}

/// Group candidates carry an already selected raw model. Do not resolve the
/// public alias again: another member may use a different model on this provider.
pub fn candidate_supports_operation(account: &Value, operation: ImageOperation) -> bool {
    let provider = super::super::routing::provider_of(account);
    super::super::routing_groups::candidate_model(account)
        .and_then(|model| super::super::routing_groups::catalog_model(provider, model))
        .is_some_and(|item| match operation {
            ImageOperation::Generate => provider_model_supports_generation(provider, &item),
            ImageOperation::Edit => provider_model_supports_editing(provider, &item),
        })
}

pub fn operation_available(store: &super::super::account_store::AccountStore, model: &str,
    scope: Option<&super::super::key_scope::KeyScope>, operation: ImageOperation) -> bool {
    let profiles = super::super::routing_discovery::snapshot(store);
    if let Some(group) = profiles.group_for_model(model) {
        if !group.kind.is_image() { return false; }
        let accounts: Vec<_> = store.routing_snapshot().accounts.iter().map(|account| account.as_ref().clone()).collect();
        return super::super::routing_groups::project_with_groups(group, &profiles.groups, &accounts, &Default::default(), scope)
            .accounts.iter().any(|account| candidate_supports_operation(account, operation));
    }
    operation_providers(model, operation).iter().any(|provider| super::super::key_scope::allows_provider(scope, provider))
}
