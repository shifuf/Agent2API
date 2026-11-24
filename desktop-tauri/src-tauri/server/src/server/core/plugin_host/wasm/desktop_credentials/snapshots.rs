use agent2api_provider_protocol as proto;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{absolute_env, app_data, content, database, home, invalid, object, project};

pub(super) fn workbuddy(provider: &str) -> Result<Value, proto::WireError> {
    #[cfg(windows)]
    let base = absolute_env("LOCALAPPDATA").ok_or_else(invalid)?;
    #[cfg(target_os = "macos")]
    let base = home()?.join("Library/Application Support");
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = home()?.join(".local/share");
    let root = base.join("CodeBuddyExtension/Data/Public/auth");
    let prefix = if provider == "workbuddy-intl" {
        "workbuddy-desktop-ai"
    } else {
        "workbuddy-desktop"
    };
    let current = root.join(format!("{prefix}.info"));
    let path = if current.exists() {
        current
    } else {
        let entries = std::fs::read_dir(&root)
            .map_err(|_| invalid())?
            .take(2049)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|_| invalid())?;
        if entries.len() > 2048 {
            return Err(invalid());
        }
        let mut files = entries
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(&format!("{prefix}.")) && name.ends_with(".info")
                    })
            })
            .collect::<Vec<_>>();
        files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        files.into_iter().next().ok_or_else(invalid)?
    };
    let value = object(&path, 256 * 1024)?;
    let account_keys = [
        "uid",
        "nickname",
        "type",
        "enterpriseId",
        "enterpriseName",
        "departmentFullName",
        "oneidAccountId",
        "idp",
    ];
    let auth_keys = [
        "accessToken",
        "access_token",
        "token",
        "refreshToken",
        "refresh_token",
        "expiresAt",
        "expires_at",
        "refreshExpiresAt",
        "refresh_expires_at",
        "domain",
        "tokenType",
    ];
    let mut result = project(&value, &["edition", "endpoint", "prefixPath", "platform"]);
    for (group, keys) in [("account", &account_keys[..]), ("auth", &auth_keys[..])] {
        let mut fields = project(&value[group], keys);
        // 官方嵌套字段优先；混合导出只补缺值，不把其他账号或地区字段拼入。
        for key in keys {
            let aliases: &[&str] = match (group, *key) {
                ("auth", "accessToken" | "access_token" | "token") => &["accessToken", "access_token", "token"],
                ("auth", "refreshToken" | "refresh_token") => &["refreshToken", "refresh_token"],
                ("auth", "expiresAt" | "expires_at") => &["expiresAt", "expires_at"],
                ("auth", "refreshExpiresAt" | "refresh_expires_at") => &["refreshExpiresAt", "refresh_expires_at"],
                _ => std::slice::from_ref(key),
            };
            if aliases.iter().any(|alias| value[group].get(*alias).is_some_and(|field| {
                !field.is_null() && !field.as_str().is_some_and(|text| text.trim().is_empty())
            })) {
                continue;
            }
            if let Some(field) = value.get(*key) {
                fields[*key] = field.clone();
            }
        }
        result[group] = fields;
    }
    content(&path, result)
}

