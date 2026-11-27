use serde_json::json;

use crate::server::config::error_policy::ErrorKind;
use crate::server::core::account_store::AccountStore;
use crate::server::errors::GatewayError;
use crate::server::logging;

pub(super) fn persist_account_action(
    store: &AccountStore,
    account_id: &str,
    suspend: bool,
    cooldown_until: Option<i64>,
    reason: &str,
) {
    if account_id.is_empty() {
        return;
    }
    if suspend {
        if let Err(err) = crate::server::core::blocking::in_place(|| store.suspend_upstream_account(account_id, reason)) {
            logging::log_with_level("[Upstream]", &format!("标记上游账号挂起失败 ({account_id}): {err}"), "warn");
        }
    }
    if let Some(until) = cooldown_until {
        if let Err(err) = crate::server::core::blocking::in_place(|| store.cooldown_upstream_account(account_id, until, reason)) {
            logging::log_with_level("[Upstream]", &format!("记录上游账号冷却失败 ({account_id}): {err}"), "warn");
        }
    }
}

use super::{error_policy, rotate, RouteTarget, UpstreamService};
use super::payload::ProviderContext;

#[derive(Clone, Copy)]
pub(super) struct StickyContext<'a> {
    pub key: &'a str,
    pub model: &'a str,
    pub generation: u64,
}

/// 候选失败后立即解除会话粘性绑定（固定指定账号测试时不改动正常会话粘性）。
pub(super) fn forget_sticky(
    service: &UpstreamService,
    ctx: &ProviderContext<'_>,
    sticky: StickyContext<'_>,
    candidate: Option<&str>,
) {
    if ctx.pinned_account.is_some() || ctx.routing.group.is_some() {
        return;
    }
    if let Some(candidate) = candidate.filter(|value| !value.is_empty()) {
        service.route.sticky_forget(sticky.key, sticky.model, candidate, sticky.generation);
    }
}

/// An implicit default must not turn invalid input into a cross-group account
/// penalty. Explicitly saved policies, overrides and plugin rules retain their
/// configured behavior; channel-health accounting remains in the sticky loop.
fn protect_default_sticky_bad_request(
    snapshot: &crate::server::config::error_policy::ErrorPolicySnapshot,
    sticky_faults: bool,
    decision: &mut error_policy::ErrorDecision,
) -> bool {
    use crate::server::config::error_policy::{CooldownMode, ErrorAction, RuleSource};
    if !sticky_faults || snapshot.configured || decision.rule_source != RuleSource::Global
        || decision.kind != ErrorKind::BadRequest { return false; }
    decision.action = ErrorAction::ReturnError;
    decision.rule.action = ErrorAction::ReturnError;
    decision.rule.cooldown = CooldownMode::None;
    true
}

