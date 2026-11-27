use super::*;

fn policy() -> index::AppIndex {
    serde_json::from_value(json!({"repo":"official/installation-packages", "forceUpdate": {
        "stable":{"minimumVersion":"99.0.0","targetVersion":"99.1.0"},
        "beta":{"minimumVersion":"99.0.0-beta.1","targetVersion":"99.1.0-beta.1"}
    }})).unwrap()
}

#[test]
fn explicit_fork_source_ignores_cached_official_forcing_and_policy_network() {
    crate::test_support::isolated(concat!(module_path!(), "::explicit_fork_source_ignores_cached_official_forcing_and_policy_network"), || {
        std::env::set_var("AGENT2API_UPDATE_REPO", " fork/custom-packages ");
        std::env::set_var("WORKBUDDY_UPDATE_REPO", "legacy/other-packages");
        let manager = UpdateManager::new(crate::test_support::config_dir());
        manager.lock().app_index = policy();
        assert_eq!(manager.repository(), "fork/custom-packages");
        assert!(manager.force_update("1.0.0").is_none());
        assert!(manager.force_update("1.0.0-beta.1").is_none());
        assert_eq!(manager.build_check_result("1.0.0")["pageUrl"], "https://github.com/fork/custom-packages/releases");
        crate::test_support::runtime().block_on(async {
            let status = tokio::time::timeout(std::time::Duration::from_millis(100), manager.refresh_policy("1.0.0")).await.expect("Explicit sources must not contact the official policy service");
            assert_eq!(status["repository"], "fork/custom-packages");
            assert!(status["forceUpdate"].is_null());
        });
    });
}

#[test]
fn legacy_explicit_repository_override_remains_compatible() {
    crate::test_support::isolated(concat!(module_path!(), "::legacy_explicit_repository_override_remains_compatible"), || {
        std::env::set_var("WORKBUDDY_UPDATE_REPO", "legacy/custom-packages");
        let manager = UpdateManager::new(crate::test_support::config_dir());
        manager.lock().app_index = policy();
        assert_eq!(manager.repository(), "legacy/custom-packages");
        assert!(manager.force_update("1.0.0").is_none());
    });
}

#[test]
fn disabled_service_updates_ignore_official_forcing_and_policy_network() {
    crate::test_support::isolated(concat!(module_path!(), "::disabled_service_updates_ignore_official_forcing_and_policy_network"), || {
        for name in ["AGENT2API_SELF_UPDATE", "AGENT2API_SYSTEMD_UPDATE", "AGENT2API_WINDOWS_UPDATE"] {
            std::env::set_var(name, "0");
            let manager = UpdateManager::new(crate::test_support::config_dir());
            manager.lock().app_index = policy();
            assert!(manager.force_update("1.0.0").is_none(), "Disabled service updates must not deny model calls with an official 426 policy: {name}");
            manager.lock().latest = Some(json!({"tag":"99.1.0", "pageUrl":"https://agent2api.dev/downloads"}));
            let display = manager.build_check_result("1.0.0");
            assert!(display["latestVersion"].is_null(), "Disabled installs must not restore cached official releases");
            assert_eq!(display["pageUrl"], "");
            crate::test_support::runtime().block_on(async {
                let status = tokio::time::timeout(std::time::Duration::from_millis(100), manager.refresh_policy("1.0.0")).await.expect("Disabled official app updates must not contact the official policy service");
                assert!(status["forceUpdate"].is_null());
            });
            std::env::remove_var(name);
        }
    });
}

#[test]
fn ordinary_upstream_installs_still_apply_cached_official_policy() {
    crate::test_support::isolated(concat!(module_path!(), "::ordinary_upstream_installs_still_apply_cached_official_policy"), || {
        let manager = UpdateManager::new(crate::test_support::config_dir());
        manager.lock().app_index = policy();
        assert_eq!(manager.force_update("1.0.0").unwrap()["targetVersion"], "99.1.0");
    });
}
