use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::server::{
    core::crypto::{self, SecretScope},
    db::Db,
};

mod vault;
pub use vault::Vault;
pub mod stream;
#[cfg(test)]
mod tests;

pub const KEY: &str = "privacyRedaction";
pub const UNAVAILABLE: &str = "隐私配置不可用，请联系管理员；请求未转发";
pub const REJECTED: &str = "请求包含无法安全处理的隐私数据；请求未转发";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Rules {
    pub words: Vec<String>,
}

impl Rules {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.words.len() > 128
            || self.words.iter().any(|word| {
                !(2..=256).contains(&word.chars().count())
                    || word.trim().is_empty()
                    || word.chars().any(char::is_control)
            })
        {
            return Err("保密词限 128 个，每个 2 至 256 个非控制字符");
        }
        Ok(())
    }
    pub(super) fn detector(&self) -> Result<Regex, &'static str> {
        self.validate()?;
        let mut terms: Vec<_> = self.words.iter().map(|word| regex::escape(word)).collect();
        terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
        terms.push(r"(?i:(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[a-z0-9]{16}|glpat-[a-z0-9_-]{20,}|AIza[a-z0-9_-]{35}|xox[baprs]-[a-z0-9-]{10,}|[sr]k_live_[a-z0-9]{16,}|(?:hf|gsk|npm)_[a-z0-9]{20,}|xai-[a-z0-9]{20,}|pypi-[a-z0-9_-]{20,})|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24})|(?:[1-9][0-9]{16}[0-9Xx])|(?:1[3-9][0-9]{9})".into());
        regex::RegexBuilder::new(&terms.join("|"))
            .size_limit(4 * 1024 * 1024)
            .build()
            .map_err(|_| "隐私规则超出限制")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    enabled: bool,
    rules_enc: String,
}

pub struct Policy {
    pub enabled: bool,
    pub rules: Rules,
}

pub fn load(db: &Db) -> Result<Policy, &'static str> {
    let raw: Option<String> = db
        .with(|conn| {
            conn.query_row("SELECT value FROM kv WHERE key=?1", [KEY], |row| row.get(0))
                .optional()
        })
        .ok_or(UNAVAILABLE)?
        .map_err(|_| UNAVAILABLE)?;
    let Some(raw) = raw else {
        return Ok(Policy {
            enabled: false,
            rules: Rules::default(),
        });
    };
    let stored: Stored = serde_json::from_str(&raw).map_err(|_| UNAVAILABLE)?;
    if stored.version != 1 || !crypto::is_envelope(&stored.rules_enc) {
        return Err(UNAVAILABLE);
    }
    let bytes = Zeroizing::new(
        crypto::open(&stored.rules_enc, SecretScope::Accounts).map_err(|_| UNAVAILABLE)?,
    );
    let rules: Rules = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    rules.validate().map_err(|_| UNAVAILABLE)?;
    Ok(Policy {
        enabled: stored.enabled,
        rules,
    })
}

pub fn write(db: &Db, value: &Value) -> Result<Value, (i32, &'static str)> {
    static WRITER: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = WRITER
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| (503, UNAVAILABLE))?;
    let map = value.as_object().ok_or((400, "隐私设置必须是对象"))?;
    if map.is_empty()
        || map
            .keys()
            .any(|name| !matches!(name.as_str(), "enabled" | "words"))
    {
        return Err((400, "隐私设置字段无效"));
    }
    let mut policy = load(db).or_else(|_| {
        if map.contains_key("words") && map.contains_key("enabled") {
            Ok(Policy {
                enabled: false,
                rules: Rules::default(),
            })
        } else {
            Err((503, UNAVAILABLE))
        }
    })?;
    if let Some(enabled) = map.get("enabled") {
        policy.enabled = enabled.as_bool().ok_or((400, "启用状态必须是布尔值"))?;
    }
    if let Some(words) = map.get("words") {
        policy.rules.words =
            serde_json::from_value(words.clone()).map_err(|_| (400, "保密词必须是字符串列表"))?;
    }
    policy.rules.detector().map_err(|err| (400, err))?;
    let bytes = Zeroizing::new(serde_json::to_vec(&policy.rules).map_err(|_| (503, UNAVAILABLE))?);
    let rules_enc = crypto::seal(&bytes, SecretScope::Accounts).map_err(|_| (503, UNAVAILABLE))?;
    let stored = serde_json::to_string(&Stored {
        version: 1,
        enabled: policy.enabled,
        rules_enc,
    })
    .map_err(|_| (503, UNAVAILABLE))?;
    db.with(|conn| conn.execute("INSERT INTO kv(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![KEY,stored])).ok_or((503, UNAVAILABLE))?.map_err(|_| (503, UNAVAILABLE))?;
    Ok(policy.public())
}

impl Policy {
    pub fn public(&self) -> Value {
        json!({"enabled":self.enabled,"wordCount":self.rules.words.len()})
    }
}

tokio::task_local! { pub static ACTIVE: Arc<Vault>; }
tokio::task_local! { pub(crate) static LOG_SCOPE: std::sync::Weak<()>; }

pub(crate) fn log_scope() -> Option<std::sync::Weak<()>> {
    ACTIVE
        .try_with(|vault| vault.log_scope())
        .ok()
        .or_else(|| LOG_SCOPE.try_with(Clone::clone).ok())
}

pub(crate) fn private_log() -> bool {
    log_scope().is_some_and(|scope| scope.strong_count() > 0)
}
