use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::server::{
    core::crypto::{self, SecretScope},
    db::Db,
};

pub const KEY: &str = "panelTurnstile";
pub const UNAVAILABLE: &str = "登录验证配置不可用，请联系管理员";
const INVALID: &str = "登录验证设置无效";
const VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION: &str = "agent2api_panel";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Altcha,
    Turnstile,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub provider: Provider,
    pub site_key: String,
    #[serde(default)]
    pub widget_origin: String,
    secret: String,
    hostnames: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    settings_enc: String,
}

fn key_valid(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn hostname_valid(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

impl Settings {
    fn widget_host(&self) -> Option<&str> {
        let host = self.widget_origin.strip_prefix("https://")?;
        (hostname_valid(host) && host.contains('.') && host.parse::<std::net::IpAddr>().is_err())
            .then_some(host)
    }
    pub fn admin(&self) -> Value {
        json!({"provider":self.provider,"siteKey":self.site_key,"widgetOrigin":self.widget_origin,"hasSecret":!self.secret.is_empty(),"hostnames":self.hostnames})
    }
    fn validate(&self) -> Result<(), &'static str> {
        if (!self.site_key.is_empty() && !key_valid(&self.site_key))
            || (!self.secret.is_empty() && !key_valid(&self.secret))
            || self.hostnames.len() > 32
            || (!self.widget_origin.is_empty() && self.widget_host().is_none())
            || !self.hostnames.iter().all(|host| hostname_valid(host))
            || (self.provider == Provider::Turnstile
                && (self.site_key.is_empty()
                    || self.secret.is_empty()
                    || !self
                        .widget_host()
                        .is_some_and(|host| self.hostnames.iter().any(|allowed| allowed == host))))
        {
            return Err(INVALID);
        }
        Ok(())
    }
}

fn read(conn: &rusqlite::Connection) -> Result<Settings, &'static str> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| row.get(0))
        .optional()
        .map_err(|_| UNAVAILABLE)?;
    let Some(raw) = raw else {
        return Ok(Settings::default());
    };
    let stored: Stored = serde_json::from_str(&raw).map_err(|_| UNAVAILABLE)?;
    if stored.version != 1 || !crypto::is_envelope(&stored.settings_enc) {
        return Err(UNAVAILABLE);
    }
    let bytes = Zeroizing::new(
        crypto::open(&stored.settings_enc, SecretScope::Accounts).map_err(|_| UNAVAILABLE)?,
    );
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    settings.validate().map_err(|_| UNAVAILABLE)?;
    Ok(settings)
}

pub fn load(db: Option<&Db>) -> Result<Settings, &'static str> {
    db.and_then(|db| db.with(read)).ok_or(UNAVAILABLE)?
}

pub fn save(db: &Db, body: Value) -> Result<Value, (i32, &'static str)> {
    let map = body.as_object().ok_or((400, INVALID))?;
    if map.is_empty()
        || map.keys().any(|name| {
            !matches!(
                name.as_str(),
                "provider" | "siteKey" | "secret" | "hostnames" | "widgetOrigin"
            )
        })
    {
        return Err((400, INVALID));
    }
    db.with_mut(|conn| {
        let tx = conn.transaction().map_err(|_| (503,UNAVAILABLE))?;
        let mut settings = read(&tx).or_else(|_| if map.get("provider").and_then(Value::as_str)==Some("altcha") { Ok(Settings::default()) } else { Err((503,UNAVAILABLE)) })?;
        if let Some(value) = map.get("provider") { settings.provider = serde_json::from_value(value.clone()).map_err(|_| (400,INVALID))?; }
        if let Some(value) = map.get("siteKey") { settings.site_key = value.as_str().ok_or((400,INVALID))?.to_owned(); }
        if let Some(value) = map.get("widgetOrigin") { settings.widget_origin = value.as_str().ok_or((400,INVALID))?.trim().trim_end_matches('/').to_ascii_lowercase(); }
        if let Some(value) = map.get("secret") { settings.secret = value.as_str().ok_or((400,INVALID))?.to_owned(); }
        if let Some(value) = map.get("hostnames") {
            let hosts: Vec<String> = serde_json::from_value(value.clone()).map_err(|_| (400,INVALID))?;
            settings.hostnames = hosts.into_iter().map(|host| host.trim().to_ascii_lowercase()).collect();
            settings.hostnames.sort(); settings.hostnames.dedup();
        }
        settings.validate().map_err(|err| (400,err))?;
        let bytes = Zeroizing::new(serde_json::to_vec(&settings).map_err(|_| (503,UNAVAILABLE))?);
        let settings_enc = crypto::seal(&bytes,SecretScope::Accounts).map_err(|_| (503,UNAVAILABLE))?;
        let raw = serde_json::to_string(&Stored{version:1,settings_enc}).map_err(|_| (503,UNAVAILABLE))?;
        tx.execute("INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY,raw]).map_err(|_| (503,UNAVAILABLE))?;
        tx.commit().map_err(|_| (503,UNAVAILABLE))?;
        Ok(settings.admin())
    }).ok_or((503,UNAVAILABLE))?
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .build()
                .ok()
        })
        .as_ref()
}