pub(super) fn finish_failure(service: &UpstreamService, ctx: &ProviderContext<'_>, providers: &[&str], keys: &rotate::CooldownKeys<'_>,
    target: &RouteTarget, error: &mut GatewayError, tried: &mut Vec<String>, switches_left: &mut usize, switch_total: usize,
    sticky: StickyContext<'_>) -> bool {
    forget_sticky(service, ctx, sticky, target.attempt_key().as_deref());
    let model = error.routing_error.as_ref().map(|decision| decision.model.clone()).unwrap_or_else(|| {
        target.account.as_ref().map(|account| keys.for_account(account)).unwrap_or_else(|| keys.for_provider(&target.provider))
    });
    let settings = &ctx.error_policy.settings;
    let mut decision = error.routing_error.clone().unwrap_or_else(|| error_policy::for_error_with(&ctx.error_policy, &target.provider, &model, error, false));
    let protected_invalid = protect_default_sticky_bad_request(&ctx.error_policy, ctx.routing.sticky_faults(), &mut decision);
    error_policy::attach(error, &decision);
    let replay_or_started = ctx.telemetry.replay_guard().blocked() || ctx.telemetry.response_started();
    let blocked_reason = if ctx.telemetry.response_started() {
        Some("响应已开始，未重放；只记录原账号的恢复时间")
    } else if ctx.telemetry.replay_guard().blocked() {
        Some("已进入不可重放状态，只记录账号状态，不重发不换号")
    } else if protected_invalid {
        Some("粘滞渠道请求参数错误：隐式默认策略返回原错误，不降权、不冷却、不计渠道失败")
    } else {
        None
    };
    error_policy::note(ctx.telemetry, &decision, blocked_reason);
    if decision.hard_stop || ctx.telemetry.is_cancelled() { return false; }
    if let Some(account) = target.account_id.as_deref() {
        if decision.deprioritizes() {
            let until = service.route.deprioritize_mark_scoped(account, &target.provider, &model, decision.scope, &decision.rule, logging::now_ms());
            if until > logging::now_ms() {
                error.retry_after_secs.get_or_insert(until.saturating_sub(logging::now_ms()).max(0) as u64 / 1000 + 1);
            }
            ctx.telemetry.note_error_policy(json!({ "resetAt": until, "timeSource": "sink" }));
        } else if let Some(entry) = error_policy::remember_cooldown(service, settings, account, &model, error, &decision) {
            let reset = entry["resetAt"].as_i64().unwrap_or(0);
            if reset > logging::now_ms() { error.retry_after_secs = Some(reset.saturating_sub(logging::now_ms()).max(0) as u64 / 1000 + 1); }
            ctx.telemetry.note_error_policy(json!({ "resetAt": entry["resetAt"], "timeSource": entry["timeSource"] }));
        }
        if !decision.deprioritizes() && matches!(decision.kind, ErrorKind::RateLimit | ErrorKind::Quota) && settings.sink && ctx.pinned_account.is_none() {
            service.route.sink_mark_for(account, logging::now_ms(), settings.sink_seconds);
        }
        if decision.kind == ErrorKind::Transient && decision.rule.cooldown == crate::server::config::error_policy::CooldownMode::Protection {
            if settings.backoff { service.route.backoff_mark_for(account, logging::now_ms(), settings.backoff_seconds, settings.backoff_cap_seconds); }
            if settings.breaker {
                service.route.breaker_failure(account, settings.breaker_failures as i64, settings.breaker_seconds as i64, logging::now_ms());
            }
        }
        if !replay_or_started && decision.kind == ErrorKind::Auth && target.account.as_ref().is_some_and(|account| account["needsRelogin"] == true) {
            ctx.telemetry.note_error_policy(json!({ "reason": "该账号需要重新登录" }));
        }
    }
    if replay_or_started { return false; }
    if !decision.switches() { return false; }
    if decision.scope == crate::server::config::error_policy::CooldownScope::Account {
        if let Some(id) = target.account_id.as_deref() {
            for candidate in rotate::scoped_accounts(service, providers, keys.request_model(), ctx.pinned_account, Some(&ctx.routing), None) {
                if crate::server::core::routing::account_id(&candidate) == Some(id) {
                    let key = crate::server::core::routing_groups::attempt_key(&candidate);
                    if !tried.contains(&key) { tried.push(key); }
                }
            }
        }
    }
    if let Some(account) = target.account_id.as_deref() {
        if !rotate::allows_route_skip(service, account) {
            ctx.telemetry.note_error_policy(json!({ "reason": "当前账号已关闭失败换号" })); return false;
        }
    }
    if ctx.pinned_account.is_some() || ctx.routing.requires_account() {
        ctx.telemetry.note_error_policy(json!({ "reason": "本次请求明确指定账号，未更换指定对象" })); return false;
    }
    if decision.skips_provider() {
        error_policy::exclude_provider(service, providers, keys.request_model(), &target.provider, tried, ctx.pinned_account, &ctx.routing);
    }
    if let Some(id) = target.attempt_key() { tried.retain(|other| other != &id); tried.push(id); }
    let Some(next) = rotate::pick_next_account(service, providers, keys, tried, ctx.pinned_account, &ctx.routing) else {
        ctx.telemetry.note_error_policy(json!({ "reason": "当前路由没有其他可用对象" })); return false;
    };
    if !super::provider_loop::take_switch(switches_left, switch_total) {
        ctx.telemetry.note_error_policy(json!({ "reason": "换账号次数已用尽，未继续发送" })); return false;
    }
    logging::console_line("[Upstream]", &format!("统一错误规则「{}」：HTTP {}，顺延到 {}（换号 {}/{}）",
        decision.rule.name, error.status_code, super::account_display(&next), switch_total - *switches_left, switch_total));
    true
}

