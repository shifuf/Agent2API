use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{Input, Session, State, unavailable};
use crate::server::{core::plugin_host::wasm::manifest::Options, errors::GatewayError};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Captcha {
    engine: &'static str,
    protocol: &'static str,
    config_id: String,
    prefix: String,
    scene_id: String,
    region: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Browser {
    url: String,
    browser_mode: &'static str,
    manual_callback: bool,
    callback_input: &'static str,
}

pub(crate) struct Step {
    pub(super) id: String,
    pub(super) status: &'static str,
    title: String,
    message: String,
    pub(super) captcha: Option<Captcha>,
    pub(super) browser: Option<Browser>,
    pub(super) lease: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publish {
    expected: String,
    title: String,
    message: String,
    #[serde(default)]
    captcha: Option<CaptchaInput>,
    #[serde(default)]
    browser: Option<BrowserInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptchaInput { engine: String, protocol: String, prefix: String, scene_id: String, region: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserInput { url: String, lease_id: String, browser_mode: String, manual_callback: bool, callback_input: String }

impl Step {
    pub(super) fn preparing(id: String) -> Self {
        Self { id, status: "preparing", title: "正在准备登录".into(), message: "正在读取本次登录所需的验证配置。".into(),
            captcha: None, browser: None, lease: None }
    }

    pub(super) fn public(&self, session: &Session) -> Value {
        json!({ "type": "managed", "id": self.id, "provider": session.provider, "flow": session.flow,
            "methodIndex": session.method_index, "status": self.status, "title": self.title, "message": self.message,
            "fields": [], "expiresAt": session.expires_at,
            "remainingMs": session.deadline.saturating_duration_since(tokio::time::Instant::now()).as_millis() as u64,
            "captcha": self.captcha, "browser": self.browser })
    }

    pub(super) fn check(&self, input: &Input) -> Result<(), GatewayError> {
        if input.interaction != self.id || self.status != "ready" {
            return Err(GatewayError::with_status(409, "登录步骤已变化或正在处理，请重新读取"));
        }
        let fields = input.inputs.as_object().ok_or_else(|| GatewayError::bad_request("登录输入必须是字段对象"))?;
        if let Some(captcha) = &self.captcha {
            if !fields.is_empty() || input.captcha.as_object().is_none_or(|fields|
                fields.len() != 3 || fields.keys().any(|key| !["engine", "configId", "param"].contains(&key.as_str())))
                || input.captcha["engine"] != "aliyun" || input.captcha["configId"].as_str() != Some(captcha.config_id.as_str())
                || input.captcha["param"].as_str().is_none_or(|param| param.is_empty() || param.len() > 32 * 1024
                    || param != param.trim() || param.chars().any(char::is_control))
            { return Err(GatewayError::bad_request("请完成当前登录步骤的阿里云验证")); }
        } else if self.browser.as_ref().is_some_and(|browser| browser.manual_callback) {
            if !input.captcha.is_null() || fields.len() != 1 || !fields.contains_key("callbackUrl")
                || fields["callbackUrl"].as_str().is_none_or(|raw| raw.is_empty() || raw.len() > 32 * 1024) {
                return Err(GatewayError::bad_request("当前步骤只接受本次授权的完整回调地址"));
            }
        } else { return Err(GatewayError::bad_request("当前登录步骤不接受输入")); }
        Ok(())
    }
}

pub(super) fn build(params: &Value, session: &Session, state: &mut State, options: &Options) -> Result<Step, GatewayError> {
    let input: Publish = serde_json::from_value(params.clone()).map_err(|_| GatewayError::bad_request("托管登录步骤声明无效"))?;
    if input.expected.is_empty() || input.title.len() > 256 || input.message.len() > 8192
        || input.title.trim().is_empty() || input.title.contains('\0') || input.message.contains('\0')
        || input.captcha.is_some() == input.browser.is_some() {
        return Err(GatewayError::bad_request("托管登录步骤必须声明一种明确交互"));
    }
    let mut step = Step { id: super::nonce()?, status: "ready",
        title: super::super::login_text(&input.title), message: super::super::login_text(&input.message),
        captcha: None, browser: None, lease: None };
    if let Some(captcha) = input.captcha {
        if !options.allows("login.captcha.aliyun.v1") || captcha.engine != "aliyun" || captcha.protocol != "v2"
            || [&captcha.prefix, &captcha.scene_id, &captcha.region].iter().any(|value| value.is_empty()
                || value.len() > 256 || value.chars().any(|ch| ch.is_control() || ch.is_whitespace()))
            || captcha.region.len() > 32 {
            return Err(GatewayError::bad_request("阿里云登录验证必须声明完整真实的 V2 配置"));
        }
        
        if super::trae::applies(&session.provider, session.method_index) {
            return Err(GatewayError::with_status(403, "Trae 固定网页登录只在官方页面完成验证，不使用插件验证码步骤"));
        }
        state.leases.clear();
        step.captcha = Some(Captcha { engine: "aliyun", protocol: "v2", config_id: super::nonce()?,
            prefix: captcha.prefix, scene_id: captcha.scene_id, region: captcha.region });
    }
    if let Some(browser) = input.browser {
        if !options.allows("login.loopback.v1") || browser.browser_mode != "external"
            || browser.callback_input != "url" {
            return Err(GatewayError::bad_request("托管登录浏览器声明无效"));
        }
        let declaration = options.manifest.managed_login.as_ref().ok_or_else(unavailable)?;
        let lease = state.leases.get_mut(&browser.lease_id).ok_or_else(unavailable)?;
        if lease.closed() || lease.step.is_some() || lease.expected != input.expected {
            return Err(unavailable());
        }
        let profile = declaration.profile(&session.provider, session.method_index, lease.profile)
            .ok_or_else(|| GatewayError::with_status(403, "当前回调配置没有授权来源许可"))?;
        let official_state = match profile.callback {

            crate::server::core::plugin_host::wasm::managed_policy::CallbackKind::CatpawPassport => {
                if browser.manual_callback { return Err(GatewayError::bad_request("CatPaw 官方登录只接受托管表单回调或原会话轮询")); }
                Some(super::catpaw::authorization(lease, &browser.url)?)
            }
            crate::server::core::plugin_host::wasm::managed_policy::CallbackKind::TraeCode => {
                if !browser.manual_callback {
                    return Err(GatewayError::bad_request("Trae 授权步骤需要完整回调地址入口"));
                }
                super::trae::publication(&mut state.trae, lease, &browser.lease_id, &browser.url, &step.id)?;
                None
            }
        };
        // CatPaw保留官方state；Trae只认私有listener/PKCE上下文。
        lease.step = Some(step.id.clone());
        lease.official_state = official_state;
        step.lease = Some(browser.lease_id.clone());
        state.leases.retain(|id, _| id == &browser.lease_id);
        step.browser = Some(Browser { url: browser.url, browser_mode: session.browser_mode,
            manual_callback: browser.manual_callback, callback_input: "url" });
    }
    Ok(step)
}
