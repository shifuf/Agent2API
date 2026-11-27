use std::sync::Arc;

use serde_json::{Map, Value};

use crate::server::core::privacy::{CompiledPrivacySettings, PrivacySettings};

use super::{update, RuntimeConfig};

pub const KEY_PRIVACY_REDACTION: &str = "privacyRedaction";

pub(super) fn from_raw(raw: &Map<String, Value>) -> Arc<CompiledPrivacySettings> {
    Arc::new(compile_raw(raw).unwrap_or_default())
}

pub(crate) fn compile_raw(raw: &Map<String, Value>) -> Result<CompiledPrivacySettings, String> {
    let Some(value) = raw.get(KEY_PRIVACY_REDACTION).filter(|value| !value.is_null()) else {
        return CompiledPrivacySettings::compile(PrivacySettings::default());
    };
    let settings = if let Some(envelope) = value.get("rulesEnc") {
        let envelope = envelope.as_str().ok_or("隐私规则密文格式无效")?;
        let bytes = zeroize::Zeroizing::new(crate::server::core::crypto::open(
            envelope, crate::server::core::crypto::SecretScope::Accounts,
        )?);
        let mut settings: PrivacySettings = serde_json::from_slice(&bytes)
            .map_err(|_| "隐私规则密文内容无效".to_owned())?;
        settings.enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(settings.enabled);
        if value.get("version").and_then(Value::as_u64) == Some(1) {
            settings.personal = true;
        }
        settings
    } else {
        serde_json::from_value(value.clone()).map_err(|_| "隐私规则格式无效".to_owned())?
    };
    CompiledPrivacySettings::compile(settings)
}

impl RuntimeConfig {
    pub fn privacy_settings(&self) -> Arc<CompiledPrivacySettings> {
        self.privacy.clone()
    }
}

pub fn set_privacy_settings(
    settings: PrivacySettings,
) -> Result<(bool, Arc<CompiledPrivacySettings>), String> {
    let compiled = Arc::new(CompiledPrivacySettings::compile(settings)?);
    let serialized = zeroize::Zeroizing::new(serde_json::to_vec(&compiled.settings)
        .map_err(|error| format!("隐私脱敏配置序列化失败：{error}"))?);
    let serialized = serde_json::json!({
        "version": 2,
        "enabled": compiled.settings.enabled,
        "rulesEnc": crate::server::core::crypto::seal(&serialized, crate::server::core::crypto::SecretScope::Accounts)?,
    });
    let next = compiled.clone();
    let saved = update(|config| {
        config
            .raw
            .insert(KEY_PRIVACY_REDACTION.to_string(), serialized);
        config.privacy = next;
    });
    Ok((saved, compiled))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::core::crypto::{self, SecretScope};
    use serde_json::json;

    #[test]
    fn legacy_encrypted_words_keep_personal_detectors() {
        crate::test_support::isolated(concat!(module_path!(), "::legacy_encrypted_words_keep_personal_detectors"), || {
            let envelope = crypto::seal(br#"{"words":["private-fixture"]}"#, SecretScope::Accounts).unwrap();
            let raw = Map::from_iter([(KEY_PRIVACY_REDACTION.into(), json!({"version":1,"enabled":true,"rulesEnc":envelope}))]);
            let compiled = compile_raw(&raw).unwrap();
            assert!(compiled.settings.enabled);
            assert!(compiled.settings.personal);
            assert_eq!(compiled.settings.words, ["private-fixture"]);
            let preview = crate::server::core::privacy::preview_text("private-fixture", &compiled);
            assert_ne!(preview["maskedText"], "private-fixture");
            assert_eq!(preview["restoredText"], "private-fixture");
            assert!(!preview["matches"].as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn encrypted_upstream_settings_preserve_reversible_and_provider_rules() {
        crate::test_support::isolated(concat!(module_path!(), "::encrypted_upstream_settings_preserve_reversible_and_provider_rules"), || {
            let plain = json!({"enabled":true,"reversible":false,"personal":false,"words":["fixture"],"providerMode":"include","providers":["custom:test"]});
            let envelope = crypto::seal(&serde_json::to_vec(&plain).unwrap(), SecretScope::Accounts).unwrap();
            let raw = Map::from_iter([(KEY_PRIVACY_REDACTION.into(), json!({"version":2,"enabled":true,"rulesEnc":envelope}))]);
            let compiled = compile_raw(&raw).unwrap();
            assert!(!compiled.settings.reversible);
            assert!(!compiled.settings.personal);
            assert_eq!(compiled.settings.providers, ["custom:test"]);
        });
    }

    #[test]
    fn unreadable_encrypted_rules_never_compile_as_disabled() {
        for envelope in [json!("enc1:invalid"), json!(null), json!(false), json!({})] {
            let raw = Map::from_iter([(KEY_PRIVACY_REDACTION.into(), json!({"enabled":true,"rulesEnc":envelope}))]);
            assert!(compile_raw(&raw).is_err());
        }
    }
}
