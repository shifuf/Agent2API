//! A narrow correction for the verified Raccoon WASM 0.1.1 native tool catalog.
//!
//! On 2026-11-25 the unchanged official guest and the real enabled account both
//! accepted native tools and client results for these two IDs, while the guest
//! catalog still declared false. This does not enable emulation or other models.
//! The rule is bound to this host's freshly checked signature and exact version;
//! raw cache and user capability overrides remain separate.
use serde_json::{json, Value};

use super::HostOptions;
use super::super::{install, wasm};

#[derive(Clone, Default)]
pub(super) struct NativeModelCompatibility {
    raccoon_tools: bool,
}

impl NativeModelCompatibility {
    pub(super) fn for_options(provider: &str, options: &HostOptions) -> Self {
        if provider != "raccoon" || options.wasm.is_none() {
            return Self::default();
        }
        let Some(dir) = options.exe.parent() else { return Self::default() };
        let Ok(manifest) = install::read_manifest(dir) else { return Self::default() };
        let matches = manifest.version == "0.1.1" && manifest.providers.len() == 1
            && manifest.providers[0].id.as_str() == provider
            && manifest.entry.get(wasm::manifest::TARGET)
                .is_some_and(|entry| dir.join(entry) == options.exe);
        let verified = matches && install::verify_signature(dir, &manifest, wasm::manifest::TARGET).0
            == install::SignatureState::Verified;
        Self { raccoon_tools: verified }
    }

    pub(super) fn apply(&self, models: &mut [Value]) {
        if !self.raccoon_tools { return; }
        for model in models {
            if crate::server::core::providers::images::model_is_image(model) { continue; }
            let Some(id) = model.get("id").and_then(Value::as_str) else { continue };
            if !["sn-glm-5-3-flash", "sn-deepseek-v4-1-flash-1017"].iter()
                .any(|verified| id.eq_ignore_ascii_case(verified)) { continue; }
            model["supportsToolCall"] = json!(true);
            model["toolCallingMode"] = json!("native");
            if !model["capSources"].is_object() { model["capSources"] = json!({}); }
            model["capSources"]["supportsToolCall"] = json!("gateway");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_raccoon_host_keeps_declared_tool_capability() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("raccoon.wasm"), b"unsigned fixture").unwrap();
        std::fs::write(dir.path().join("pack.json"), json!({
            "id":"unsigned-raccoon-fixture","name":"Unsigned fixture","version":"0.1.1","protocol":1,
            "providers":[{"id":"raccoon","label":"Raccoon","order":0}],
            "entry":{"wasm32-unknown-unknown":"raccoon.wasm"}
        }).to_string()).unwrap();
        std::fs::write(dir.path().join("wasm.json"), json!({
            "abi":1,"requires":["http.v1","chat.stream.v1"],"origins":["https://xiaohuanxiong.com"]
        }).to_string()).unwrap();
        let manifest = install::read_manifest(dir.path()).unwrap();
        let mut options = HostOptions::new(dir.path().join("raccoon.wasm"));
        options.wasm = wasm::manifest::read(dir.path(), &manifest).unwrap();
        let compatibility = NativeModelCompatibility::for_options("raccoon", &options);
        let mut models = vec![json!({"id":"sn-glm-5-3-flash","supportsToolCall":false})];
        compatibility.apply(&mut models);
        assert_eq!(models[0]["supportsToolCall"], false);
        assert!(models[0].get("toolCallingMode").is_none());
    }

    #[test]
    fn verified_native_rule_does_not_promote_other_models_or_images() {
        let compatibility = NativeModelCompatibility { raccoon_tools: true };
        let mut models = vec![
            json!({"id":"sn-glm-5-3-flash","supportsToolCall":false}),
            json!({"id":"sn-sensenova-6-8-flash","supportsToolCall":false}),
            json!({"id":"sn-deepseek-v4-1-flash-1017","kind":"image","supportsToolCall":false}),
        ];
        compatibility.apply(&mut models);
        assert_eq!(models[0]["supportsToolCall"], true);
        assert_eq!(models[0]["toolCallingMode"], "native");
        assert_eq!(models[1]["supportsToolCall"], false);
        assert_eq!(models[2]["supportsToolCall"], false);
    }
}
