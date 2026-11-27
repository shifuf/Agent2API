use std::{collections::HashMap, sync::Mutex};

use regex::Regex;
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use super::{Rules, REJECTED, UNAVAILABLE};

pub struct Vault {
    prefix: String,
    detector: Regex,
    slots: Mutex<Slots>,
    lifetime: std::sync::Arc<()>,
}
#[derive(Default)]
struct Slots {
    values: HashMap<String, Zeroizing<String>>,
    tokens: HashMap<String, String>,
    size: usize,
}

impl Drop for Slots {
    fn drop(&mut self) {
        for (mut secret, _) in self.tokens.drain() {
            secret.zeroize();
        }
    }
}

impl Vault {
    pub fn new(rules: &Rules) -> Result<Self, &'static str> {
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| UNAVAILABLE)?;
        let nonce: String = random
            .iter()
            .flat_map(|byte| {
                [
                    char::from(b'a' + (byte >> 4)),
                    char::from(b'a' + (byte & 15)),
                ]
            })
            .collect();
        Ok(Self {
            prefix: format!("[[A2P:{nonce}:"),
            detector: rules.detector()?,
            slots: Mutex::new(Slots::default()),
            lifetime: Default::default(),
        })
    }
    pub fn prefix(&self) -> &str {
        &self.prefix
    }
    pub(crate) fn log_scope(&self) -> std::sync::Weak<()> {
        std::sync::Arc::downgrade(&self.lifetime)
    }
    pub fn matches(&self, text: &str) -> bool {
        self.detector.is_match(text)
    }
    fn replace_segment(
        &self,
        text: &str,
        slots: &mut Slots,
        output: &mut String,
    ) -> Result<(), &'static str> {
        let mut last = 0;
        for hit in self.detector.find_iter(text) {
            let raw = hit.as_str();
            if raw.len() > 4096 {
                return Err(REJECTED);
            }
            output.push_str(&text[last..hit.start()]);
            if let Some(token) = slots.tokens.get(raw) {
                output.push_str(token);
            } else {
                if slots.values.len() >= 1024 || slots.size + raw.len() > 1024 * 1024 {
                    return Err(REJECTED);
                }
                let token = format!("{}{:04x}]]", self.prefix, slots.values.len());
                if self.matches(&token) {
                    return Err(REJECTED);
                }
                slots.size += raw.len();
                slots.tokens.insert(raw.to_owned(), token.clone());
                output.push_str(&token);
                slots.values.insert(token, Zeroizing::new(raw.to_owned()));
            }
            last = hit.end();
            if output.len() > 8 * 1024 * 1024 {
                return Err(REJECTED);
            }
        }
        output.push_str(&text[last..]);
        Ok(())
    }
    pub fn mask(&self, text: &str) -> Result<String, &'static str> {
        let mut slots = self.slots.lock().map_err(|_| UNAVAILABLE)?;
        let mut output = String::new();
        let mut remaining = text;
        while let Some(start) = remaining.find(&self.prefix) {
            self.replace_segment(&remaining[..start], &mut slots, &mut output)?;
            let size = self.prefix.len() + 6;
            let token = remaining.get(start..start + size).ok_or(REJECTED)?;
            if !slots.values.contains_key(token) {
                return Err(REJECTED);
            }
            output.push_str(token);
            remaining = &remaining[start + size..];
        }
        self.replace_segment(remaining, &mut slots, &mut output)?;
        Ok(output)
    }
    pub fn mask_json(&self, value: &mut Value) -> Result<(), &'static str> {
        self.walk(value, "")
    }
    fn walk(&self, value: &mut Value, field: &str) -> Result<(), &'static str> {
        match value {
            Value::String(text)
                if text.starts_with("data:")
                    || (field == "type"
                        && matches!(
                            text.as_str(),
                            "image"
                                | "image_url"
                                | "input_image"
                                | "input_audio"
                                | "input_video"
                                | "file"
                                | "input_file"
                                | "document"
                                | "base64"
                        )) =>
            {
                return Err(REJECTED)
            }
            Value::String(text) if field == "arguments" => {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(text) {
                    self.walk(&mut parsed, "")?;
                    *text = serde_json::to_string(&parsed).map_err(|_| REJECTED)?;
                } else if self.matches(text) || text.contains('\\') {
                    return Err(REJECTED);
                }
            }
            Value::String(text) if self.matches(text) => {
                if matches!(
                    field,
                    "model"
                        | "role"
                        | "type"
                        | "id"
                        | "name"
                        | "tool_call_id"
                        | "call_id"
                        | "url"
                        | "uri"
                        | "href"
                        | "host"
                        | "file_id"
                        | "data"
                        | "signature"
                        | "$ref"
                ) {
                    return Err(REJECTED);
                }
                *text = self.mask(text)?;
            }
            Value::Number(number) if self.matches(&number.to_string()) => return Err(REJECTED),
            Value::Array(items) => {
                for item in items {
                    self.walk(item, field)?;
                }
            }
            Value::Object(map) => {
                for (key, item) in map {
                    if self.matches(key) {
                        return Err(REJECTED);
                    }
                    self.walk(item, key)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn restore(&self, text: &str, argument: bool) -> Result<String, &'static str> {
        let mut tail = text;
        let mut output = String::new();
        let slots = self.slots.lock().map_err(|_| UNAVAILABLE)?;
        while let Some(start) = tail.find(&self.prefix) {
            output.push_str(&tail[..start]);
            tail = &tail[start..];
            let Some(token) = tail.get(..self.prefix.len() + 6) else {
                break;
            };
            if let Some(original) = slots.values.get(token) {
                if argument {
                    let quoted =
                        serde_json::to_string(original.as_str()).map_err(|_| UNAVAILABLE)?;
                    output.push_str(&quoted[1..quoted.len() - 1]);
                } else {
                    output.push_str(original);
                }
                tail = &tail[token.len()..];
            } else {
                output.push_str(&self.prefix);
                tail = &tail[self.prefix.len()..];
            }
            if output.len() > 8 * 1024 * 1024 {
                return Err(REJECTED);
            }
        }
        output.push_str(tail);
        Ok(output)
    }
    pub fn restore_json(&self, value: &mut Value, field: &str) -> Result<(), &'static str> {
        match value {
            Value::String(text)
                if text.contains(&self.prefix)
                    && !matches!(
                        field,
                        "id" | "call_id"
                            | "tool_call_id"
                            | "model"
                            | "type"
                            | "name"
                            | "role"
                            | "status"
                            | "object"
                            | "signature"
                    ) =>
            {
                *text = self.restore(text, matches!(field, "arguments" | "partial_json"))?
            }
            Value::Array(list) => {
                for item in list {
                    self.restore_json(item, field)?;
                }
            }
            Value::Object(map) => {
                for (key, item) in map {
                    if key != "error" {
                        self.restore_json(item, key)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}
