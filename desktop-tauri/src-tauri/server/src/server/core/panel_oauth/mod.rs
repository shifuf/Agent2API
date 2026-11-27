use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::server::{
    core::crypto::{self, SecretScope},
    db::Db,
};

pub mod flow;
pub const KEY: &str = "panelOauth";
pub const UNAVAILABLE: &str = "面板 OAuth 配置不可用";
pub const DENIED: &str = "此身份未获授权或登录请求已失效";
pub type Error = (i32, &'static str);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Github,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
        }
    }
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "google" => Ok(Self::Google),
            "github" => Ok(Self::Github),
            _ => Err((400, "OAuth 提供商无效")),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Client {
    pub enabled: bool,
    pub client_id: String,
    pub secret: String,
    subject: String,
    admin: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub origin: String,
    pub revision: String,
    google: Client,
    github: Client,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    settings_enc: String,
}

pub fn canonical_origin(input: &str) -> Result<String, Error> {
    let invalid = (400, "回调来源必须是预设的 HTTPS 站点，不含路径或凭据");
    let url = url::Url::parse(input.trim()).map_err(|_| invalid)?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(|host| host.is_empty())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid);
    }
    Ok(url.origin().ascii_serialization())
}

impl Settings {
    pub fn client(&self, p: Provider) -> &Client {
        match p {
            Provider::Google => &self.google,
            Provider::Github => &self.github,
        }
    }
    fn client_mut(&mut self, p: Provider) -> &mut Client {
        match p {
            Provider::Google => &mut self.google,
            Provider::Github => &mut self.github,
        }
    }
    pub fn admin(&self) -> Value {
        let entry = |client: &Client| json!({"enabled":client.enabled,"clientId":client.client_id,"hasSecret":!client.secret.is_empty(),"bound":!client.subject.is_empty()});
        json!({"origin":self.origin,"google":entry(&self.google),"github":entry(&self.github)})
    }
    pub fn public(&self, admin: &str) -> Vec<&'static str> {
        [Provider::Google, Provider::Github]
            .into_iter()
            .filter(|p| {
                let c = self.client(*p);
                c.enabled && !c.subject.is_empty() && c.admin == admin
            })
            .map(Provider::name)
            .collect()
    }
    fn validate(&self) -> Result<(), Error> {
        if !self.origin.is_empty() && canonical_origin(&self.origin)? != self.origin {
            return Err((400, "回调来源无效"));
        }
        for client in [&self.google, &self.github] {
            if client.client_id.len() > 256
                || !client
                    .client_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
                || client.secret.len() > 1024
                || !client.secret.bytes().all(|byte| byte.is_ascii_graphic())
                || client.subject.len() > 256
                || (client.enabled
                    && (self.origin.is_empty()
                        || client.client_id.is_empty()
                        || client.secret.is_empty()))
            {
                return Err((400, "OAuth 客户端配置不完整或无效"));
            }
        }
        Ok(())
    }
}

fn read(conn: &Connection) -> Result<Settings, Error> {
    let invalid = (503, UNAVAILABLE);
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| row.get(0))
        .optional()
        .map_err(|_| invalid)?;
    let Some(raw) = raw else {
        return Ok(Settings::default());
    };
    let stored: Stored = serde_json::from_str(&raw).map_err(|_| invalid)?;
    if stored.version != 1 || !crypto::is_envelope(&stored.settings_enc) {
        return Err(invalid);
    }
    let clear = Zeroizing::new(
        crypto::open(&stored.settings_enc, SecretScope::Accounts).map_err(|_| invalid)?,
    );
    let settings: Settings = serde_json::from_slice(&clear).map_err(|_| invalid)?;
    settings.validate().map_err(|_| invalid)?;
    Ok(settings)
}

fn write(conn: &Connection, settings: &mut Settings) -> Result<(), Error> {
    let err = (503, UNAVAILABLE);
    settings.validate()?;
    settings.revision = flow::random()?;
    let data = Zeroizing::new(serde_json::to_vec(settings).map_err(|_| err)?);
    let settings_enc = crypto::seal(&data, SecretScope::Accounts).map_err(|_| err)?;
    let raw = serde_json::to_string(&Stored {
        version: 1,
        settings_enc,
    })
    .map_err(|_| err)?;
    conn.execute("INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![KEY,raw]).map_err(|_|err)?;
    Ok(())
}

pub fn load(db: Option<&Db>) -> Result<Settings, Error> {
    db.and_then(|db| db.with(read)).ok_or((503, UNAVAILABLE))?
}

pub fn save(db: &Db, value: Value) -> Result<Settings, Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Patch {
        provider: Provider,
        origin: Option<String>,
        enabled: Option<bool>,
        client_id: Option<String>,
        secret: Option<String>,
        unbind: Option<bool>,
    }
    let patch: Patch = serde_json::from_value(value).map_err(|_| (400, "OAuth 设置字段无效"))?;
    let err = (503, UNAVAILABLE);
    db.with_mut(|conn| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| err)?;
        let mut settings = read(&tx)?;
        if let Some(origin) = patch.origin {
            let origin = canonical_origin(&origin)?;
            if origin != settings.origin {
                for p in [Provider::Google, Provider::Github] {
                    let c = settings.client_mut(p);
                    c.subject.clear();
                    c.admin.clear();
                }
                settings.origin = origin;
            }
        }
        let client = settings.client_mut(patch.provider);
        if let Some(id) = patch.client_id {
            if id != client.client_id {
                client.subject.clear();
                client.admin.clear();
                client.secret.clear();
                client.client_id = id;
            }
        }
        if let Some(secret) = patch.secret {
            client.secret = secret;
        }
        if let Some(enabled) = patch.enabled {
            client.enabled = enabled;
        }
        if patch.unbind == Some(true) {
            client.subject.clear();
            client.admin.clear();
        }
        write(&tx, &mut settings)?;
        tx.commit().map_err(|_| err)?;
        Ok(settings)
    })
    .ok_or(err)?
}

fn authorize_subject(
    settings: &mut Settings,
    flow: &flow::Pending,
    subject: &str,
    admin: &str,
) -> Result<bool, Error> {
    let denied = (403, DENIED);
    if subject.is_empty()
        || subject.len() > 256
        || !subject.bytes().all(|byte| byte.is_ascii_graphic())
        || flow.admin != admin
    {
        return Err(denied);
    }
    if settings.revision != flow.revision || settings.origin != flow.origin {
        return Err(denied);
    }
    let client = settings.client_mut(flow.provider);
    if !client.enabled {
        return Err(denied);
    }
    if flow.bind_session.is_some() {
        if !client.subject.is_empty() && (client.subject != subject || client.admin != admin) {
            return Err(denied);
        }
        client.subject = subject.to_owned();
        client.admin = admin.to_owned();
        Ok(true)
    } else if client.subject != subject || client.admin != admin {
        Err(denied)
    } else {
        Ok(false)
    }
}

pub fn authorize(db: &Db, flow: &flow::Pending, subject: &str, admin: &str) -> Result<(), Error> {
    let err = (503, UNAVAILABLE);
    db.with_mut(|conn| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| err)?;
        let mut settings = read(&tx)?;
        if authorize_subject(&mut settings, flow, subject, admin)? {
            write(&tx, &mut settings)?;
        }
        tx.commit().map_err(|_| err)?;
        Ok(())
    })
    .ok_or(err)?
}