#[cfg(test)]
mod sticky_default_tests {
    use super::*;
    use crate::server::config::error_policy::{
        DeclaredErrorPolicy, ErrorAction, ErrorPolicySnapshot, PluginErrorRule, RuleSource,
    };
    use crate::server::core::providers::adapter::UpstreamErrorClass;

    fn decision(snapshot: &ErrorPolicySnapshot, declared: &DeclaredErrorPolicy, status: u16) -> error_policy::ErrorDecision {
        let class = UpstreamErrorClass::Fatal { status, message: "invalid request field".into(), upstream_code: None };
        error_policy::decide_with_declared(snapshot, declared, "custom-fixture", "wire-fixture",
            &class, status, &json!({"error":{"message":"invalid request field"}}), false, false)
    }

    #[test]
    fn implicit_sticky_bad_request_returns_original_error_without_lowering_priority() {
        for legacy in [false, true] {
            let snapshot = ErrorPolicySnapshot { legacy, ..Default::default() };
            for status in [400, 413, 422] {
                let mut resolved = decision(&snapshot, &DeclaredErrorPolicy::default(), status);
                assert!(protect_default_sticky_bad_request(&snapshot, true, &mut resolved));
                assert!(!resolved.switches(), "invalid input must not switch the sticky channel");
                assert!(!resolved.cooldown());
                assert!(!resolved.deprioritizes(), "invalid input must not reorder other routing groups");
                let mut error = GatewayError::with_status(i32::from(status), "invalid request field");
                error_policy::attach(&mut error, &resolved);
                assert_eq!(error.status_code, i32::from(status));
                assert_eq!(error.message, "invalid request field");
                assert_eq!(error.retry_after_secs, None);
            }
        }
    }

    #[test]
    fn explicit_global_override_and_plugin_bad_request_policies_remain_effective() {
        let explicit = ErrorPolicySnapshot { configured: true, ..Default::default() };
        let implicit = ErrorPolicySnapshot::default();
        let mut overridden = ErrorPolicySnapshot::default();
        let rule = overridden.settings.rules.iter().find(|rule| rule.kind == ErrorKind::BadRequest).unwrap().clone();
        overridden.settings.overrides.push(rule.clone());
        let declared = DeclaredErrorPolicy { rules: vec![PluginErrorRule {
            rule, plugin_rule_id: "fixture-invalid-request".into(), reason: "fixture policy".into(),
        }], ..Default::default() };
        // Explicitly saving even the displayed defaults is a user choice.
        for (snapshot, declared, source) in [
            (&explicit, DeclaredErrorPolicy::default(), RuleSource::Global),
            (&overridden, DeclaredErrorPolicy::default(), RuleSource::Override),
            (&implicit, declared, RuleSource::Plugin),
        ] {
            let mut resolved = decision(snapshot, &declared, 400);
            assert_eq!(resolved.rule_source, source);
            assert!(!protect_default_sticky_bad_request(snapshot, true, &mut resolved));
            assert_eq!(resolved.action, ErrorAction::SwitchProvider);
            assert!(resolved.switches());
            assert!(resolved.deprioritizes());
        }
    }

    #[test]
    fn nonsticky_bad_request_and_sticky_service_failures_keep_their_error_policies() {
        let snapshot = ErrorPolicySnapshot::default();
        let mut invalid = decision(&snapshot, &DeclaredErrorPolicy::default(), 400);
        assert!(!protect_default_sticky_bad_request(&snapshot, false, &mut invalid));
        assert!(invalid.switches());
        assert!(invalid.deprioritizes());
        let mut transient = decision(&snapshot, &DeclaredErrorPolicy::default(), 503);
        assert!(!protect_default_sticky_bad_request(&snapshot, true, &mut transient));
        assert!(transient.retries());
        assert!(transient.cooldown());
    }
}
