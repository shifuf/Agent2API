use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use serde_json::Value;

use super::{Vault, REJECTED};

const MAX_BYTES: usize = 8 * 1024 * 1024;

struct Event {
    id: u64,
    header: String,
    data: Option<Value>,
    size: usize,
}
struct Tail {
    event: u64,
    path: String,
    text: String,
}

pub struct Events {
    vault: Arc<Vault>,
    bytes: Vec<u8>,
    events: VecDeque<Event>,
    tails: HashMap<String, Tail>,
    next: u64,
    held: usize,
}

fn fields(value: &Value) -> Vec<(String, String, bool)> {
    let mut result = Vec::new();
    if let Some(choices) = value["choices"].as_array() {
        for (offset, choice) in choices.iter().enumerate() {
            let slot = choice["index"].as_u64().unwrap_or(offset as u64);
            for field in ["content", "reasoning", "reasoning_content", "refusal"] {
                if choice["delta"][field].is_string() {
                    result.push((
                        format!("c{slot}/{field}"),
                        format!("/choices/{offset}/delta/{field}"),
                        false,
                    ));
                }
            }
            if let Some(tools) = choice["delta"]["tool_calls"].as_array() {
                for (position, tool) in tools.iter().enumerate() {
                    let index = tool["index"].as_u64().unwrap_or(position as u64);
                    if tool["function"]["arguments"].is_string() {
                        result.push((
                            format!("c{slot}/t{index}"),
                            format!(
                                "/choices/{offset}/delta/tool_calls/{position}/function/arguments"
                            ),
                            true,
                        ));
                    }
                }
            }
            if choice["delta"]["function_call"]["arguments"].is_string() {
                result.push((
                    format!("c{slot}/function"),
                    format!("/choices/{offset}/delta/function_call/arguments"),
                    true,
                ));
            }
        }
    }
    let kind = value["type"].as_str().unwrap_or("");
    if kind.starts_with("response.") && kind.ends_with(".delta") && value["delta"].is_string() {
        result.push((
            format!(
                "r/{kind}/{}/{}/{}",
                value.get("output_index").filter(|slot| slot.is_u64()).or_else(||value.get("item_id")).unwrap_or(&Value::Null), value["content_index"], value["summary_index"]
            ),
            "/delta".to_owned(),
            kind == "response.function_call_arguments.delta",
        ));
    }
    if kind == "content_block_delta" {
        for field in ["text", "thinking", "partial_json"] {
            if value["delta"][field].is_string() {
                result.push((
                    format!("a/{}/{field}", value["index"]),
                    format!("/delta/{field}"),
                    field == "partial_json",
                ));
            }
        }
    }
    result
}

fn incomplete(text: &str, prefix: &str) -> usize {
    let max = text.len().min(prefix.len() + 5);
    for len in (1..=max).rev() {
        let Some(suffix) = text.get(text.len() - len..) else {
            continue;
        };
        if prefix.starts_with(suffix) {
            return len;
        }
        if let Some(rest) = suffix.strip_prefix(prefix) {
            if rest.bytes().enumerate().all(|(index, byte)| {
                if index < 4 {
                    byte.is_ascii_hexdigit()
                } else {
                    byte == b']'
                }
            }) {
                return len;
            }
        }
    }
    0
}

impl Events {
    pub fn new(vault: Arc<Vault>) -> Self {
        Self {
            vault,
            bytes: Vec::new(),
            events: VecDeque::new(),
            tails: HashMap::new(),
            next: 0,
            held: 0,
        }
    }

