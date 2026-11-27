//! 同协议发送只在原生体上修改路由参数，不复用有损的 Chat 历史。

use serde_json::Value;

use crate::server::core::prompt::PromptMode;
use crate::server::core::protocol::native::{NativeRequest, WireProtocol};
use crate::server::errors::GatewayError;

use super::payload::ProviderContext;

pub(super) fn filter_candidates(
    ctx: &ProviderContext<'_>,
    mut candidates: Vec<String>,
) -> Result<Vec<String>, GatewayError> {
    let Some(native) = ctx.native.filter(|native| native.requires_native()) else {
        return Ok(candidates);
    };
    let requested = ctx
        .direct_model
        .as_deref()
        .unwrap_or_else(|| ctx.body["model"].as_str().unwrap_or(""));
    candidates.retain(|provider| matches_protocol(provider, requested, native.protocol));
    if candidates.is_empty() {
        return Err(GatewayError::bad_request(format!(
            "当前请求需要原生 {} 上游，但当前权限和路由范围内没有对应出口：{}",
            native.protocol.as_str(),
            native.translation_error.as_deref().unwrap_or("无法转换"),
        ))
        .with_code("native_protocol_required"));
    }
    Ok(candidates)
}

pub(super) fn eligible(
    ctx: &ProviderContext<'_>,
    provider: &str,
    account: Option<&Value>,
) -> Result<bool, GatewayError> {
    let Some(native) = ctx.native else {
        return Ok(false);
    };
    let requested = ctx
        .direct_model
        .as_deref()
        .or_else(|| account.and_then(crate::server::core::routing_groups::candidate_model))
        .or_else(|| ctx.body.get("model").and_then(Value::as_str))
        .unwrap_or("");
    let same = matches_protocol(provider, requested, native.protocol);
    if native.requires_native() && !same {
        return Err(GatewayError::bad_request(format!(
            "当前请求包含只能由原生 {} 接口处理的字段，不能转发到其他协议：{}",
            native.protocol.as_str(),
            native.translation_error.as_deref().unwrap_or("无法转换"),
        ))
        .with_code("native_protocol_required"));
    }
    Ok(same)
}

fn matches_protocol(provider: &str, requested: &str, protocol: WireProtocol) -> bool {
    crate::server::core::custom_providers::effective_protocol_for(provider, Some(requested))
        .as_deref()
        .and_then(WireProtocol::from_provider)
        == Some(protocol)
        || crate::server::core::providers::subscriptions::native_protocol(provider) == Some(protocol)
        || crate::server::core::plugin_host::script::native::protocol(provider, requested) == Some(protocol)
        || crate::server::core::plugin_host::script::native::has_protocol(provider, protocol)
}

