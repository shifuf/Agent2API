//! 系统通知，选择性适配自 aimod-cc/Agent2API b21f870c（Lucas）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::server::config;
use crate::server::core::crypto::{self, SecretScope};
use crate::server::logging;

mod channels;

const KEY: &str = "notifications";
const CHANNELS: [&str; 3] = ["webhook", "telegram", "bark"];
const EVENTS: [&str; 3] = ["loginSuccess", "loginFailure", "checkinFailure"];
type Fields = Map<String, Value>;
pub type Error = (i32, &'static str);

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    events: Fields,
    channels: Fields,
    channels_enc: String,
}

impl Settings {
    fn parse(value: Value) -> Result<Self, Error> {
        if value.is_null() { return Ok(Self::default()); }
        serde_json::from_value(value).map_err(|_| (500, "已保存的通知设置不可读取"))
    }

    fn current() -> Result<Self, Error> {
        Self::parse(config::with_raw(|raw| raw.get(KEY).cloned()).flatten().unwrap_or(Value::Null))
    }

    fn secrets(&self) -> Result<Fields, Error> {
        if self.channels_enc.is_empty() { return Ok(Fields::new()); }
        let raw = Zeroizing::new(crypto::open(&self.channels_enc, SecretScope::Accounts)
            .map_err(|_| (500, "通知配置无法解密"))?);
        serde_json::from_slice(raw.as_slice()).map_err(|_| (500, "已保存的通知参数不可读取"))
    }

    fn public(&self, secrets: &Fields) -> Value {
        let mut channels = Fields::new();
        for kind in CHANNELS {
            let mut state = json!({"enabled": self.channel_enabled(kind)});
            for key in fields(kind) {
                let value = secrets.get(kind).and_then(|data| data.get(*key));
                state[format!("{key}Set")] = json!(value.is_some());
            }
            channels.insert(kind.into(), state);
        }
        let events: Fields = EVENTS.iter().map(|event| ((*event).into(), json!(self.events.get(*event) == Some(&Value::Bool(true))))).collect();
        json!({"enabled": self.enabled, "events": events, "channels": channels})
    }

    fn channel_enabled(&self, kind: &str) -> bool {
        self.channels.get(kind) == Some(&Value::Bool(true))
    }

    fn apply(&mut self, patch: &Fields, secrets: &mut Fields) -> Result<(), Error> {
        if patch.keys().any(|key| !matches!(key.as_str(), "enabled" | "events" | "channels")) { return Err((400, "未知通知设置")); }
        if let Some(value) = patch.get("enabled") { self.enabled = flag(value)?; }
        if let Some(value) = patch.get("events") {
            for (event, flag_value) in object(value)? {
                if !EVENTS.contains(&event.as_str()) { return Err((400, "未知通知事件")); }
                self.events.insert(event.clone(), json!(flag(flag_value)?));
            }
        }
        if let Some(value) = patch.get("channels") {
            for (kind, data) in object(value)? {
                if !CHANNELS.contains(&kind.as_str()) { return Err((400, "未知通知渠道")); }
                let section = secrets.entry(kind.clone()).or_insert_with(|| json!({}));
                let section = section.as_object_mut().ok_or((500, "通知参数不可读取"))?;
                for (key, field) in object(data)? {
                    if key == "enabled" { self.channels.insert(kind.clone(), json!(flag(field)?)); continue; }
                    if !fields(kind).contains(&key.as_str()) { return Err((400, "未知通知参数")); }
                    if field.is_null() || field.as_str() == Some("") {
                        section.remove(key);
                    } else {
                        channels::validate(key, field)?;
                        section.insert(key.clone(), field.clone());
                    }
                }
            }
        }
        Ok(())
    }
}

fn fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "webhook" => &["url", "headers"],
        "telegram" => &["apiBase", "botToken", "chatId", "proxyUrl"],
        "bark" => &["serverUrl", "deviceKey", "group", "sound"],
        _ => &[],
    }
}

