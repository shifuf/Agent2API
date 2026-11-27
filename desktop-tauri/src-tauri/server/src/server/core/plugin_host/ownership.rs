use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::install::{self, InstalledPack, PackRegistry};

fn failed_packs() -> &'static Mutex<BTreeMap<String, (String, String)>> {
    static FAILED: OnceLock<Mutex<BTreeMap<String, (String, String)>>> = OnceLock::new();
    FAILED.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub(super) fn record_start(pack: &InstalledPack, success: bool) {
    if let Ok(mut failed) = failed_packs().lock() {
        if success { failed.remove(&pack.id); }
        else { failed.insert(pack.id.clone(), (pack.version.clone(), pack.sha256.clone())); }
    }
}

fn failed(pack: &InstalledPack) -> bool {
    failed_packs().lock().is_ok_and(|failed| failed.get(&pack.id)
        .is_some_and(|identity| identity == &(pack.version.clone(), pack.sha256.clone())))
}

pub(super) fn unavailable_reason(pack: &InstalledPack) -> Option<String> {
    super::support::legacy_reason(pack).or_else(|| suspended_reason(pack))
}
pub(super) fn suspended_reason(pack: &InstalledPack) -> Option<String> {
    if super::support::installed_state(pack) != super::PackSupportState::Supported || pack.manifest_providers.is_empty()
        || pack.manifest_providers.iter().any(|provider|
            !crate::server::core::providers::availability::is_suspended(provider.id.as_str())) {
        return None;
    }
    if pack.manifest_providers.iter().all(|provider|
        crate::server::core::providers::availability::is_replaced_by_template(provider.id.as_str())) {
        return Some("Cline 订阅池已改为软件内置「Cline Pass」API 模板，无需再安装或运行此插件；请前往「添加账号 → API 模板」使用 Cline Pass。".into());
    }
    Some("插件文件已安装，但该提供商目前暂停开放，不会启动或参与转发；恢复开放后可重新启用。".into())
}

