use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use crate::server::core::crypto::{self, SecretScope};

#[cfg(test)]
mod sync360_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restore_rekeys_legacy_privacy_and_accepts_upstream_settings() {
        let original = [7; 32];
        let destination = [9; 32];
        let scope = SecretScope::Accounts.key_file().to_owned();
        let source = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(original))]) };
        let mut transform = SecretTransform { source: &source, rewrite: true, local: BTreeMap::from([(scope, Zeroizing::new(destination))]), count: 0 };
        let rules = br#"{"words":["fixture"]}"#;
        let mut value = json!({"version":1,"enabled":true,"rulesEnc":crypto::seal_with_key(rules, &original).unwrap()});
        transform.config("privacyRedaction", &mut value).unwrap();
        assert_eq!(crypto::open_with_key(value["rulesEnc"].as_str().unwrap(), &destination).unwrap(), rules);
        let mut upstream = json!({"enabled":true,"words":["private"],"reversible":true});
        transform.config("privacyRedaction", &mut upstream).unwrap();
        assert_eq!(upstream["version"], 2);
        let restored: Value = serde_json::from_slice(&crypto::open_with_key(upstream["rulesEnc"].as_str().unwrap(), &destination).unwrap()).unwrap();
        assert_eq!(restored["words"], json!(["private"]));
        for invalid in [json!({"enabled":"invalid"}), json!({"rulesEnc":"{}"}), json!({"rulesEnc":"enc1:invalid"})] {
            let database = Connection::open_in_memory().unwrap();
            database.execute_batch("CREATE TABLE accounts(data TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);").unwrap();
            database.execute("INSERT INTO kv VALUES ('privacyRedaction',?1)", [invalid.to_string()]).unwrap();
            assert!(validate(&database, &source).is_err());
        }
    }

    #[test]
    fn restore_rekeys_each_search_key_and_notification_bundle() {
        let original = [3; 32];
        let destination = [5; 32];
        let encrypt = |plain: &str| crypto::seal_with_key(plain.as_bytes(), &original).unwrap();
        let scope = SecretScope::Accounts.key_file().to_owned();
        let keys = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(original))]) };
        let mut transform = SecretTransform { source: &keys, rewrite: true, local: BTreeMap::from([(scope, Zeroizing::new(destination))]), count: 0 };
        let mut tools = json!({"providers": {"first": {"encryptedKey": encrypt("legacy")}, "second": {"keys": [{"id": "a", "encryptedKey": encrypt("first")},{"id": "b", "encryptedKey": encrypt("second")}]} }});
        let mut notifications = json!({"enabled": true, "channelsEnc": encrypt("{\"token\":\"fixture\"}")});
        transform.config("toolServices", &mut tools).unwrap();
        transform.config("notifications", &mut notifications).unwrap();
        assert_eq!(transform.count, 4);
        for (value, expected) in [(&tools["providers"]["first"]["encryptedKey"], "legacy"), (&tools["providers"]["second"]["keys"][0]["encryptedKey"], "first"), (&tools["providers"]["second"]["keys"][1]["encryptedKey"], "second"), (&notifications["channelsEnc"], "{\"token\":\"fixture\"}")] {
            assert_eq!(crypto::open_with_key(value.as_str().unwrap(), &destination).unwrap(), expected.as_bytes());
        }
    }

    #[test]
    fn panel_identity_settings_require_recoverable_envelopes() {
        let source_key = [43; 32];
        let target_key = [37; 32];
        let scope = SecretScope::Accounts.key_file().to_owned();
        let keys = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(source_key))]) };
        let mut transform = SecretTransform { source: &keys, rewrite: true, local: BTreeMap::from([(scope, Zeroizing::new(target_key))]), count: 0 };
        for name in ["panelTurnstile", "panelOauth"] {
            let content = br#"{"fixture":"binding"}"#;
            let mut bundle = json!({"version":1,"settingsEnc":crypto::seal_with_key(content, &source_key).unwrap()});
            transform.config(name, &mut bundle).unwrap();
            assert_eq!(crypto::open_with_key(bundle["settingsEnc"].as_str().unwrap(), &target_key).unwrap(), content);
            for mut bad in [json!({}), json!({"settingsEnc":"plaintext"}), json!({"settingsEnc":"enc1:invalid"})] {
                assert!(transform.config(name, &mut bad).is_err());
            }
        }
    }

    #[test]
    fn restore_validates_nested_search_secrets_before_replacing_database() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE accounts(data TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT);").unwrap();
        let encrypted = crypto::seal_with_key(b"fixture", &[8; 32]).unwrap();
        let tools = json!({"providers": {"search": {"keys": [{"encryptedKey": encrypted}]}}});
        connection.execute("INSERT INTO kv VALUES ('toolServices',?1)", [tools.to_string()]).unwrap();
        assert!(validate(&connection, &BackupKeys { values: BTreeMap::new() }).is_err());
    }

    #[test]
    fn restore_rejects_unreadable_or_plaintext_task_secrets() {
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch("CREATE TABLE accounts(data TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE task_jobs(id TEXT PRIMARY KEY, secrets_enc TEXT, storage_enc TEXT); INSERT INTO task_jobs VALUES('job','','');").unwrap();
        let source = BackupKeys { values: BTreeMap::new() };
        assert!(validate(&database, &source).is_ok());
        for column in ["secrets_enc", "storage_enc"] {
            for invalid in ["{}", "enc1:wrong"] {
                database.execute(&format!("UPDATE task_jobs SET {column}=?1"), [invalid]).unwrap();
                assert!(validate(&database, &source).is_err(), "{column} was ignored");
            }
            database.execute(&format!("UPDATE task_jobs SET {column}=''"), []).unwrap();
        }
    }

    #[test]
    fn restore_rekeys_both_task_fields_without_changing_empty_values() {
        let original = [11; 32];
        let destination = [12; 32];
        let scope = SecretScope::Accounts.key_file().to_owned();
        let source = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(original))]) };
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch("CREATE TABLE task_jobs(id TEXT PRIMARY KEY,secrets_enc TEXT,storage_enc TEXT); INSERT INTO task_jobs VALUES('empty','','');").unwrap();
        let secret = br#"{"password":"fixture"}"#;
        let storage = br#"{"cookie":"fixture"}"#;
        database.execute("INSERT INTO task_jobs VALUES('both',?1,?2)", params![crypto::seal_with_key(secret, &original).unwrap(), crypto::seal_with_key(storage, &original).unwrap()]).unwrap();
        let mut transform = SecretTransform { source: &source, rewrite: true, local: BTreeMap::from([(SecretScope::TaskPlugins.key_file().to_owned(), Zeroizing::new(destination))]), count: 0 };
        transform.task_secrets(&database).unwrap();
        assert_eq!(transform.count, 2);
        let pair: (String, String) = database.query_row("SELECT secrets_enc,storage_enc FROM task_jobs WHERE id='both'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(crypto::open_with_key(&pair.0, &destination).unwrap(), secret);
        assert_eq!(crypto::open_with_key(&pair.1, &destination).unwrap(), storage);
        assert!(database.query_row("SELECT secrets_enc='' AND storage_enc='' FROM task_jobs WHERE id='empty'", [], |row| row.get::<_, bool>(0)).unwrap());
    }

    #[test]
    fn restore_accepts_mixed_task_key_domains_and_seals_only_to_task_domain() {
        let account_key = [17; 32];
        let task_key = [18; 32];
        let destination = [19; 32];
        let source = BackupKeys { values: BTreeMap::from([
            (SecretScope::Accounts.key_file().to_owned(), Zeroizing::new(account_key)),
            (SecretScope::TaskPlugins.key_file().to_owned(), Zeroizing::new(task_key)),
        ]) };
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch("CREATE TABLE task_jobs(id TEXT PRIMARY KEY,secrets_enc TEXT,storage_enc TEXT)").unwrap();
        let plain = br#"{"value":"fixture"}"#;
        database.execute("INSERT INTO task_jobs VALUES('mixed',?1,?2)", params![crypto::seal_with_key(plain, &account_key).unwrap(), crypto::seal_with_key(plain, &task_key).unwrap()]).unwrap();
        let mut transform = SecretTransform { source: &source, rewrite: true, local: BTreeMap::from([(SecretScope::TaskPlugins.key_file().to_owned(), Zeroizing::new(destination))]), count: 0 };
        transform.task_secrets(&database).unwrap();
        let pair: (String, String) = database.query_row("SELECT secrets_enc,storage_enc FROM task_jobs", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        for encrypted in [pair.0, pair.1] {
            assert_eq!(crypto::open_with_key(&encrypted, &destination).unwrap(), plain);
            assert!(crypto::open_with_key(&encrypted, &account_key).is_err());
            assert!(crypto::open_with_key(&encrypted, &task_key).is_err());
        }
        assert_eq!(transform.count, 2);
    }

    #[test]
    fn restore_rekeys_upstream_notification_credentials_in_panel_scope() {
        let original = [23; 32];
        let destination = [24; 32];
        let scope = SecretScope::PanelCaptcha.key_file().to_owned();
        let source = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(original))]) };
        let mut transform = SecretTransform { source: &source, rewrite: true, local: BTreeMap::from([(scope, Zeroizing::new(destination))]), count: 0 };
        let mut value = json!({"channels":{
            "webhook":{"headersEnc":crypto::seal_with_key(br#"{"Authorization":"fixture"}"#, &original).unwrap()},
            "telegram":{"botTokenEnc":crypto::seal_with_key(b"fixture-bot", &original).unwrap()},
            "bark":{"deviceKeyEnc":crypto::seal_with_key(b"fixture-device", &original).unwrap()}
        }});
        transform.config("notifications", &mut value).unwrap();
        for (channel, field, expected) in [("webhook", "headersEnc", br#"{"Authorization":"fixture"}"#.as_slice()), ("telegram", "botTokenEnc", b"fixture-bot".as_slice()), ("bark", "deviceKeyEnc", b"fixture-device".as_slice())] {
            assert_eq!(crypto::open_with_key(value["channels"][channel][field].as_str().unwrap(), &destination).unwrap(), expected);
        }
        assert_eq!(transform.count, 3);
    }

    #[test]
    fn restore_rekeys_both_oauth_formats_and_rejects_plaintext_external_secrets() {
        let source_key = [47; 32];
        let destination = [49; 32];
        let scope = SecretScope::PanelCaptcha.key_file().to_owned();
        let source = BackupKeys { values: BTreeMap::from([(scope.clone(), Zeroizing::new(source_key))]) };
        let mut transform = SecretTransform { source: &source, rewrite: true, local: BTreeMap::from([(scope, Zeroizing::new(destination))]), count: 0 };
        for name in ["panelOauth", "panelOauthExternal"] {
            let mut value = json!({"publicBaseUrl":"https://fixture.invalid", "google":{"clientSecretEnc":crypto::seal_with_key(b"google", &source_key).unwrap()},"github":{"clientSecretEnc":crypto::seal_with_key(b"github", &source_key).unwrap()}});
            transform.config(name, &mut value).unwrap();
            for provider in ["google", "github"] {
                assert_eq!(crypto::open_with_key(value[provider]["clientSecretEnc"].as_str().unwrap(), &destination).unwrap(), provider.as_bytes());
            }
            let mut invalid = json!({"google":{"clientSecretEnc":"plaintext"}});
            assert!(transform.config(name, &mut invalid).is_err());
        }
    }
}

const SCOPES: [SecretScope; 6] = [
    SecretScope::Accounts,
    SecretScope::UpdateToken,
    SecretScope::CloudSync,
    SecretScope::CodingSessions,
    SecretScope::PanelCaptcha,
    SecretScope::TaskPlugins,
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KeyArtifact {
    key: String,
    fingerprint: String,
}

impl Drop for KeyArtifact {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

pub(super) struct BackupKeys {
    values: BTreeMap<String, Zeroizing<[u8; 32]>>,
}

impl BackupKeys {
    pub fn collect() -> Result<Self, String> {
        let mut values = BTreeMap::new();
        for scope in SCOPES {
            if let Some(key) = crypto::backup_key(scope)? {
                values.insert(scope.key_file().to_string(), Zeroizing::new(key));
            }
        }
        Ok(Self { values })
    }

    pub fn artifacts(&self) -> BTreeMap<String, KeyArtifact> {
        self.values
            .iter()
            .map(|(name, key)| {
                (
                    name.clone(),
                    KeyArtifact {
                        key: STANDARD.encode(key.as_ref()),
                        fingerprint: crypto::fingerprint_of(key.as_ref()),
                    },
                )
            })
            .collect()
    }

    pub fn from_artifacts(artifacts: BTreeMap<String, KeyArtifact>) -> Result<Self, String> {
        if artifacts.len() > SCOPES.len() {
            return Err("备份包含不支持的密钥域".into());
        }
        let mut values = BTreeMap::new();
        for (name, artifact) in artifacts {
            if !SCOPES.iter().any(|scope| scope.key_file() == name) {
                return Err("备份包含不支持的密钥域".into());
            }
            let bytes = Zeroizing::new(
                STANDARD
                    .decode(&artifact.key)
                    .map_err(|_| "备份密钥编码损坏".to_string())?,
            );
            let key: [u8; 32] = bytes
                .as_slice()
                .try_into()
                .map_err(|_| "备份密钥长度异常".to_string())?;
            if crypto::fingerprint_of(&key) != artifact.fingerprint {
                return Err("备份密钥指纹不匹配，文件可能已损坏".into());
            }
            values.insert(name, Zeroizing::new(key));
        }
        Ok(Self { values })
    }

    pub fn names(&self) -> Vec<String> {
        self.values.keys().cloned().collect()
    }

    fn decrypt(
        &self,
        value: &str,
        scope: SecretScope,
        field: &str,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        let key = self
            .values
            .get(scope.key_file())
            .ok_or_else(|| format!("备份缺少 {}，无法恢复{field}", scope.key_file()))?;
        crypto::open_with_key(value, key)
            .map(Zeroizing::new)
            .map_err(|_| format!("{field}无法解密，数据与 {} 不匹配", scope.key_file()))
    }
}

struct SecretTransform<'a> {
    source: &'a BackupKeys,
    rewrite: bool,
    local: BTreeMap<String, Zeroizing<[u8; 32]>>,
    count: usize,
}

impl SecretTransform<'_> {
    fn external_oauth(&mut self, value: &mut Value) -> Result<(), String> {
        if !value.is_object() { return Err("OAuth 设置格式无效".into()); }
        for provider in ["google", "github"] {
            if let Some(settings) = value.get_mut(provider) {
                if !settings.is_object() { return Err("OAuth 提供商设置格式无效".into()); }
                if let Some(secret) = settings.get_mut("clientSecretEnc") {
                    let text = secret.as_str().ok_or("OAuth 密文字段格式无效")?;
                    if !text.is_empty() && !crypto::is_envelope(text) { return Err("OAuth 密钥必须为有效密文".into()); }
                    self.value(secret, SecretScope::PanelCaptcha, "OAuth Client Secret", false)?;
                }
            }
        }
        Ok(())
    }

    fn value(
        &mut self,
        value: &mut Value,
        scope: SecretScope,
        field: &str,
        json: bool,
    ) -> Result<(), String> {
        let Some(text) = value.as_str() else {
            return Err(format!("{field}格式异常"));
        };
        if text.is_empty() {
            return Ok(());
        }
        let encrypted = crypto::is_envelope(text);
        if !encrypted && !json {
            return Ok(());
        }
        let plain = if encrypted {
            self.source.decrypt(text, scope, field)?
        } else {
            Zeroizing::new(text.as_bytes().to_vec())
        };
        if json {
            let parsed: Value =
                serde_json::from_slice(&plain).map_err(|_| format!("{field}内容不是合法 JSON"))?;
            if !parsed.is_object() {
                return Err(format!("{field}内容不是对象"));
            }
        }
        if !self.rewrite {
            return Ok(());
        }
        let name = scope.key_file().to_string();
        if !self.local.contains_key(&name) {
            self.local
                .insert(name.clone(), Zeroizing::new(crypto::secret_key(scope)?));
        }
        let key = self.local.get(&name).ok_or("目标机器密钥不可用")?;
        *value = Value::String(crypto::seal_with_key(&plain, key)?);
        self.count += 1;
        Ok(())
    }

    fn field(
        &mut self,
        object: &mut Value,
        name: &str,
        scope: SecretScope,
        label: &str,
        json: bool,
    ) -> Result<(), String> {
        if let Some(value) = object.get_mut(name) {
            self.value(value, scope, label, json)?;
        }
        Ok(())
    }

    fn config(&mut self, name: &str, value: &mut Value) -> Result<(), String> {
        match name {
            "toolServices" => {
                if let Some(providers) = value.get_mut("providers") {
                    for provider in providers.as_object_mut().ok_or("工具提供商配置格式异常")?.values_mut() {
                        self.field(provider, "encryptedKey", SecretScope::Accounts, "工具服务 Key", false)?;
                        if let Some(keys) = provider.get_mut("keys") {
                            for item in keys.as_array_mut().ok_or("工具服务 Key 列表格式异常")? {
                                self.field(item, "encryptedKey", SecretScope::Accounts, "工具服务 Key", false)?;
                            }
                        }
                    }
                }
            }
            "notifications" => {
                if let Some(text) = value.get("channelsEnc").and_then(Value::as_str) {
                    if !text.is_empty() && !crypto::is_envelope(text) { return Err("通知配置必须包含有效密文".into()); }
                }
                self.field(value, "channelsEnc", SecretScope::Accounts, "通知渠道配置", true)?;
                if let Some(channels) = value.get_mut("channels") {
                    for (channel, field, json) in [("webhook", "headersEnc", true), ("telegram", "botTokenEnc", false), ("bark", "deviceKeyEnc", false)] {
                        if let Some(settings) = channels.get_mut(channel) {
                            self.field(settings, field, SecretScope::PanelCaptcha, "通知渠道凭据", json)?;
                        }
                    }
                }
            }
            "privacyRedaction" => {
                if let Some(encrypted) = value.get_mut("rulesEnc") {
                    if !encrypted.as_str().is_some_and(crypto::is_envelope) {
                        return Err("隐私配置必须包含有效密文".into());
                    }
                    self.value(encrypted, SecretScope::Accounts, "隐私规则", true)?;
                } else {
                    let settings: crate::server::core::privacy::PrivacySettings = serde_json::from_value(value.clone())
                        .map_err(|_| "隐私配置格式异常")?;
                    let compiled = crate::server::core::privacy::CompiledPrivacySettings::compile(settings)?;
                    if self.rewrite {
                        let mut encrypted = Value::String(serde_json::to_string(&compiled.settings).map_err(|_| "隐私配置序列化失败")?);
                        self.value(&mut encrypted, SecretScope::Accounts, "隐私规则", true)?;
                        *value = serde_json::json!({"version":2,"enabled":compiled.settings.enabled,"rulesEnc":encrypted});
                    }
                }
            }
            "panelOauthExternal" => self.external_oauth(value)?,
            "panelOauth" if value.get("settingsEnc").is_none() && (value.get("google").is_some() || value.get("github").is_some()) => self.external_oauth(value)?,
            "panelTurnstile" | "panelOauth" => {
                let encrypted = value.get_mut("settingsEnc").ok_or("面板身份设置缺少密文")?;
                if !encrypted.as_str().is_some_and(crypto::is_envelope) { return Err("面板身份设置必须包含有效密文".into()); }
                self.value(encrypted, SecretScope::Accounts, "面板身份配置", true)?;
            }
            "apiKey" => self.value(value, SecretScope::Accounts, "网关 Key", false)?,
            "githubToken" => self.value(value, SecretScope::UpdateToken, "GitHub 令牌", false)?,
            "apiKeys" => {
                let items = value.as_array_mut().ok_or("网关 Key 列表格式异常")?;
                for item in items {
                    self.field(item, "key", SecretScope::Accounts, "网关 Key", false)?;
                }
            }
            "agentProfiles" => {
                let clients = value.as_object_mut().ok_or("Agent 方案格式异常")?;
                for profiles in clients.values_mut() {
                    let profiles = profiles.as_array_mut().ok_or("Agent 方案列表格式异常")?;
                    for profile in profiles {
                        self.field(
                            profile,
                            "apiKey",
                            SecretScope::Accounts,
                            "Agent 方案 Key",
                            false,
                        )?;
                        if profile.get("native").is_some_and(Value::is_string) {
                            self.field(
                                profile,
                                "native",
                                SecretScope::Accounts,
                                "Agent 原生方案",
                                true,
                            )?;
                        }
                    }
                }
            }
            "panelCaptcha" => {
                self.field(value, "secretKey", SecretScope::PanelCaptcha, "Turnstile 服务端密钥", false)?;
            }
            "assistantCoding" => {
                self.field(value, "accessToken", SecretScope::CodingSessions, "编程会话连接密钥", false)?;
            }
            "cloudSync" => {
                if !value.is_object() {
                    return Err("云同步设置格式异常".into());
                }
                self.field(
                    value,
                    "syncPassword",
                    SecretScope::CloudSync,
                    "云同步密码",
                    false,
                )?;
                if let Some(webdav) = value.get_mut("webdav") {
                    self.field(
                        webdav,
                        "password",
                        SecretScope::CloudSync,
                        "WebDAV 密码",
                        false,
                    )?;
                }
                if let Some(s3) = value.get_mut("s3") {
                    self.field(
                        s3,
                        "secretAccessKey",
                        SecretScope::CloudSync,
                        "S3 凭据",
                        false,
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn task_secrets(&mut self, conn: &Connection) -> Result<(), String> {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_jobs')", [], |row| row.get(0)).map_err(|_| "检查任务表失败")?;
        if !exists { return Ok(()); }
        let mut cursor: Option<i64> = None;
        loop {
            let row: Option<(i64, String, String)> = conn.query_row("SELECT rowid,secrets_enc,storage_enc FROM task_jobs WHERE ?1 IS NULL OR rowid>?1 ORDER BY rowid LIMIT 1", [cursor], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|_| "读取任务密文失败")?;
            let Some((id, secrets, storage)) = row else { break };
            cursor = Some(id);
            let mut fields = [Value::String(secrets), Value::String(storage)];
            for value in &mut fields {
                let text = value.as_str().ok_or("任务密文字段无效")?;
                let opened = crate::server::core::task_plugins::secret_compat::open_with(text, |raw, scope| {
                    self.source.decrypt(raw, scope, "任务密文").map(|plain| plain.to_vec())
                })?;
                let Some(opened) = opened else { continue };
                let plaintext = Zeroizing::new(opened.plaintext);
                if self.rewrite {
                    let scope = SecretScope::TaskPlugins;
                    let name = scope.key_file().to_owned();
                    if !self.local.contains_key(&name) {
                        self.local.insert(name.clone(), Zeroizing::new(crypto::secret_key(scope)?));
                    }
                    let key = self.local.get(&name).ok_or("目标机器密钥不可用")?;
                    *value = Value::String(crypto::seal_with_key(&plaintext, key)?);
                    self.count += 1;
                }
            }
            if self.rewrite {
                conn.execute("UPDATE task_jobs SET secrets_enc=?1, storage_enc=?2 WHERE rowid=?3", params![fields[0].as_str(), fields[1].as_str(), id]).map_err(|_| "迁移任务密文失败")?;
            }
        }
        Ok(())
    }
}

pub(super) fn validate(conn: &Connection, source: &BackupKeys) -> Result<(), String> {
    transform(conn, source, false).map(|_| ())
}

pub(super) fn reencrypt(conn: &mut Connection, source: &BackupKeys) -> Result<usize, String> {
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER,
        false,
    )
    .map_err(|error| format!("禁用暂存库触发器失败: {error}"))?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开启凭证迁移事务失败: {error}"))?;
    let count = transform(&transaction, source, true)?;
    transaction
        .commit()
        .map_err(|error| format!("提交凭证迁移失败: {error}"))?;
    Ok(count)
}

fn transform(conn: &Connection, source: &BackupKeys, rewrite: bool) -> Result<usize, String> {
    let mut transform = SecretTransform {
        source,
        rewrite,
        local: BTreeMap::new(),
        count: 0,
    };
    let mut last_rowid = None;
    loop {
        let row: Option<(i64, String)> = conn.query_row(
            "SELECT rowid, data FROM accounts WHERE ?1 IS NULL OR rowid > ?1 ORDER BY rowid LIMIT 1",
            [last_rowid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| format!("读取账号凭证失败: {error}"))?;
        let Some((id, text)) = row else { break };
        last_rowid = Some(id);
        let mut value = Value::String(text);
        transform.value(&mut value, SecretScope::Accounts, "账号凭证", true)?;
        if rewrite {
            conn.execute(
                "UPDATE accounts SET data=?1 WHERE rowid=?2",
                params![value.as_str(), id],
            )
            .map_err(|error| format!("迁移账号凭证失败: {error}"))?;
        }
    }
    for name in [
        "apiKey",
        "apiKeys",
        "toolServices",
        "notifications",
        "privacyRedaction",
        "panelTurnstile",
        "panelOauth",
        "panelOauthExternal",
        "githubToken",
        "agentProfiles",
        "assistantCoding",
        "panelCaptcha",
        "cloudSync",
    ] {
        let text: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key=?1", [name], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| format!("读取加密配置失败: {error}"))?;
        let Some(text) = text else { continue };
        let mut value: Value =
            serde_json::from_str(&text).map_err(|_| format!("配置项 {name} 格式异常"))?;
        transform.config(name, &mut value)?;
        if rewrite {
            let serialized = serde_json::to_string(&value).map_err(|_| "序列化加密配置失败")?;
            conn.execute(
                "UPDATE kv SET value=?1 WHERE key=?2",
                params![serialized, name],
            )
            .map_err(|error| format!("迁移加密配置失败: {error}"))?;
        }
    }
    transform.task_secrets(conn)?;
    Ok(transform.count)
}