fn object(value: &Value) -> Result<&Fields, Error> { value.as_object().ok_or((400, "通知参数必须为对象")) }
fn flag(value: &Value) -> Result<bool, Error> { value.as_bool().ok_or((400, "通知开关必须为布尔值")) }

pub fn get() -> Result<Value, Error> {
    let settings = Settings::current()?;
    Ok(settings.public(&settings.secrets()?))
}

pub fn save(payload: &Value) -> Result<Value, Error> {
    let patch = object(payload)?;
    config::try_update_raw_field(KEY, |stored| {
        let mut settings = Settings::parse(stored.clone())?;
        let mut secrets = settings.secrets()?;
        settings.apply(patch, &mut secrets)?;
        if patch.contains_key("channels") {
            let bytes = Zeroizing::new(serde_json::to_vec(&secrets).map_err(|_| (500, "无法保存通知参数"))?);
            settings.channels_enc = crypto::seal(bytes.as_slice(), SecretScope::Accounts).map_err(|_| (500, "无法加密通知配置"))?;
        }
        let public = settings.public(&secrets);
        *stored = serde_json::to_value(settings).map_err(|_| (500, "无法保存通知设置"))?;
        Ok(public)
    }, || (500, "通知设置保存失败"))
}

pub async fn test(payload: &Value) -> Result<Value, Error> {
    let kind = payload.get("channel").and_then(Value::as_str).filter(|kind| CHANNELS.contains(kind)).ok_or((400, "请选择通知渠道"))?;
    let mut settings = Settings::current()?;
    let mut secrets = settings.secrets()?;
    if let Some(draft) = payload.get("draft") { settings.apply(object(draft)?, &mut secrets)?; }
    channels::send(kind, &secrets, "test", "Agent2API 通知测试", "测试通知", &json!({})).await?;
    Ok(json!({"channel":kind, "sent":true}))
}

fn notify(setting: &'static str, event: &'static str, title: &'static str, body: String, data: Value) {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
    let Ok(settings) = Settings::current() else { return };
    if !settings.enabled || settings.events.get(setting) != Some(&Value::Bool(true)) { return; }
    let Ok(permit) = SLOTS.try_acquire() else { return };
    crate::spawn_task(async move {
        let _permit = permit;
        let Ok(secrets) = settings.secrets() else { logging::log("[Notify]", "通知配置不可读取"); return };
        for kind in CHANNELS {
            if settings.channel_enabled(kind) && channels::send(kind, &secrets, event, title, &body, &data).await.is_err() {
                logging::log("[Notify]", &format!("通知发送失败：{kind}"));
            }
        }
    });
}

pub fn login(success: bool) {
    let (setting, event, title) = if success { ("loginSuccess", "login_success", "面板登录成功") }
        else { ("loginFailure", "login_failure", "面板登录失败") };
    notify(setting, event, title, title.into(), json!({"method":"password"}));
}

pub fn checkin(source: &str, count: usize) {
    if count > 0 && matches!(source, "schedule" | "makeup" | "startup") {
        notify("checkinFailure", "checkin_failure", "自动签到失败", format!("失败数量：{count}"), json!({"source":source, "failedCount":count}));
    }
}

#[cfg(feature = "task-plugins")]
pub fn task_channel_enabled() -> bool {
    Settings::current().is_ok_and(|settings| settings.enabled && CHANNELS.iter().any(|channel| settings.channel_enabled(channel)))
}

#[cfg(feature = "task-plugins")]
pub async fn task_signal(authorized: impl Fn() -> bool) -> Result<(), Error> {
    let mut delivered = false;
    for kind in CHANNELS {
        if !authorized() { return Err((403, "任务通知未授权")); }
        let settings = Settings::current()?;
        if !settings.enabled { return Err((403, "系统通知已停用")); }
        if settings.channel_enabled(kind) {
            channels::send(kind, &settings.secrets()?, "task_signal", "定时任务通知", "已授权的任务请求发送通知", &json!({})).await?;
            delivered = true;
        }
    }
    if delivered { Ok(()) } else { Err((400, "没有启用的通知渠道")) }
}