pub(super) fn reserved(id: &str) -> bool {
    crate::server::core::providers::availability::BUILTIN_SUBSCRIPTION_IDS.contains(&id)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCategory {
    #[default]
    Agent,
    Web,
}

pub(super) fn category(dir: &Path) -> ProviderCategory {
    std::fs::read_to_string(dir.join("pack.json")).ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|manifest| manifest.get("provider_category").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub(super) fn owners(registry: &PackRegistry) -> BTreeMap<String, String> {
    owners_with(registry, None)
}

pub(super) fn owners_with(registry: &PackRegistry, prepared: Option<&InstalledPack>) -> BTreeMap<String, String> {
    owners_using(registry, prepared, &super::script::package_for_provider)
}

pub(super) fn display_owners(registry: &PackRegistry, scripts: &std::collections::HashMap<String, String>) -> BTreeMap<String, String> {
    owners_using(registry, None, &|provider| scripts.get(provider).cloned())
}

fn owners_using(registry: &PackRegistry, prepared: Option<&InstalledPack>, script_owner: &impl Fn(&str) -> Option<String>) -> BTreeMap<String, String> {
    owners_using_policy(registry, prepared, script_owner, &replaces_legacy)
}

fn owners_using_policy(registry: &PackRegistry, prepared: Option<&InstalledPack>,
    script_owner: &impl Fn(&str) -> Option<String>,
    replaces: &impl Fn(&InstalledPack, &InstalledPack, bool) -> bool,
) -> BTreeMap<String, String> {
    let mut owners = BTreeMap::new();
    for pack in registry.packs.iter().filter(|pack| !pack.entry.ends_with(".wasm"))
        .chain(registry.packs.iter().filter(|pack| pack.entry.ends_with(".wasm"))) {
        let prepared = prepared.filter(|item| item.id == pack.id);
        let source = prepared.unwrap_or(pack);
        let supported = super::support::installed_state(source) == super::PackSupportState::Supported;
        if !supported { continue; }
        for provider in source.manifest_providers.iter().map(|item| item.id.as_str()) {
            if !reserved(provider) && !crate::server::core::providers::availability::is_suspended(provider)
                && script_owner(provider).is_none() {
                let previous = owners.get(provider).and_then(|id| registry.packs.iter().find(|pack| &pack.id == id));
                if previous.is_none() || previous.is_some_and(|previous|
                    replaces(source, previous, prepared.is_some()) && (prepared.is_some() || !failed(source))) {
                    owners.insert(provider.to_string(), pack.id.clone());
                }
            }
        }
    }
    owners
}

pub(super) fn replaces_legacy(replacement: &InstalledPack, previous: &InstalledPack, prepared: bool) -> bool {
    if !matches!(previous.id.as_str(), "agent2api-providers" | "agent2api-web-providers")
        || !previous.signed || !replacement.signed || !replacement.entry.ends_with(".wasm")
        || replacement.manifest_providers.len() != 1
        || replacement.id != format!("agent2api-wasm-{}", replacement.manifest_providers[0].id.as_str()) {
        return false;
    }
    let verified = |pack: &InstalledPack| {
        let dir = install::plugins_dir().join(&pack.id).join(&pack.version);
        install::read_manifest(&dir).ok().is_some_and(|manifest| manifest.id == pack.id
            && manifest.version == pack.version
            && install::verify_signature(&dir, &manifest, &super::host_target()).0 == install::SignatureState::Verified)
    };
    verified(previous) && (prepared || verified(replacement))
}

pub(super) fn overridden_by(owners: &BTreeMap<String, String>, pack: &str, provider: &str) -> Option<String> {
    super::script::package_for_provider(provider)
        .or_else(|| owners.get(provider).cloned())
        .filter(|owner| owner != pack)
}

pub(super) fn declared_ids(pack: &InstalledPack) -> Vec<String> {
    let dir = install::plugins_dir().join(&pack.id).join(&pack.version);
    install::read_manifest(&dir).map(|manifest| manifest.providers)
        .unwrap_or_else(|_| pack.manifest_providers.clone())
        .into_iter().map(|provider| provider.id.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack(id: &str, entry: &str) -> InstalledPack {
        serde_json::from_value(json!({
            "id": id, "version": "0.1.1", "enabled": true, "providers": {},
            "entry": entry, "sha256": "", "signed": false, "installed_at": 0,
            "manifest_providers": [{ "id": "raccoon", "label": "Raccoon", "order": 0, "default_enabled": true }]
        })).unwrap()
    }

    #[test]
    fn native_owner_survives_unsigned_wasm_claim() {
        let native = pack("agent2api-providers", "bin/plugin.exe");
        let wasm = pack("agent2api-wasm-raccoon", "plugin.wasm");
        let registry = PackRegistry { packs: vec![native, wasm] };
        let owners = owners_using(&registry, None, &|_| None);
        assert_eq!(owners.get("raccoon").map(String::as_str), Some("agent2api-providers"));
    }

    #[test]
    fn standalone_native_has_provider_owner() {
        let registry = PackRegistry { packs: vec![pack("native-raccoon", "bin/plugin.exe")] };
        assert_eq!(owners_using(&registry, None, &|_| None).get("raccoon").map(String::as_str), Some("native-raccoon"));
    }

    #[test]
    fn failed_wasm_returns_to_verified_legacy_until_recovered() {
        let native = pack("agent2api-providers", "bin/plugin.exe");
        let mut wasm = pack("agent2api-wasm-raccoon-fallback-fixture", "plugin.wasm");
        let trusted = |_: &InstalledPack, _: &InstalledPack, _: bool| true;
        let registry = PackRegistry { packs: vec![native.clone(), wasm.clone()] };
        let selected = || owners_using_policy(&registry, None, &|_| None, &trusted)
            .get("raccoon").cloned().unwrap();
        assert_eq!(selected(), wasm.id);
        record_start(&wasm, false);
        assert_eq!(selected(), native.id);
        let display = owners_using_policy(&registry, None, &|_| None, &trusted);
        assert_eq!(display.get("raccoon"), Some(&native.id));
        wasm.version = "0.1.2".into();
        let updated = PackRegistry { packs: vec![native, wasm.clone()] };
        assert_eq!(owners_using_policy(&updated, None, &|_| None, &trusted).get("raccoon"), Some(&wasm.id));
        record_start(&registry.packs[1], true);
        assert_eq!(selected(), registry.packs[1].id);
    }

    #[test]
    fn disabled_wasm_retains_owner_without_failure_fallback() {
        let native = pack("agent2api-providers", "bin/plugin.exe");
        let mut wasm = pack("agent2api-wasm-raccoon-disabled-fixture", "plugin.wasm");
        wasm.enabled = false;
        let registry = PackRegistry { packs: vec![native, wasm.clone()] };
        let owners = owners_using_policy(&registry, None, &|_| None, &|_, _, _| true);
        assert_eq!(owners.get("raccoon"), Some(&wasm.id));
    }
}
