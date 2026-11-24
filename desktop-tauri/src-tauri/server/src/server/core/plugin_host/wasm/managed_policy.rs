//! 托管登录的静态权限；浏览器来源与 API 出站来源独立审批。
//! CatPaw Passport 与 Trae PKCE 各用固定配置，不能互借来源或输入方式。
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Declaration {
    pub methods: Vec<u64>,
    pub loopback_profiles: Vec<String>,
    pub authorization_origins: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallbackKind { CatpawPassport, TraeCode }

pub(crate) const TRAE_PROFILE: &str = "trae.pkce.v1";
pub(crate) const TRAE_AUTHORIZATION_ORIGIN: &str = "https://www.trae.cn";


pub(crate) const CATPAW_PROFILE: &str = "catpaw.passport.v1";
pub(crate) const CATPAW_ORIGIN: &str = "https://catpaw.meituan.com";
pub(crate) const CATPAW_LOGIN_ENTRY: &str = "https://catpaw.meituan.com/api/gateway/passport/login-entry";

#[derive(Clone, Copy)]
pub(crate) struct Profile {
    pub id: &'static str,
    pub host: &'static str,
    pub path: &'static str,
    pub ports: &'static [u16],
    pub origins: &'static [&'static str],
    pub callback: CallbackKind,
}

fn approved(provider: &str, method: u64, id: &str) -> Option<Profile> {
    match (provider, method, id) {
        // 本仓 CatPaw 原生 login.rs/callback_server.rs 的客户端实证；只批准 Passport。
        // 0 仅表示绑定时向操作系统申请端口，返回 URL 必须使用实际 local_addr().port()。
        ("catpaw", 0, CATPAW_PROFILE) => Some(Profile {
            id: CATPAW_PROFILE, host: "127.0.0.1", path: "/catpaw/callback", ports: &[0],
            origins: &[CATPAW_ORIGIN], callback: CallbackKind::CatpawPassport,
        }),
        // 本仓原生Trae oauth/device/callback_server：无state、IPv4随机端口、固定/authorize。
        // 这里只批准本次准备和回调归属；兑换/身份/保存仍由后续独立门关闭。
        ("trae", 0, TRAE_PROFILE) => Some(Profile {
            id: TRAE_PROFILE, host: "127.0.0.1", path: "/authorize", ports: &[0],
            origins: &[TRAE_AUTHORIZATION_ORIGIN], callback: CallbackKind::TraeCode,
        }),
        _ => None,
    }
}

impl Declaration {
    pub(crate) fn validate(&self, provider: &str) -> Result<(), String> {
        if self.methods.is_empty() || self.methods.len() > 16
            || self.methods.iter().any(|index| *index > 9_007_199_254_740_991)
            || self.methods.iter().collect::<std::collections::HashSet<_>>().len() != self.methods.len()
            || self.loopback_profiles.is_empty() || self.loopback_profiles.len() > 8
            || self.authorization_origins.len() > 8
            || self.methods.iter().any(|method| !self.loopback_profiles.iter().any(|id| approved(provider, *method, id).is_some()))
        { return Err("托管登录权限声明无效".into()); }
        let mut approved_origins = std::collections::HashSet::new();
        let mut profiles = std::collections::HashSet::new();
        for id in &self.loopback_profiles {
            if !profiles.insert(id) { return Err("托管登录回调配置重复".into()); }
            let profile = self.methods.iter().find_map(|index| approved(provider, *index, id))
                .ok_or_else(|| "托管登录回调配置尚未获主程序批准".to_string())?;
            approved_origins.extend(profile.origins.iter().copied());
        }
        let mut origins = std::collections::HashSet::new();
        for origin in &self.authorization_origins {
            let parsed = url::Url::parse(origin).map_err(|_| "托管授权页来源格式无效")?;
            if parsed.scheme() != "https" || parsed.port_or_known_default() != Some(443)
                || parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some()
                || !parsed.username().is_empty() || parsed.password().is_some()
                || parsed.origin().ascii_serialization() != *origin
                || !approved_origins.contains(origin.as_str()) || !origins.insert(origin)
            { return Err("托管授权页必须使用主程序批准的精确 HTTPS 来源".into()); }
        }
        Ok(())
    }

    pub(crate) fn profile(&self, provider: &str, method: u64, id: &str) -> Option<Profile> {
        if !self.methods.contains(&method) || !self.loopback_profiles.iter().any(|item| item == id) { return None; }
        let profile = approved(provider, method, id)?;
        let required = profile.origins;
        required.iter().all(|origin| self.authorization_origins.iter().any(|item| item.as_str() == *origin))
            .then_some(profile)
    }

    pub(crate) fn origins(&self, provider: &str, method: u64) -> Vec<String> {
        let mut origins: Vec<String> = Vec::new();
        for id in &self.loopback_profiles {
            if let Some(profile) = self.profile(provider, method, id) {
                for origin in profile.origins {
                    if self.authorization_origins.iter().any(|item| item.as_str() == *origin)
                        && !origins.iter().any(|item| item.as_str() == *origin) { origins.push((*origin).to_string()); }
                }
            }
        }
        origins
    }
}
