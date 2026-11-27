use super::{Client, Error, Provider, Settings, DENIED, UNAVAILABLE};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[cfg(test)]
#[path = "flow/tests.rs"]
mod tests;

pub const COOKIE: &str = "__Host-agent2api_oauth";
const TTL: Duration = Duration::from_secs(300);

pub struct Pending {
    pub provider: Provider,
    pub revision: String,
    pub origin: String,
    pub admin: String,
    pub bind_session: Option<String>,
    verifier: Zeroizing<String>,
    browser: [u8; 32],
    issued: Instant,
}
pub struct Started {
    pub url: String,
    pub cookie: String,
}

pub fn random() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| (503, UNAVAILABLE))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn flows() -> &'static Mutex<HashMap<String, Pending>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    FLOWS.get_or_init(Default::default)
}
fn callback(origin: &str, provider: Provider) -> String {
    format!("{origin}/api/panel/oauth/{}/callback", provider.name())
}

pub fn start(
    settings: &Settings,
    provider: Provider,
    admin: String,
    bind_session: Option<String>,
) -> Result<Started, Error> {
    let client = settings.client(provider);
    if !client.enabled
        || (bind_session.is_none() && !settings.public(&admin).contains(&provider.name()))
    {
        return Err((403, DENIED));
    }
    let state = random()?;
    let browser = random()?;
    let verifier = Zeroizing::new(random()?);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (auth, scope) = match provider {
        Provider::Google => ("https://accounts.google.com/o/oauth2/v2/auth", "openid"),
        Provider::Github => ("https://github.com/login/oauth/authorize", "read:user"),
    };
    let mut url = url::Url::parse(auth).map_err(|_| (503, UNAVAILABLE))?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", &callback(&settings.origin, provider)),
        ("response_type", "code"),
        ("scope", scope),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);
    let mut flows = flows().lock().map_err(|_| (503, UNAVAILABLE))?;
    flows.retain(|_, flow| flow.issued.elapsed() < TTL);
    if flows.len() >= 512 {
        return Err((429, "OAuth 登录繁忙，请稍后重试"));
    }
    flows.insert(
        state,
        Pending {
            provider,
            revision: settings.revision.clone(),
            origin: settings.origin.clone(),
            admin,
            bind_session,
            verifier,
            browser: Sha256::digest(browser.as_bytes()).into(),
            issued: Instant::now(),
        },
    );
    Ok(Started {
        url: url.into(),
        cookie: format!("{COOKIE}={browser}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax"),
    })
}

pub fn take(
    provider: Provider,
    state: &str,
    browser: &str,
    origin: &str,
    session: Option<&str>,
) -> Result<Pending, Error> {
    let denied = (403, DENIED);
    if state.len() != 43 || browser.len() != 43 {
        return Err(denied);
    }
    let mut flows = flows().lock().map_err(|_| (503, UNAVAILABLE))?;
    flows.retain(|_, flow| flow.issued.elapsed() < TTL);
    let flow = flows.get(state).ok_or(denied)?;
    if flow.provider != provider
        || flow.origin != origin
        || flow.browser != <[u8; 32]>::from(Sha256::digest(browser.as_bytes()))
        || flow
            .bind_session
            .as_deref()
            .is_some_and(|expected| Some(expected) != session)
    {
        return Err(denied);
    }
    flows.remove(state).ok_or(denied)
}

fn http() -> Result<&'static reqwest::Client, Error> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("Agent2API-Panel-OAuth")
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or((503, UNAVAILABLE))
}

async fn read_json(mut response: reqwest::Response) -> Result<Value, Error> {
    let err = (502, "OAuth 服务未返回有效的身份信息");
    if !response.status().is_success() || response.content_length().is_some_and(|len| len > 65536) {
        return Err(err);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| err)? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(err);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| err)
}

pub async fn identity(flow: &Pending, client: &Client, code: &str) -> Result<String, Error> {
    let (token, profile) = match flow.provider {
        Provider::Google => (
            "https://oauth2.googleapis.com/token",
            "https://openidconnect.googleapis.com/v1/userinfo",
        ),
        Provider::Github => (
            "https://github.com/login/oauth/access_token",
            "https://api.github.com/user",
        ),
    };
    exchange(flow, client, code, token, profile).await
}

async fn exchange(
    flow: &Pending,
    client: &Client,
    code: &str,
    token_url: &str,
    profile_url: &str,
) -> Result<String, Error> {
    if code.is_empty() || code.len() > 2048 || !code.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err((400, "OAuth 授权码无效"));
    }
    static IN_PROGRESS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
    let _permit = IN_PROGRESS
        .try_acquire()
        .map_err(|_| (429, "OAuth 登录繁忙，请稍后重试"))?;
    let err = (502, "OAuth 服务暂不可用");
    let client_http = http()?;
    let response = client_http
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("redirect_uri", &callback(&flow.origin, flow.provider)),
            ("code_verifier", flow.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| err)?;
    let mut reply = read_json(response).await?;
    if reply.get("error").is_some()
        || !reply["token_type"]
            .as_str()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
    {
        return Err((403, DENIED));
    }
    let Value::String(token) = reply["access_token"].take() else {
        return Err((403, DENIED));
    };
    let token = Zeroizing::new(token);
    if token.is_empty() || token.len() > 8192 {
        return Err((403, DENIED));
    }
    let profile = read_json(
        client_http
            .get(profile_url)
            .bearer_auth(token.as_str())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| err)?,
    )
    .await?;
    match flow.provider {
        Provider::Google => profile["sub"]
            .as_str()
            .filter(|sub| {
                !sub.is_empty()
                    && sub.len() <= 255
                    && sub.bytes().all(|byte| byte.is_ascii_graphic())
            })
            .map(str::to_owned),
        Provider::Github => profile["id"]
            .as_u64()
            .filter(|id| *id > 0)
            .map(|id| id.to_string()),
    }
    .ok_or((403, DENIED))
}
