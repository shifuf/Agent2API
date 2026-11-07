//! 模型转发候选。只允许开启的默认绑定或别名进入全局账号队列。
//! provider 顺序仅用于稳定展示，实际尝试顺序仍由账号优先级决定。

use crate::server::core::providers::catalog::forwarding_providers;

pub fn route_for_forward(model: &str) -> Vec<String> {
    // 默认模型已在入口从手动目录选择。空值、未知名与已删除模型没有候选。
    let providers: Vec<_> = forwarding_providers(model).into_iter()
        .filter(|provider| !super::images::provider_model_is_image(provider, model))
        .collect();
    if !providers.is_empty() {
        return crate::server::core::routing_scope::providers_for(model, &providers);
    }
    Vec::new()
}
