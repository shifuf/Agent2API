use std::collections::BTreeMap;

use crate::server::core::crypto::{self, SecretScope};

pub(crate) struct Opened {
    pub(crate) plaintext: Vec<u8>,
    pub(crate) scope: SecretScope,
}

pub(crate) fn open_with(
    raw: &str,
    mut open: impl FnMut(&str, SecretScope) -> Result<Vec<u8>, String>,
) -> Result<Option<Opened>, String> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    if !crypto::is_envelope(raw) {
        return Err("任务敏感数据必须是加密信封，未读取明文".into());
    }
    for scope in [SecretScope::TaskPlugins, SecretScope::Accounts] {
        if let Ok(plaintext) = open(raw, scope) {
            serde_json::from_slice::<BTreeMap<String, String>>(&plaintext)
                .map_err(|_| "任务加密数据不是有效的文本映射".to_owned())?;
            return Ok(Some(Opened { plaintext, scope }));
        }
    }
    Err("任务敏感数据解密失败，请恢复原 task-plugins.key 或 account.key 后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_account_ciphertext_opens_and_new_values_use_task_scope() {
        crate::test_support::isolated(concat!(module_path!(), "::legacy_account_ciphertext_opens_and_new_values_use_task_scope"), || {
            let plain = br#"{"cookie":"fixture"}"#;
            let old = crypto::seal(plain, SecretScope::Accounts).unwrap();
            let opened = open_with(&old, crypto::open).unwrap().unwrap();
            assert!(matches!(opened.scope, SecretScope::Accounts));
            assert_eq!(opened.plaintext, plain);
            let rewritten = crypto::seal(&opened.plaintext, SecretScope::TaskPlugins).unwrap();
            let opened = open_with(&rewritten, crypto::open).unwrap().unwrap();
            assert!(matches!(opened.scope, SecretScope::TaskPlugins));
            assert_eq!(opened.plaintext, plain);
            assert!(crypto::open(&rewritten, SecretScope::Accounts).is_err());
        });
    }

    #[test]
    fn empty_values_stay_empty_and_bad_values_fail_closed() {
        assert!(open_with("", |_, _| panic!("empty data must not load a key")).unwrap().is_none());
        assert!(open_with("{}", |_, _| panic!("plaintext must not be opened")).is_err());
        assert!(open_with("enc1:invalid", |_, _| Err("unreadable".into())).is_err());
        assert!(open_with("enc1:fixture", |_, _| Ok(br#"{"cookie":42}"#.to_vec())).is_err());
    }
}
