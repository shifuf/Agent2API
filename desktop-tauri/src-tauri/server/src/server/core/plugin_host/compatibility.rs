//! 插件兼容性取决于实际协议、入口和宿主能力，不取决于网关的产品版本。

use super::install::{self, InstalledPack, PackRegistry, SignatureState};

pub(super) fn pack_error(pack: &InstalledPack) -> Option<String> {
    let dir = install::plugins_dir().join(&pack.id).join(&pack.version);
    let manifest = match install::read_manifest(&dir) {
        Ok(manifest) => manifest,
        Err(error) => return Some(error),
    };
    if manifest.id != pack.id || manifest.version != pack.version {
        return Some("插件清单与安装登记不一致，请重新安装插件包".into());
    }
    if let Err(error) = install::validate_manifest(&manifest, agent2api_provider_protocol::PROTOCOL_VERSION) {
        return Some(error);
    }
    if let Err(error) = super::wasm::manifest::read(&dir, &manifest) {
        return Some(error);
    }
    let Some(target) = install::target_for_manifest(&manifest, &super::host_target()) else {
        return Some("插件包没有为当前网关平台提供入口".into());
    };
    let Some(entry) = manifest.entry.get(&target) else {
        return Some("插件入口不存在".into());
    };
    if let Err(error) = super::wasm::manifest::checked_entry(&dir, entry) {
        return Some(error);
    }
    let (signature, error) = install::verify_signature(&dir, &manifest, &target);
    if signature == SignatureState::Invalid {
        return Some(format!("签名校验失败：{}", error.unwrap_or_default()));
    }
    if pack.signed && signature != SignatureState::Verified {
        return Some("已签名插件没有适用于当前入口的签名，请重新安装插件包".into());
    }
    None
}

pub(crate) fn provider_error(provider: &str) -> Option<String> {
    let registry = PackRegistry::load();
    // 运行中的旧执行体优先；未能启动的新包不能使旧账号被错误标为不兼容。
    let loaded = super::runtime::provider_pack(provider);
    let owners = super::ownership::owners(&registry);
    let id = loaded.as_ref().or_else(|| owners.get(provider))?;
    let pack = registry.packs.iter().find(|pack| &pack.id == id)?;
    pack_error(pack)
}
