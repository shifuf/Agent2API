//! 原始模型 Key 的私有来源；只从真实入站头和原 CONFIG 签发，不能从 guest/会话补权。
//! 最终门锁序为 CONFIG → 密钥来源 → 原调用 → Host → 账号 → Db，门内不解密或读盘。
use std::future::Future;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

use axum::http::HeaderMap;
use sha2::{Digest, Sha256};

use crate::server::core::{api_keys, crypto, key_scope::KeyScope};
use crate::server::errors::GatewayError;

#[derive(Debug, Default)]
pub(super) struct Epoch { revoked: AtomicBool }

impl Epoch {
    pub(super) fn revoke(&self) { self.revoked.store(true, Ordering::Release); }
}

enum Origin { Configured(String), Environment }

/// 无 Deserialize/Serialize/Debug、无自由构造入口；仅可在主程序调用 scope 时传播。
pub(crate) struct Source {
    epoch: Arc<Epoch>,
    key_epoch: crypto::AccountKeySource,
    origin: Origin,
    digest: [u8; 32],
    scope: Option<KeyScope>,
}

tokio::task_local! { static ORIGINAL: Option<Arc<Source>>; }

pub(crate) async fn scope<F: Future>(source: Arc<Source>, work: F) -> F::Output {
    scope_optional(Some(source), work).await
}

pub(crate) async fn scope_optional<F: Future>(source: Option<Arc<Source>>, work: F) -> F::Output {
    ORIGINAL.scope(source, work).await
}

pub(crate) fn current() -> Option<Arc<Source>> { ORIGINAL.try_with(Clone::clone).ok().flatten() }

pub(crate) fn capture(headers: &HeaderMap) -> Result<Arc<Source>, GatewayError> {
    let key = presented(headers).filter(|key| !key.is_empty()).ok_or_else(required)?;
    let snapshot = super::current();
    let key_epoch = crypto::account_key_source().ok_or_else(unavailable)?;
    let (origin, scope) = if super::parse::env_api_key_value().as_deref() == Some(key) {
        (Origin::Environment, None)
    } else {
        let entry = api_keys::entry_for_key_from(snapshot.raw(), key).ok_or_else(invalid)?;
        (Origin::Configured(entry.id.clone()), Some(KeyScope::from_entry(&entry)))
    };
    let source = Arc::new(Source {
        epoch: snapshot.model_key_epoch.clone(), key_epoch, origin,
        digest: Sha256::digest(key.as_bytes()).into(), scope,
    });
    // 解密在 CONFIG/来源门外完成；写入或密钥重置先赢时不能把旧材料签为新来源。
    source.with_current(|| ()).ok_or_else(unavailable)?;
    Ok(source)
}

impl Source {
    pub(crate) fn allows_model(&self, model: &str) -> bool {
        self.scope.as_ref().is_none_or(|scope| scope.allows_model(model))
    }
    pub(crate) fn allows_provider(&self, provider: &str) -> bool {
        self.scope.as_ref().is_none_or(|scope| scope.allows_provider(provider))
    }
    pub(crate) fn matches_headers(&self, headers: &HeaderMap) -> bool {
        presented(headers).is_some_and(|key| <[u8;32]>::from(Sha256::digest(key.as_bytes())) == self.digest)
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.epoch, &other.epoch) && self.key_epoch.same(&other.key_epoch) && self.digest == other.digest
            && match (&self.origin, &other.origin) {
                (Origin::Configured(left), Origin::Configured(right)) => left == right,
                (Origin::Environment, Origin::Environment) => true,
                _ => false,
            }
    }
    pub(crate) fn is_current(&self) -> bool { self.with_current(|| ()).is_some() }

    /// 专用、经审计的最终门；不用 with_raw 的一般读回调，不接受 guest 闭包。
    pub(crate) fn with_current<R>(&self, action: impl FnOnce() -> R) -> Option<R> {
        let config = super::CONFIG.try_read().ok()?;
        let current = config.as_ref()?;
        if self.epoch.revoked.load(Ordering::Acquire) || !Arc::ptr_eq(&self.epoch, &current.model_key_epoch) {
            return None;
        }
        if matches!(self.origin, Origin::Environment)
            && super::parse::env_api_key_value().is_none_or(|key| <[u8;32]>::from(Sha256::digest(key.as_bytes())) != self.digest) {
            return None;
        }
        self.key_epoch.with_current(action)
    }
}

fn presented(headers: &HeaderMap) -> Option<&str> {
    // 与真实模型认证一致：显式 x-api-key 无效时不能用另一枚 Authorization 补权。
    if let Some(value) = headers.get("x-api-key") { value.to_str().ok() }
    else { headers.get(axum::http::header::AUTHORIZATION).and_then(|value| value.to_str().ok())
        .map(crate::server::http::strip_bearer_prefix) }
}

pub(super) fn authorization_changed(previous: &super::RuntimeConfig, next: &super::RuntimeConfig) -> bool {
    [api_keys::KEY_API_KEYS, api_keys::KEY_API_KEY].into_iter()
        .any(|key| previous.raw().get(key) != next.raw().get(key))
}

pub(super) fn install_epoch(current: Option<&super::RuntimeConfig>, next: &mut super::RuntimeConfig, force: bool) {
    if let Some(current) = current {
        if !force && !authorization_changed(current, next) {
            next.model_key_epoch = current.model_key_epoch.clone();
            return;
        }
        current.model_key_epoch.revoke();
    }
    next.model_key_epoch = Arc::new(Epoch::default());
}

fn required() -> GatewayError { GatewayError::with_status(401, "模型调用缺少原始 API Key").with_code("model_api_key_required") }
fn invalid() -> GatewayError { GatewayError::with_status(401, "原始 API Key 已失效、停用或不可用").with_code("invalid_api_key") }
fn unavailable() -> GatewayError { GatewayError::with_status(409, "原始 API Key 来源已变化，请重新发起请求").with_code("model_key_source_revoked") }