async fn verify_at(
    client: &reqwest::Client,
    url: &str,
    settings: &Settings,
    token: &str,
) -> Result<bool, ()> {
    let mut response = client
        .post(url)
        .form(&[("secret", settings.secret.as_str()), ("response", token)])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|size| size > 32_768)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > 32_768 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    Ok(reply["success"].as_bool() == Some(true)
        && reply["action"].as_str() == Some(ACTION)
        && reply["hostname"].as_str().is_some_and(|host| {
            settings
                .widget_host()
                .is_some_and(|expected| expected.eq_ignore_ascii_case(host))
                && settings
                    .hostnames
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host))
        }))
}

pub async fn verify(settings: &Settings, token: &str) -> Result<(), (i32, &'static str)> {
    const REJECTED: (i32, &str) = (400, "人机验证失败，请重试");
    if !(1..=2048).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(REJECTED);
    }
    static VERIFYING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
    let _permit = VERIFYING
        .try_acquire()
        .map_err(|_| (429, "人机验证繁忙，请稍后重试"))?;
    match verify_at(
        client().ok_or((503, UNAVAILABLE))?,
        VERIFY_URL,
        settings,
        token,
    )
    .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(REJECTED),
        Err(()) => Err((503, "人机验证服务暂不可用，请稍后重试")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{HeaderMap, StatusCode},
        routing::post,
        Router,
    };

    #[tokio::test]
    async fn siteverify_checks_action_hostname_success_and_size_without_forwarding_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/verify",post(|headers: HeaderMap, bytes:Bytes| async move {
            assert!(!headers.contains_key("cookie") && !headers.contains_key("authorization"));
            let fields: std::collections::HashMap<_,_> = url::form_urlencoded::parse(&bytes).into_owned().collect();
            assert_eq!(fields.len(),2); assert_eq!(fields["secret"],"fixture");
            let code = fields["response"].as_str();
            let payload = json!({"action":if code=="action" {"other"} else {ACTION},"hostname": if code=="host" {"else.invalid"} else {"panel.invalid"},"success":code!="failed"});
            (if code == "http" {StatusCode::BAD_GATEWAY} else {StatusCode::OK}, if code == "large" {" ".repeat(33_000)} else {payload.to_string()})
        }));
        let fixture = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let settings = Settings {
            provider: Provider::Turnstile,
            site_key: "public".into(),
            widget_origin: "https://panel.invalid".into(),
            secret: "fixture".into(),
            hostnames: vec!["panel.invalid".into()],
        };
        for (token, result) in [
            ("valid", Ok(true)),
            ("action", Ok(false)),
            ("host", Ok(false)),
            ("failed", Ok(false)),
            ("http", Err(())),
            ("large", Err(())),
        ] {
            assert_eq!(
                verify_at(
                    client().unwrap(),
                    &format!("http://{address}/verify"),
                    &settings,
                    token
                )
                .await,
                result
            );
        }
        fixture.abort();
    }
}
