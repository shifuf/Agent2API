//! Daily upload policy shared by the worker and successful manual operations.
use std::collections::BTreeSet;
use serde::{Deserialize, Serialize};
use super::settings::CloudSyncSettings;
const DAY_MS: i64 = 86_400_000;
const UTC8_MS: i64 = 28_800_000;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadState {
    pub scope: String,
    pub uploaded_at: i64,
    pub account_ids: BTreeSet<String>,
    pub key_fingerprint: Option<String>,
}
pub(crate) fn day_number(now: i64) -> i64 { now.saturating_add(UTC8_MS).div_euclid(DAY_MS) }
pub(crate) fn day_label(now: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now.saturating_add(UTC8_MS))
        .map(|date| date.format("%Y-%m-%d").to_string()).unwrap_or_default()
}
pub(crate) fn target_scope(settings: &CloudSyncSettings) -> String {
    let remote = match settings.provider.as_str() {
        super::settings::PROVIDER_S3 => serde_json::json!([
            settings.s3.endpoint.trim_end_matches('/'), settings.s3.bucket,
            settings.s3.region, settings.s3.access_key_id, settings.s3.secret_access_key]),
        _ => serde_json::json!([settings.webdav.base_url.trim_end_matches('/'),
            settings.webdav.username, settings.webdav.password]),
    };
    super::sha256_hex(serde_json::json!([settings.provider,
        settings.remote_root.trim_matches('/'),settings.profile,remote,settings.sync_password]).to_string().as_bytes())
}
pub(crate) fn should_upload(state: Option<&UploadState>, scope: &str, now: i64,
    ids: &BTreeSet<String>, fingerprint: &Option<String>) -> bool {
    let Some(state) = state else { return true };
    state.scope != scope || day_number(state.uploaded_at) != day_number(now)
        || state.key_fingerprint != *fingerprint
        || ids.iter().any(|id| !state.account_ids.contains(id))
}
pub(crate) fn expired_day(name: &str, now: i64) -> bool {
    let Ok(date) = chrono::NaiveDate::parse_from_str(name, "%Y-%m-%d") else { return false };
    if date.format("%Y-%m-%d").to_string() != name { return false }
    let Some(midnight) = date.and_hms_opt(0, 0, 0) else { return false };
    midnight.and_utc().timestamp_millis().div_euclid(DAY_MS) < day_number(now) - 6
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ids(values: &[&str]) -> BTreeSet<String> { values.iter().map(|v|v.to_string()).collect() }
    fn state() -> UploadState { UploadState { scope: "dav-one".into(), uploaded_at: 1_795_536_000_000,
        account_ids: ids(&["a","b"]), key_fingerprint: Some("key".into()) } }
    #[test] fn routine_updates_and_deletions_do_not_upload_within_day() {
        let s=state(); assert!(!should_upload(Some(&s),"dav-one",s.uploaded_at+1000,&ids(&["a","b"]),&s.key_fingerprint));
        assert!(!should_upload(Some(&s),"dav-one",s.uploaded_at+1000,&ids(&["a"]),&s.key_fingerprint));
    }
    #[test] fn new_id_at_same_account_count_uploads() { let s=state(); assert!(should_upload(Some(&s),"dav-one",s.uploaded_at+1000,&ids(&["a","c"]),&s.key_fingerprint)); }
    #[test] fn next_day_without_changes_uploads() { let s=state(); assert!(should_upload(Some(&s),"dav-one",s.uploaded_at+DAY_MS,&s.account_ids,&s.key_fingerprint)); }
    #[test] fn restart_uses_persisted_success() { let s=state();let persisted:UploadState=serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();assert!(!should_upload(Some(&persisted),"dav-one",s.uploaded_at+1000,&s.account_ids,&s.key_fingerprint)); }
    #[test] fn target_and_key_changes_upload() { let s=state();assert!(should_upload(Some(&s),"dav-two",s.uploaded_at,&s.account_ids,&s.key_fingerprint));assert!(should_upload(Some(&s),"dav-one",s.uploaded_at,&s.account_ids,&Some("other".into()))); }
    #[test] fn retention_keeps_seven_calendar_days_and_foreign_names() {
        let now=chrono::DateTime::parse_from_rfc3339("2026-11-25T09:00:00+08:00").unwrap().timestamp_millis();
        assert!(expired_day("2026-11-18",now));assert!(!expired_day("2026-11-19",now));assert!(!expired_day("2026-11-25",now));assert!(!expired_day("2026-11-26",now));
        for v in ["notes","2026-11-01-extra","2026-02-30","2026-1-01","../2026-01-01"] { assert!(!expired_day(v,now)); }
    }
}
