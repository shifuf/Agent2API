use std::sync::Arc;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use crate::server::core::prompt::rules::{self, CompiledRule, Matcher, Rule};
use crate::server::errors::GatewayError;

pub const KEY: &str = "promptRules";

#[derive(Default, Debug)]
pub struct Snapshot { pub rules: Vec<CompiledRule>, pub error: Option<String>, pub revision: String }

fn revision(value: &Value) -> String { format!("{:x}", Sha256::digest(value.to_string().as_bytes())) }

pub fn compile(rules: Vec<Rule>) -> Result<Vec<CompiledRule>, String> {
    rules::validate_rules(&rules)?;
    rules.into_iter().map(|rule| {
        if !rule.file.trim().is_empty() { return Err("条件提示词使用内联正文；文件提示词请在原有系统提示词设置中配置".into()); }
        let matchers = rule.conditions.iter().map(Matcher::compile).collect::<Result<Vec<_>, _>>()?;
        let choice = super::resolve_choice(rule.mode, None, Some(rule.text.clone()).filter(|text| !text.trim().is_empty()));
        let prompt = super::ProviderPrompt { mode: choice.mode, file: choice.file, inline: choice.inline, text: choice.text, source: choice.source, file_error: choice.file_error };
        Ok(CompiledRule { rule, prompt, matchers })
    }).collect()
}

pub(super) fn from_raw(raw: &Map<String, Value>) -> Arc<Snapshot> {
    let value = raw.get(KEY).unwrap_or(&Value::Null);
    let parsed = if value.is_null() { Ok(Vec::new()) } else { serde_json::from_value(value.clone()).map_err(|error| format!("{error}")) };
    let (rules, error) = match parsed.and_then(compile) { Ok(rules) => (rules, None), Err(error) => (Vec::new(), Some(error)) };
    Arc::new(Snapshot { rules, error, revision: revision(value) })
}

pub fn save(rules: Vec<Rule>, expected: &str) -> Result<(), GatewayError> {
    let value = serde_json::to_value(&rules).map_err(|error| GatewayError::new(error.to_string()))?;
    compile(rules).map_err(GatewayError::bad_request)?;
    super::try_update_raw_field(KEY, |stored| {
        if revision(stored) != expected { return Err(GatewayError::with_status(409, "条件提示词已在其他位置修改，请重新读取")); }
        *stored = value; Ok(())
    }, || GatewayError::new("条件提示词保存失败"))
}