pub(super) fn prepare(
    ctx: &ProviderContext<'_>,
    native: &NativeRequest,
    provider: &str,
    account: Option<&Value>,
    degraded: bool,
) -> Result<super::payload::SendBody<'static>, GatewayError> {
    let mut body = native.routed(ctx.body);
    if ctx.compact_routed || ctx.title_routed {
        crate::server::core::compact_routing::parameters::clear_source_reasoning(&mut body);
    }
    let preserve_content = native.protocol == WireProtocol::Anthropic;
    if preserve_content || native.requires_native() {
        // 第一轮的内容同样会被后续签名绑定，不能等出现签名才停止改写。
        if !ctx.preserve_system_prompt
            && ctx.prompt.for_provider(provider).mode != PromptMode::Passthrough
            || ctx.sanitize.applies_to(provider)
            || ctx.image_compress.enabled
            || degraded
        {
            ctx.telemetry.note_attempt_notice(if preserve_content {
                "原生 Anthropic 转发保留提示词、消息与图片，跳过内容改写以保持思考签名连续性"
            } else {
                "原生服务端状态请求保留内容，不对已有会话进行内容改写"
            });
        }
    } else {
        let prompt = ctx.prompt.for_provider(provider);
        if !ctx.preserve_system_prompt {
            apply_prompt(
                &mut body,
                native.protocol,
                prompt.mode,
                prompt.text_for(degraded),
                degraded,
            );
        }
        if ctx.sanitize.applies_to(provider) {
            if let Some((next, hits)) = crate::server::core::sanitize::sanitize_native_body(
                &body,
                native.protocol,
                &ctx.sanitize.rules,
            ) {
                body = next;
                ctx.telemetry.note_sensitive_hits(&hits);
            }
        }
        if ctx.image_compress.enabled {
            let stats = crate::server::core::blocking::in_place(|| {
                super::image_compress::compress_native_images(
                    &mut body,
                    native.protocol,
                    &ctx.image_compress,
                )
            });
            if stats.changed() {
                crate::server::logging::verbose(
                    "[Upstream]",
                    &format!(
                        "原生会话图片压缩：{} 张 provider={provider} {}KB -> {}KB",
                        stats.compressed,
                        stats.bytes_before / 1024,
                        stats.bytes_after / 1024,
                    ),
                );
            }
        }
    }
    if ctx.privacy.applies_to(provider) {
        match crate::server::core::privacy::mask_native_body(
            &body,
            native.protocol,
            &ctx.privacy,
            ctx.telemetry.privacy_vault(),
        ) {
            crate::server::core::privacy::PrivacyBodyOutcome::Unchanged => {}
            crate::server::core::privacy::PrivacyBodyOutcome::Warned { hits } => {
                ctx.telemetry.note_privacy_hits(&hits);
            }
            crate::server::core::privacy::PrivacyBodyOutcome::Masked { body: masked, hits } => {
                ctx.telemetry.note_privacy_hits(&hits);
                if ctx.privacy.settings.reversible {
                    ctx.telemetry.mark_privacy_reversible();
                }
                body = masked;
            }
            crate::server::core::privacy::PrivacyBodyOutcome::Blocked { message, hits } => {
                ctx.telemetry.note_privacy_hits(&hits);
                return Err(GatewayError::bad_request(message).with_code("privacy_blocked"));
            }
        }
    }
    let requested = ctx.body.get("model").and_then(Value::as_str).unwrap_or("");
    let wire_model = ctx
        .direct_model
        .clone()
        .or_else(|| {
            account
                .and_then(crate::server::core::routing_groups::candidate_model)
                .map(str::to_string)
        })
        .unwrap_or_else(|| requested.to_string());
    if !wire_model.is_empty() {
        body["model"] = wire_model.clone().into();
    }
    let route_effort = account.and_then(|account| super::payload::selected_effort(account, ctx.body));
    if let Some(level) = &route_effort {
        if crate::server::core::model_rules::reasoning_is_off(level) {
            crate::server::core::model_rules::clear_reasoning_controls(&mut body);
            if let Some(output) = body.get_mut("output_config").and_then(Value::as_object_mut) {
                output.remove("effort");
            }
        } else {
            match native.protocol {
                WireProtocol::Anthropic => crate::server::core::protocol::anthropic_thinking::set_effort(&mut body, &wire_model, level),
                WireProtocol::Responses => {
                    if !body.get("reasoning").is_some_and(Value::is_object) { body["reasoning"] = serde_json::json!({}); }
                    body["reasoning"]["effort"] = level.clone().into();
                }
                WireProtocol::Chat => body["reasoning_effort"] = level.clone().into(),
            }
        }
    }
    if account.and_then(|account| account.get("routingFast")).and_then(Value::as_bool) == Some(true) {
        body["service_tier"] = "priority".into();
    }
    if ctx.compact_routed {
        let actual_model = if ctx.routing.group.is_some() || ctx.direct_model.is_some() {
            wire_model.clone()
        } else {
            crate::server::core::providers::custom::forward::cooldown_model(provider, &wire_model)
        };
        let limit = crate::server::core::routing_groups::catalog_model(provider, &actual_model)
            .and_then(|item| item.get("maxOutputTokens").and_then(Value::as_u64))
            .filter(|limit| *limit > 0);
        if let Some(limit) = limit {
            for key in ["max_tokens", "max_output_tokens"] {
                if body
                    .get(key)
                    .and_then(Value::as_u64)
                    .is_some_and(|value| value > limit)
                {
                    body[key] = limit.into();
                }
            }
        }
    }
    Ok(super::payload::SendBody {
        body: std::borrow::Cow::Owned(body),
        wire_model,
        wire_reasoning: route_effort,
    })
}