    fn flush_tails(&mut self) -> Result<(), &'static str> {
        for (_, tail) in self.tails.drain() {
            let field = self
                .events
                .iter_mut()
                .find(|event| event.id == tail.event)
                .and_then(|event| event.data.as_mut())
                .and_then(|value| value.pointer_mut(&tail.path))
                .ok_or(REJECTED)?;
            let mut text = field.as_str().ok_or(REJECTED)?.to_owned();
            text.push_str(&tail.text);
            *field = Value::String(text);
        }
        Ok(())
    }

    fn drain(&mut self, output: &mut Vec<u8>) -> Result<(), &'static str> {
        let blocked = self
            .tails
            .values()
            .map(|tail| tail.event)
            .min()
            .unwrap_or(u64::MAX);
        while self.events.front().is_some_and(|event| event.id < blocked) {
            let event = self.events.pop_front().ok_or(REJECTED)?;
            self.held -= event.size;
            output.extend_from_slice(event.header.as_bytes());
            if let Some(data) = event.data {
                output.extend_from_slice(b"data: ");
                serde_json::to_writer(&mut *output, &data).map_err(|_| REJECTED)?;
                output.push(b'\n');
            }
            output.push(b'\n');
            if output.len() > MAX_BYTES * 2 {
                return Err(REJECTED);
            }
        }
        Ok(())
    }

    fn frame(&mut self, frame: &[u8], output: &mut Vec<u8>) -> Result<(), &'static str> {
        let raw = std::str::from_utf8(frame).map_err(|_| REJECTED)?;
        let mut header = String::new();
        let mut data = Vec::new();
        for line in raw.lines() {
            if let Some(payload) = line.strip_prefix("data:") {
                data.push(payload.strip_prefix(' ').unwrap_or(payload));
            } else {
                header.push_str(line);
                header.push('\n');
            }
        }
        let joined = data.join("\n");
        let mut value = None;
        if joined.trim() == "[DONE]" {
            self.flush_tails()?;
            header.push_str("data: [DONE]\n");
        } else if !joined.is_empty() {
            let mut object: Value = serde_json::from_str(&joined).map_err(|_| REJECTED)?;
            if object.get("error").is_some_and(|error| !error.is_null())
                || matches!(object["type"].as_str(), Some("error" | "response.failed"))
            {
                let error = serde_json::json!({"type":"api_error", "message":"Upstream request failed; details omitted in privacy mode"});
                object = match object["type"].as_str() {
                    Some("response.failed") => {
                        serde_json::json!({"type":"response.failed", "response":{"status":"failed","error":error}})
                    }
                    Some("error") => serde_json::json!({"type":"error", "error":error}),
                    _ => serde_json::json!({"error":error}),
                };
            }
            let paths = fields(&object);
            for (key, path, escaped) in paths {
                let field = object.pointer_mut(&path).ok_or(REJECTED)?;
                let mut full = self
                    .tails
                    .remove(&key)
                    .map(|tail| tail.text)
                    .unwrap_or_default();
                full.push_str(field.as_str().ok_or(REJECTED)?);
                let pending = incomplete(&full, self.vault.prefix());
                let split = full.len() - pending;
                if pending > 0 {
                    self.tails.insert(
                        key,
                        Tail {
                            event: self.next,
                            path,
                            text: full[split..].to_owned(),
                        },
                    );
                }
                *field = Value::String(self.vault.restore(&full[..split], escaped)?);
            }
            if matches!(
                object["type"].as_str(),
                Some(
                    "message_stop"
                        | "response.completed"
                        | "response.failed"
                        | "response.incomplete"
                        | "error"
                )
            ) {
                self.flush_tails()?;
            }
            self.vault.restore_json(&mut object, "")?;
            value = Some(object);
        }
        self.held += frame.len();
        self.events.push_back(Event {
            id: self.next,
            header,
            data: value,
            size: frame.len(),
        });
        self.next += 1;
        self.drain(output)?;
        if self.held > MAX_BYTES || self.events.len() > 256 {
            return Err(REJECTED);
        }
        Ok(())
    }

    pub fn push(&mut self, chunk: &[u8], eof: bool) -> Result<Vec<u8>, &'static str> {
        if self.bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(REJECTED);
        }
        let previous = self.bytes.len();
        self.bytes.extend_from_slice(chunk);
        let mut bytes = std::mem::take(&mut self.bytes);
        let mut cursor = 0;
        let mut output = Vec::new();
        for (index, &byte) in bytes.iter().enumerate().skip(previous) {
            if byte != b'\n' || index < cursor + 1 {
                continue;
            }
            let tail = &bytes[cursor..=index];
            if tail.ends_with(b"\n\n") || tail.ends_with(b"\n\r\n") {
                self.frame(
                    &tail[..tail.len() - if tail.ends_with(b"\r\n") { 2 } else { 1 }],
                    &mut output,
                )?;
                cursor = index + 1;
            }
        }
        self.bytes = if cursor == 0 {
            bytes
        } else {
            bytes.split_off(cursor)
        };
        if eof {
            if !self.bytes.is_empty() {
                let last = std::mem::take(&mut self.bytes);
                self.frame(&last, &mut output)?;
            }
            self.flush_tails()?;
            self.drain(&mut output)?;
        }
        Ok(output)
    }
}
