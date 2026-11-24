use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::install::{self, InstalledPack, PackRegistry};

pub(super) const WEB_PACK_ID: &str = "agent2api-web-providers";
const LEGACY_PACK_ID: &str = "agent2api-providers";

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
    owners_excluding(registry, prepared, &BTreeSet::new())
}

pub(super) fn owners_excluding(
    registry: &PackRegistry,
    prepared: Option<&InstalledPack>,
    failed: &BTreeSet<String>,
) -> BTreeMap<String, String> {
    let mut owners = BTreeMap::new();
    for pack in registry.packs.iter().filter(|pack| pack.enabled && !failed.contains(&pack.id)) {
        let ids = match prepared.filter(|prepared| prepared.id == pack.id) {
            Some(prepared) => prepared.manifest_providers.iter().map(|provider| provider.id.0.clone()).collect(),
            None => declared_ids(pack),
        };
        for provider in ids.into_iter().filter(|id| {
            !reserved(id) && !crate::server::core::providers::availability::is_suspended(id)
        }) {
            owners.entry(provider).or_insert_with(|| pack.id.clone());
        }
    }
    // 用户停用新执行体时仍保留停用意图；只有实际启动失败才尝试兼容旧包。
    if registry.packs.iter().any(|pack| pack.id == WEB_PACK_ID && !failed.contains(&pack.id))
        && trusted_legacy_owner(registry, prepared, WEB_PACK_ID)
        && owners.get("chatglm").is_none_or(|owner| owner == WEB_PACK_ID
            || trusted_legacy_owner(registry, prepared, owner)) {
        owners.insert("chatglm".to_string(), WEB_PACK_ID.to_string());
    }
    for installed in &registry.packs {
        let pack = prepared.filter(|pack| pack.id == installed.id).unwrap_or(installed);
        if failed.contains(&pack.id) { continue; }
        let Some(provider) = official_wasm_provider(pack) else { continue };
        if reserved(provider) || crate::server::core::providers::availability::is_suspended(provider) { continue; }
        // 签名独立包只能自动承接已知的配套旧包，不能覆盖其它来源的执行体。
        if owners.get(provider).is_none_or(|owner| owner == &pack.id
            || trusted_legacy_owner(registry, prepared, owner)) {
            owners.insert(provider.to_string(), pack.id.clone());
        }
    }
    owners
}

fn is_legacy_pack(id: &str) -> bool {
    matches!(id, LEGACY_PACK_ID | WEB_PACK_ID)
}

fn trusted_legacy_owner(registry: &PackRegistry, prepared: Option<&InstalledPack>, id: &str) -> bool {
    if !is_legacy_pack(id) { return false; }
    // prepared 只来自 packages::prepare 完成验签的结果，尚未 install_pending；
    // 不能从最终目录是否存在推断这份真实预安装来源的可信状态。
    if let Some(pack) = prepared.filter(|pack| pack.id == id) { return pack.signed; }
    let Some(pack) = registry.packs.iter().find(|pack| pack.id == id && pack.signed) else { return false; };
    let dir = install::plugins_dir().join(&pack.id).join(&pack.version);
    let Ok(manifest) = install::read_manifest(&dir) else { return false; };
    manifest.id == pack.id && manifest.version == pack.version
        && install::verify_signature(&dir, &manifest, &super::rpc::target_triple()).0 == install::SignatureState::Verified
}

pub(super) fn official_wasm_provider(pack: &InstalledPack) -> Option<&str> {
    if !pack.signed || !pack.entry.ends_with(".wasm") || pack.manifest_providers.len() != 1 { return None; }
    let provider = pack.manifest_providers[0].id.as_str();
    (pack.id == format!("agent2api-wasm-{provider}")).then_some(provider)
}

pub(super) fn startup_packs(registry: &PackRegistry) -> Vec<&InstalledPack> {
    let mut packs: Vec<_> = registry.packs.iter().filter(|pack| pack.enabled).collect();
    packs.sort_by_key(|pack| {
        if official_wasm_provider(pack).is_some() { 0 }
        else if pack.id == WEB_PACK_ID { 1 }
        else if pack.id == LEGACY_PACK_ID { 3 }
        else { 2 }
    });
    packs
}