fn apply_prompt(
    body: &mut Value,
    protocol: WireProtocol,
    mode: PromptMode,
    text: &str,
    degraded: bool,
) {
    if text.is_empty() || mode == PromptMode::Passthrough && !degraded {
        return;
    }
    let append = mode == PromptMode::Append && !degraded;
    let key = match protocol {
        WireProtocol::Anthropic => "system",
        WireProtocol::Responses => "instructions",
        WireProtocol::Chat => return,
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if append {
        match object.get_mut(key) {
            Some(Value::String(current)) if !current.is_empty() => {
                current.push_str("\n\n");
                current.push_str(text);
            }
            Some(Value::Array(parts)) if protocol == WireProtocol::Anthropic => {
                parts.push(serde_json::json!({ "type": "text", "text": text }));
            }
            _ => {
                object.insert(key.to_string(), text.into());
            }
        }
    } else {
        object.insert(key.to_string(), text.into());
        if protocol == WireProtocol::Responses {
            if let Some(input) = object.get_mut("input").and_then(Value::as_array_mut) {
                input.retain(|item| {
                    !matches!(
                        item.get("role").and_then(Value::as_str),
                        Some("system" | "developer")
                    )
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use serde_json::json;
    use crate::server::core::prompt::{PromptChoice, PromptPlan, PromptSource};

    fn with_context(native: &NativeRequest, body: &Value, run: impl FnOnce(&mut ProviderContext<'_>)) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::server::core::account_store::AccountStore::with_db(Some(
            crate::server::db::Db::open(&dir.path().join("native-fixture.db")).unwrap()));
        let routing = super::super::route_context::RequestRouting::capture_request(
            body["model"].as_str().unwrap_or(""), &store, body, None, false, None).unwrap();
        let headers = axum::http::HeaderMap::new();
        let telemetry = Arc::new(super::super::usage::RequestTelemetry::new());
        let sanitize = crate::server::config::SanitizeSettings::default();
        let provider_prompts = Default::default();
        let prompt = PromptPlan::new(PromptChoice { mode: PromptMode::Passthrough,
            text: "", source: PromptSource::None }, &provider_prompts, &[], false);
        let mut ctx = ProviderContext { body, native: Some(native), routing, error_policy: Default::default(),
            vision: None, direct_provider: None, direct_model: None, compact_routed: false, title_routed: false,
            stream: false, images: None, client_headers: &headers, telemetry: &telemetry, sanitize: &sanitize,
            privacy: Default::default(), developer_role_compat: true, image_compress: Default::default(), prompt,
            preserve_system_prompt: false, key_scope: None, pinned_account: None, ignore_model_gate: false,
            proxy_override: None };
        run(&mut ctx);
    }

    #[test]
    fn native_subscription_state_is_eligible_and_preserves_image_and_opaque_fields() {
        crate::test_support::isolated(concat!(module_path!(), "::native_subscription_state_is_eligible_and_preserves_image_and_opaque_fields"), || {
            crate::server::config::init(None);
            let input = json!({"model":"public-alias","previous_response_id":"resp_previous_fixture",
                "instructions":"unchanged native instructions","future_native":{"opaque":"signature"},
                "input":[{"role":"user","content":[{"type":"input_text","text":"Describe"},
                    {"type":"input_image","image_url":"https://example.invalid/synthetic.png","detail":"high"}]}]});
            let (native, projection) = NativeRequest::prepare(WireProtocol::Responses, input.clone()).unwrap();
            assert!(native.requires_native());
            for provider in ["codex-subscription", "chatgpt-subscription"] {
                with_context(&native, &projection, |ctx| {
                    let retained = filter_candidates(ctx, vec![provider.into(), "claude-subscription".into(), "unknown-fixture".into()]).unwrap();
                    assert_eq!(retained, vec![provider]);
                    let account = json!({"routingModel":"selected-wire"});
                    assert!(eligible(ctx, provider, Some(&account)).unwrap(),
                        "a retained native subscription must also pass the vision preflight");
                    let prepared = prepare(ctx, &native, provider, Some(&account), false).unwrap();
                    assert_eq!(prepared.body["model"], "selected-wire");
                    assert_eq!(prepared.body["previous_response_id"], "resp_previous_fixture");
                    assert_eq!(prepared.body["input"], input["input"]);
                    assert_eq!(prepared.body["instructions"], input["instructions"]);
                    assert_eq!(prepared.body["future_native"], input["future_native"]);
                });
            }
        });
    }

    #[test]
    fn subscription_native_protocols_do_not_admit_unsupported_or_mismatched_requests() {
        crate::test_support::isolated(concat!(module_path!(), "::subscription_native_protocols_do_not_admit_unsupported_or_mismatched_requests"), || {
            crate::server::config::init(None);
            let body = json!({"model":"synthetic-model","messages":[]});
            for (provider, protocol, want) in [
                ("codex-subscription", WireProtocol::Responses, true),
                ("chatgpt-subscription", WireProtocol::Responses, true),
                ("claude-subscription", WireProtocol::Responses, false),
                ("codex-subscription", WireProtocol::Anthropic, false),
                ("chatgpt-subscription", WireProtocol::Anthropic, false),
                ("claude-subscription", WireProtocol::Anthropic, false),
                ("codex-subscription", WireProtocol::Chat, false),
                ("chatgpt-subscription", WireProtocol::Chat, false),
                ("claude-subscription", WireProtocol::Chat, false),
                ("unknown-fixture", WireProtocol::Responses, false),
            ] {
                let native = NativeRequest { protocol, body: Arc::new(body.clone()), translation_error: None };
                with_context(&native, &body, |ctx| assert_eq!(eligible(ctx, provider, None).unwrap(), want, "provider={provider} protocol={protocol:?}"));
                let required = NativeRequest { translation_error: Some("synthetic native-only state".into()), ..native };
                with_context(&required, &body, |ctx| {
                    let filtered = filter_candidates(ctx, vec![provider.into()]);
                    let selected = eligible(ctx, provider, None);
                    if want {
                        assert_eq!(filtered.unwrap(), vec![provider]); assert!(selected.unwrap());
                    } else {
                        for error in [filtered.unwrap_err(), selected.unwrap_err()] {
                            assert_eq!(error.status_code, 400);
                            assert_eq!(error.code.as_deref(), Some("native_protocol_required"));
                        }
                    }
                });
            }
        });
    }

    #[test]
    fn native_eligibility_keeps_direct_account_and_requested_model_protocol_precedence() {
        crate::test_support::isolated(concat!(module_path!(), "::native_eligibility_keeps_direct_account_and_requested_model_protocol_precedence"), || {
            crate::server::config::init(None);
            crate::server::config::update_raw_field(crate::server::core::custom_providers::KEY_CUSTOM_PROVIDERS, json!([{
                "id":"custom-native-precedence-fixture","name":"synthetic","protocol":"chat_completions",
                "baseUrl":"http://127.0.0.1:1/v1","enabled":true,
                "models":[{"id":"wire-responses","protocol":"responses","enabled":true},
                    {"id":"wire-chat","protocol":"chat_completions","enabled":true}],
                "mappings":[{"alias":"public-responses","target":"wire-responses","enabled":true}]
            }]));
            let body = json!({"model":"public-responses","input":[]});
            let native = NativeRequest { protocol: WireProtocol::Responses, body: Arc::new(body.clone()), translation_error: None };
            with_context(&native, &body, |ctx| {
                let provider = "custom-native-precedence-fixture";
                assert!(eligible(ctx, provider, None).unwrap(), "body aliases must resolve their target protocol");
                assert_eq!(filter_candidates(ctx, vec![provider.into()]).unwrap(), vec![provider]);
                let chat_account = json!({"routingModel":"wire-chat"});
                let responses_account = json!({"routingModel":"wire-responses"});
                assert!(!eligible(ctx, provider, Some(&chat_account)).unwrap(), "selected account model overrides body alias");
                ctx.direct_model = Some("wire-responses".into());
                assert!(eligible(ctx, provider, Some(&chat_account)).unwrap(), "direct model overrides selected account");
                ctx.direct_model = Some("wire-chat".into());
                assert!(!eligible(ctx, provider, Some(&responses_account)).unwrap(), "direct model must not be ignored");
            });
            let required = NativeRequest { translation_error: Some("synthetic native-only state".into()), ..native };
            with_context(&required, &body, |ctx| {
                let provider = "custom-native-precedence-fixture";
                assert_eq!(eligible(ctx, provider, Some(&json!({"routingModel":"wire-chat"}))).unwrap_err().code.as_deref(), Some("native_protocol_required"));
                assert!(eligible(ctx, provider, Some(&json!({"routingModel":"wire-responses"}))).unwrap());
            });
        });
    }
}