pub(super) fn declared_ids(pack: &InstalledPack) -> Vec<String> {
    let dir = install::plugins_dir().join(&pack.id).join(&pack.version);
    install::read_manifest(&dir).map(|manifest| manifest.providers)
        .unwrap_or_else(|_| pack.manifest_providers.clone())
        .into_iter().map(|provider| provider.id.0).collect()
}

pub(super) fn migrated_enabled(registry: &PackRegistry, pack: &str, provider: &str) -> Option<bool> {
    let independent = pack == format!("agent2api-wasm-{provider}");
    if !independent && (pack != WEB_PACK_ID || provider != "chatglm") { return None; }
    let owners = owners(registry);
    let owner = owners.get(provider).map(String::as_str).unwrap_or(LEGACY_PACK_ID);
    registry.packs.iter().find(|pack| pack.id == owner && is_legacy_pack(&pack.id))
        .map(|pack| pack.enabled && pack.providers.get(provider).copied().unwrap_or(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read, Write};

    fn altered_zip(bytes: &[u8], unsigned: bool) -> Vec<u8> {
        let mut source = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let manifest: serde_json::Value = serde_json::from_reader(source.by_name("pack.json").unwrap()).unwrap();
        let entries: std::collections::HashSet<_> = manifest["entry"].as_object().unwrap().values()
            .map(|entry| entry.as_str().unwrap().to_string()).collect();
        let mut target = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..source.len() {
            let mut file = source.by_index(index).unwrap();
            if file.is_dir() { continue; }
            let mut content = Vec::new(); file.read_to_end(&mut content).unwrap();
            if file.name() == "pack.json" {
                let mut manifest: serde_json::Value = serde_json::from_slice(&content).unwrap();
                if unsigned { manifest.as_object_mut().unwrap().remove("signature"); }
                content = serde_json::to_vec(&manifest).unwrap();
            }
            if !unsigned && entries.contains(file.name()) { content.push(0); }
            target.start_file(file.name(), zip::write::SimpleFileOptions::default()).unwrap();
            target.write_all(&content).unwrap();
        }
        target.finish().unwrap().into_inner()
    }

    #[test]
    #[ignore = "requires real official native/WASM ZIP files and an explicit isolated temporary home"]
    fn real_signatures_prevent_unsigned_legacy_id_takeover() {
        let (_, store) = super::super::wasm::test_support::isolated_store();
        let catpaw_path = std::path::PathBuf::from(std::env::var_os("AGENT2API_TEST_CATPAW_ZIP").unwrap());
        let root = catpaw_path.parent().unwrap();
        let legacy_bytes = std::fs::read(root.join("agent2api-providers-3.5.0-beta.1-x86_64-pc-windows-msvc.zip")).unwrap();
        let legacy = install::install_zip(&legacy_bytes).expect("actual official native signature");
        assert!(legacy.signed);
        let wasm = install::install_zip(&std::fs::read(catpaw_path).unwrap()).expect("actual official WASM signature");
        assert!(wasm.signed);
        let account = store.plugin_upsert_account("ownership-test-user", "catpaw", "retained account",
            &serde_json::json!({"uid":"ownership-test-user","accessToken":"fixture-secret"}), &serde_json::json!({}), false).unwrap();
        assert_eq!(owners(&PackRegistry::load()).get("catpaw").map(String::as_str), Some("agent2api-wasm-catpaw"));
        assert!(install::install_zip(&altered_zip(&legacy_bytes, false)).is_err(), "changed signed content must fail the production verifier");
        let unsigned = install::install_zip(&altered_zip(&legacy_bytes, true)).expect("third-party unsigned manual install remains permitted");
        assert!(!unsigned.signed);
        let mut registry = PackRegistry::load();
        assert_eq!(owners(&registry).get("catpaw").map(String::as_str), Some(LEGACY_PACK_ID), "same legacy ID does not grant official inheritance");
        registry.packs.iter_mut().find(|pack| pack.id == LEGACY_PACK_ID).unwrap().signed = true;
        assert_eq!(owners(&registry).get("catpaw").map(String::as_str), Some(LEGACY_PACK_ID), "forged stored signed flag cannot replace actual verification");
        let persisted = store.plugin_host_account(account["id"].as_str().unwrap()).unwrap();
        assert_eq!(persisted.secret["accessToken"], "fixture-secret");
    }
}
