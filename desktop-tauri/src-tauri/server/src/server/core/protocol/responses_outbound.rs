//! Responses 协议的**出站**转换：chat 请求 → Responses 上游请求、
//! 上游 Responses SSE → chat SSE（自定义提供商转发的 `responses` 分支）。
//!
//! ── 与 `responses.rs` 的方向关系 ─────────────────────────────
//! `responses.rs` 服务的是**下游入口**（`api::protocol` 的 `/v1/responses`）：
//! 把客户端发来的 Responses 请求翻成 chat、把回程的 chat 响应/SSE 翻回
//! Responses。本文件是它的**反方向**，服务自定义提供商的**上游**：
//! 转发层手里的统一货币是 chat，但这家上游说 Responses，于是
//!   - 请求：`responses_request_from_chat`（chat 体 → Responses 体，逐字段
//!     对着 `chat_from_responses` 反推）；
//!   - 响应：`ChatFromResponsesStream`（上游 Responses SSE → 标准 chat SSE，
//!     之后照走既有的 `ForwardStream` / 聚合器 —— 那两层只认 chat 帧）。
//!
//! ── 上游恒以 `stream:true` 被请求 ────────────────────────────
//! 与 chat 协议同一条策略（各家上游的流式才是完整能力；非流式下游由网关
//! 收流聚合）。因此响应侧只需要流式转换器；非流式 JSON 路径不会有上游
//! 来源。事件流的折法参考 OmniProxy 的 `responsesStreamToChat`，字段口径
//! 按本项目 chat 侧（`responses.rs` 回程消费的形状）收敛。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! 同 `mod.rs`：零 unwrap/expect/panic；解析失败退化「跳过该帧」。

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::{
    chat_frame, content_parts, content_text, is_truthy, json_number_of, json_text, native_tool,
    random_id, string_field, string_value, SseLineBuffer, FIELD_ENCRYPTED_CONTENT,
};
use super::responses::{image_url_of, tool_output_parts, ConvertError, ToolOutput};
use super::tool_plan;

#[cfg(test)]
#[path = "responses_outbound_sync_tests.rs"]
mod sync_tests;

// ─── 请求：Chat → Responses ─────────────────────────────────

/// Chat Completions 请求体 → Responses 请求体。
///
/// ── 逐字段对着 [`super::responses::chat_from_responses`] 反推 ────
/// 那份转换把 Responses 请求折成 chat，字段映射全在里面；这里逐条走它的
/// 完整清单（漏一条的症状是「客户端参数静默失效」）：
///   - `model`（由调用方给上游真名，见 `providers::custom::forward`）
///   - `messages` → `instructions`（system 消息）+ `input`（message /
///     function_call / function_call_output 项）
///   - `stream` / `max_output_tokens`（← `max_completion_tokens` / `max_tokens`）
///   - `temperature` / `top_p` / `service_tier` / `parallel_tool_calls` /
///     `user` / `metadata`
///   - `tools`（chat 嵌套 function → Responses 扁平 function）
///   - `tool_choice`、`response_format` → `text.format`
///   - `reasoning_effort` → `reasoning:{effort, summary:"auto"}`
///   - `store: false`（本网关无状态；对上游同样不存）
///
/// 不支持的 chat 字段（`n` / `logprobs` 等）**原样丢弃**：Responses 没有
/// 对应形态，发送上游不认识的键只会换来一次 400。
pub fn responses_request_from_chat(chat: &Value, model: &str) -> Result<Value, ConvertError> {
    let Some(messages) = chat.get("messages").and_then(Value::as_array) else {
        return Err("缺少 messages 数组".to_string());
    };
    let mut instructions: Vec<String> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    for message in messages {
        let role = {
            let raw = string_field(message, "role").to_lowercase();
            if raw == "developer" {
                "system".to_string()
            } else if raw.is_empty() {
                "user".to_string()
            } else {
                raw
            }
        };
        match role.as_str() {
            // system / developer → 顶层 instructions（多条用空行拼接，
            // 与 anthropic 侧 system_text 的拼接口径一致）
            "system" => {
                let text = content_text(message.get("content").unwrap_or(&Value::Null));
                if !text.trim().is_empty() {
                    instructions.push(text);
                }
            }
            // tool 结果 → function_call_output 项（call_id 是配对的钥匙，
            // 缺了它上游在多轮里认不出这条结果属于哪次调用）
            "tool" => {
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": string_field(message, "tool_call_id"),
                    "output": tool_output_to_responses(tool_output_parts(message.get("content"))),
                }));
            }
            "assistant" => push_assistant_items(&mut items, message),
            // user 与「认不出的角色」都当 user（与 chat_from_responses 的
            // 兜底同一取向：能跑比报错好）
            _ => {
                let content =
                    chat_content_to_responses(message.get("content").unwrap_or(&Value::Null), "user");
                items.push(json!({ "type": "message", "role": "user", "content": content }));
            }
        }
    }

    let mut out = Map::new();
    out.insert("model".to_string(), Value::String(model.to_string()));
    out.insert("input".to_string(), Value::Array(items));
    out.insert(
        "stream".to_string(),
        Value::Bool(chat.get("stream").and_then(Value::as_bool).unwrap_or(false)),
    );
    if !instructions.is_empty() {
        out.insert(
            "instructions".to_string(),
            Value::String(instructions.join("\n\n")),
        );
    }
    // max_output_tokens ← max_completion_tokens（Responses 口径的字段名），
    // 退到 max_tokens；非正数视为没给（0 / 负数发上去只会被上游拒）
    let max_output = ["max_completion_tokens", "max_tokens"]
        .iter()
        .find_map(|key| chat.get(*key).and_then(Value::as_i64).filter(|value| *value > 0));
    if let Some(value) = max_output {
        out.insert("max_output_tokens".to_string(), Value::from(value));
    }
    for key in ["temperature", "top_p", "service_tier", "parallel_tool_calls", "user", "metadata"] {
        if let Some(value) = chat.get(key).filter(|value| !value.is_null()) {
            out.insert(key.to_string(), value.clone());
        }
    }
    // 工具声明：函数工具翻译成 Responses 扁平形态；原生（服务端执行）声明只有
    // 「来源就是 Responses」的原样恢复（保真，含 web_search / tool_search 等
    // 宿主工具的一切字段），跨协议的不猜 —— 剔除并留痕（见 `native_tool` 模块头）
    let mut natives: Vec<Value> = Vec::new();
    if let Some(tools) = chat.get("tools").and_then(Value::as_array) {
        let converted: Vec<Value> = tools
            .iter()
            .filter_map(|tool| tool_to_responses(tool, &mut natives))
            .collect();
        if !converted.is_empty() {
            out.insert("tools".to_string(), Value::Array(converted));
        }
    }
    let mut choice_reason: Option<String> = None;
    if let Some(choice) = chat.get("tool_choice").filter(|value| is_truthy(value)) {
        // 点名的工具被剔除时 `tool_choice` 一并撤掉（理由同 `anthropic_outbound`）
        match native_tool::choice_conflict(choice, &natives) {
            Some(reason) => choice_reason = Some(reason),
            None => {
                out.insert("tool_choice".to_string(), tool_choice_to_responses(choice));
            }
        }
    }
    if !natives.is_empty() || choice_reason.is_some() {
        let dropped = native_tool::Downgrade { tools: natives, choice: choice_reason };
        crate::server::logging::log(
            "[Responses]",
            &dropped.describe(None, Some("目标上游按 responses 协议收，只认 responses 来源的原生声明")),
        );
    }
    // response_format → text.format（json_schema 的嵌套 → 扁平）
    if let Some(format) = chat.get("response_format").filter(|value| is_truthy(value)) {
        out.insert("text".to_string(), json!({ "format": format_to_responses(format) }));
    }
    // reasoning_effort → reasoning.effort（本网关各上游的「思考档位」统一
    // 从这里进；summary:"auto" 与参考实现同款 —— 让上游回思考摘要）
    if let Some(effort) = chat
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        out.insert(
            "reasoning".to_string(),
            json!({ "effort": effort, "summary": "auto" }),
        );
    }
    // store:false 与模块头同一理由（网关无状态，也不许上游存）
    out.insert("store".to_string(), Value::Bool(false));
    Ok(Value::Object(out))
}

/// 一条 assistant 消息 → 零到多个 input 项（顺序：reasoning → message →
/// function_call）。
///
/// 顺序不是随意的：回程的 `chat_from_responses` 按「reasoning 项在前、
/// 本轮 assistant 项在后」消费（`PendingReasoning`），反向也必须产出同一
/// 形状，多轮历史才能被上游正确读取。
fn push_assistant_items(items: &mut Vec<Value>, message: &Value) {
    let reasoning = {
        let from_field = string_field(message, "reasoning_content");
        if from_field.is_empty() {
            string_field(message, "reasoning")
        } else {
            from_field
        }
    };
    // 加密连续性载体（store=false 多轮）恢复进 reasoning 项：与 summary 文本
    // 可以并存（OpenAI 官方回传的形态就是两者同项），只有加密体时 summary
    // 给空数组。没有这个恢复，Codex / Grok CLI 的下一轮就接不上推理链 ——
    // 它们靠把上游回传的加密体原样带回下一轮请求来延续推理。
    let encrypted = message
        .get(FIELD_ENCRYPTED_CONTENT)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    if !reasoning.is_empty() || encrypted.is_some() {
        let mut item = json!({
            "type": "reasoning",
            "id": random_id("rs"),
            "summary": if reasoning.is_empty() {
                Vec::<Value>::new()
            } else {
                vec![json!({ "type": "summary_text", "text": reasoning })]
            },
        });
        if let Some(encrypted) = encrypted {
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "encrypted_content".to_string(),
                    Value::String(encrypted.to_string()),
                );
            }
        }
        items.push(item);
    }
    // 正文：Responses 不需要空的 assistant message（只带工具调用的轮次
    // 只发 function_call 项）；空正文跳过也能避免上游把空消息判成错误
    let text = content_text(message.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        items.push(json!({
            "type": "message",
            "id": random_id("msg"),
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        }));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let call_id = {
                let raw = string_field(call, "id");
                if raw.is_empty() {
                    random_id("call")
                } else {
                    raw
                }
            };
            let name = call
                .pointer("/function/name")
                .map(string_value)
                .unwrap_or_default();
            let arguments = {
                let raw = json_text(call.pointer("/function/arguments").unwrap_or(&Value::Null));
                if raw.is_empty() {
                    "{}".to_string()
                } else {
                    raw
                }
            };
            items.push(json!({
                "type": "function_call",
                "id": random_id("fc"),
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
            }));
        }
    }
}

/// 拆开的工具输出 → Responses 的 `function_call_output.output`。
///
/// ── 与入站方向相反的取舍（不是笔误）──────────────────────────
/// 入站（`responses.rs`）图片**必须**挪出 tool 消息：Chat 不许 `tool` 角色带
/// 图片（OpenAI 直接 400，见 `responses::PendingImages`）。出站这边不用 ——
/// Responses 官方 schema 里 `output` 本来就是
/// `String | Array[ResponseInputText | ResponseInputImage | …]`，图表留在工具结果
/// 里才是保真形态（DeepSeek 的 Responses 文档同样声明 `input_image` 按真图片
/// 处理）。所以这边只是「别把它拍平成 JSON 文本」，不搬消息。
///
/// 没有图片时保持字符串形态：字符串对各家上游最友好，也是原来就在发的形状。
fn tool_output_to_responses(output: ToolOutput) -> Value {
    if output.images.is_empty() {
        return Value::String(output.text);
    }
    let mut parts: Vec<Value> = Vec::new();
    if !output.text.is_empty() {
        parts.push(json!({ "type": "input_text", "text": output.text }));
    }
    for image in &output.images {
        let url = image_url_of(image);
        if !url.is_empty() {
            parts.push(json!({ "type": "input_image", "image_url": url }));
        }
    }
    if parts.is_empty() {
        // 图片块全都取不到 url（只剩 file_id 之类）：退回文本，别发空数组上去
        return Value::String(output.text);
    }
    Value::Array(parts)
}

/// Chat content（字符串或块数组）→ Responses 的 input content。
///
/// 口径对着 `chat_from_responses` 的 `content_to_chat` 反推：
///   - 纯文本（字符串 / 全文本块）保持该有的形态（user 可用字符串，
///     assistant 用 `[{type:"output_text"}]`）；
///   - 图片块 → `input_image`（url 取 `image_url` 的字符串或 `{url}` 形态）；
///   - 其余块（音频/文件等）**丢弃** —— 它们在 chat 侧本来就没有来源，
///     透传一个上游不认识的类型只会让整条请求 400。
fn chat_content_to_responses(content: &Value, role: &str) -> Value {
    let text_kind = if role == "assistant" { "output_text" } else { "input_text" };
    if let Some(text) = content.as_str() {
        if role == "assistant" {
            return if text.is_empty() {
                Value::String(String::new())
            } else {
                json!([{ "type": "output_text", "text": text }])
            };
        }
        return Value::String(text.to_string());
    }
    let parts = content_parts(content);
    if parts.is_empty() {
        return Value::String(String::new());
    }
    let mut out: Vec<Value> = Vec::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            out.push(json!({ "type": text_kind, "text": text }));
            continue;
        }
        let kind = string_field(part, "type").to_lowercase();
        match kind.as_str() {
            "text" | "input_text" | "output_text" => {
                out.push(json!({ "type": text_kind, "text": string_field(part, "text") }));
            }
            "image_url" | "input_image" if role == "user" => {
                let url = image_url_of(part);
                if !url.is_empty() {
                    out.push(json!({ "type": "input_image", "image_url": url }));
                }
            }
            _ => {}
        }
    }
    if out.is_empty() {
        Value::String(String::new())
    } else {
        Value::Array(out)
    }
}

/// Chat 工具声明 → Responses 工具声明（扁平）。
///
/// `parameters` 缺省给空对象 schema（`nested_from_flat` 的同一兜底）；
/// `strict` 原样搬运（两协议同名）。
///
/// 原生（服务端执行）声明：来源是 Responses 的原样恢复（`natives` 不收，
/// 保真）；其余（Anthropic 来源、或 chat 入口的方言原生工具）收进 `natives`
/// 由调用方留痕剔除 —— 目标协议是 responses，别的原生类型没有对应形态。
fn tool_to_responses(tool: &Value, natives: &mut Vec<Value>) -> Option<Value> {
    if native_tool::is_native(tool) {
        if native_tool::origin_of(tool) == Some(native_tool::ORIGIN_RESPONSES) {
            return Some(native_tool::restore(tool));
        }
        natives.push(tool.clone());
        return None;
    }
    if !tool_plan::is_nested_function(tool) {
        // 非嵌套形态（裸 name/parameters）：出站没有可靠的翻译口径，
        // 丢弃而不是发一个半成品上去
        return None;
    }
    let function = tool.get("function")?;
    let name = string_field(function, "name");
    if name.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("name".to_string(), Value::String(name));
    if let Some(description) = function.get("description").filter(|value| is_truthy(value)) {
        out.insert("description".to_string(), description.clone());
    }
    let parameters = function
        .get("parameters")
        .filter(|value| is_truthy(value))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    out.insert("parameters".to_string(), parameters);
    if let Some(strict) = function.get("strict") {
        out.insert("strict".to_string(), strict.clone());
    }
    Some(Value::Object(out))
}

/// Chat 的 tool_choice → Responses 的 tool_choice
/// （`{type:"function", function:{name}}` → `{type:"function", name}`；
/// 字符串形态两协议同名，原样保留）。
fn tool_choice_to_responses(choice: &Value) -> Value {
    if choice.is_string() {
        return choice.clone();
    }
    let name = {
        let nested = choice.pointer("/function/name").map(string_value).unwrap_or_default();
        if nested.is_empty() {
            string_field(choice, "name")
        } else {
            nested
        }
    };
    if name.is_empty() {
        return choice.clone();
    }
    json!({ "type": "function", "name": name })
}

/// Chat 的 `response_format` → Responses 的 `text.format`
/// （`{type:"json_schema", json_schema:{…}}` → `{type:"json_schema", …}`）。
fn format_to_responses(format: &Value) -> Value {
    let kind = string_field(format, "type");
    if kind != "json_schema" {
        return format.clone();
    }
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("json_schema".to_string()));
    for key in ["name", "description", "schema", "strict"] {
        if let Some(value) = format
            .pointer(&format!("/json_schema/{key}"))
            .filter(|value| !value.is_null())
        {
            out.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

// ─── 响应：Responses SSE → Chat SSE（流式）────────────────────

/// 上游 Responses SSE 字节流 → 标准 chat SSE 字节流（状态机）。
///
/// 输出帧的形状必须让下游既有消费层认得（`ForwardStream` 的 reasoning 合并
/// 与 usage 提取、聚合器的 `choices[0].delta` 读取、下游两种协议出口的
/// 反向翻译都吃这个形状），关键约定：
///   - 每个 chat chunk 都是 `data: {"id","object":"chat.completion.chunk",
///     "created","model","choices":[{"index":0,"delta":{…},"finish_reason":…}]}`
///   - `response.output_text.delta` → `delta.content`；
///     `response.reasoning_summary_text.delta` → `delta.reasoning_content`；
///     `response.function_call_arguments.delta` → `delta.tool_calls[…]`
///   - `response.completed` → 收尾帧（`finish_reason`）+ usage 帧
///     （`choices: []`，usage 折成 chat 口径）+ `data: [DONE]`
///   - `error` / `response.failed` → `data: {"error":{…}}` + `data: [DONE]`
///     （与 ForwardStream 的断流收尾同形状：聚合器据此转 502）
///
/// usage 帧会同时被两处读到（ForwardStream 的旁路提取 + 聚合器的 usage
/// 覆盖）—— 幂等覆盖，以最后一处为准，不影响含义。
pub struct ChatFromResponsesStream {
    buffer: SseLineBuffer,
    /// 输出帧的 model（发给上游的真名；ForwardStream 的回写层会按需改成
    /// 客户端请求名，此处不必区分）
    model: String,
    id: String,
    created: i64,
    started: bool,
    finished: bool,
    /// Set only by parsed upstream events, never by the EOF compatibility close.
    upstream_terminal: bool,
    /// 同一工具的 item_id / call_id / output_index 都映射到唯一槽位。
    tools: Vec<ToolSlot>,
    tool_aliases: BTreeMap<String, usize>,
    /// 无身份参数只在整个流恰有一个工具时可归属；后续出现第二个工具须失败。
    anonymous_arguments: bool,
    /// 上游最近的 usage（Responses 口径；收尾时折成 chat 形态）
    usage: Option<Value>,
}

/// 一个工具的 chat 侧状态（key 是上游给的 item_id / call_id）
#[derive(Default)]
struct ToolSlot {
    has_arguments: bool,
    declared: bool,
    pending_arguments: String,
    arguments_done: bool,
    call_id: String,
}

impl ChatFromResponsesStream {
    pub fn new(model: &str) -> Self {
        Self {
            buffer: SseLineBuffer::new(),
            model: model.to_string(),
            id: String::new(),
            created: crate::server::logging::now_ms() / 1000,
            started: false,
            finished: false,
            upstream_terminal: false,
            tools: Vec::new(),
            tool_aliases: BTreeMap::new(),
            anonymous_arguments: false,
            usage: None,
        }
    }

    /// 吃一段上游字节，吐出要下发的 chat SSE 帧
    pub fn push(&mut self, chunk: &[u8]) -> Vec<bytes::Bytes> {
        let mut out = Vec::new();
        for payload in self.buffer.push(chunk) {
            match payload {
                None => { self.upstream_terminal = true; out.extend(self.finish()); },
                Some(data) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                        out.extend(self.consume(&value));
                    }
                }
            }
        }
        out
    }

    /// A terminal parsed from the upstream, including one buffered until EOF.
    pub(crate) fn has_upstream_terminal(&self) -> bool { self.upstream_terminal }

    /// 上游流结束（没有终态事件时的兜底收尾）
    pub fn finish(&mut self) -> Vec<bytes::Bytes> {
        if self.finished {
            return Vec::new();
        }
        // 先冲刷缓冲里残留的最后一帧
        let mut out = Vec::new();
        for payload in self.buffer.finish() {
            if let Some(data) = payload {
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    out.extend(self.consume(&value));
                }
            } else { self.upstream_terminal = true; }
        }
        out.extend(self.complete(None));
        out
    }

    /// 一个上游 Responses 事件 → 零到多个 chat 帧
    fn consume(&mut self, event: &Value) -> Vec<bytes::Bytes> {
        if self.finished {
            return Vec::new();
        }
        // usage 的位置各家不一：官方在 response.completed 的 response.usage
        // 里，部分网关直接放事件顶层。两处都收（事件流里的最近一次为准）
        let usage = event
            .get("usage")
            .filter(|usage| usage.is_object())
            .or_else(|| event.pointer("/response/usage").filter(|usage| usage.is_object()));
        if let Some(usage) = usage {
            self.usage = Some(usage.clone());
        }
        let kind = string_field(event, "type").to_lowercase();
        self.upstream_terminal |= matches!(kind.as_str(), "response.completed" | "response.done"
            | "response.failed" | "response.cancelled" | "response.canceled" | "response.incomplete");
        match kind.as_str() {
            "response.created" => {
                if let Some(id) = event
                    .pointer("/response/id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    self.id = id.to_string();
                }
                self.start()
            }
            // 正文增量（refusal 是官方的拒答文本，chat 侧没有专用通道，
            // 与正文同路 —— 丢掉会让客户端看到一段空回答）
            "response.output_text.delta" | "response.refusal.delta" => {
                let Some(text) = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                else {
                    return Vec::new();
                };
                let mut out = self.start();
                out.push(self.delta_frame(json!({ "content": text })));
                out
            }
            // 思考增量 → reasoning_content（chat 侧的统一表达）
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let Some(text) = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                else {
                    return Vec::new();
                };
                let mut out = self.start();
                out.push(self.delta_frame(json!({ "reasoning_content": text })));
                out
            }
            // 工具宣告：拿到 id / name 才能在 chat 侧建立 tool_calls 槽位
            "response.output_item.added" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                let item_kind = string_field(item, "type").to_lowercase();
                if !matches!(item_kind.as_str(), "function_call" | "custom_tool_call") {
                    return Vec::new();
                }
                let mut out = self.start();
                out.extend(self.ensure_tool(event, item));
                out
            }
            "response.function_call_arguments.delta" => {
                let delta = string_field(event, "delta");
                if delta.is_empty() {
                    return Vec::new();
                }
                let mut out = self.start();
                out.extend(self.ensure_tool(event, event));
                out.extend(self.push_arguments(event, event, &delta, false));
                out
            }
            // 自由文本工具（custom）的输入增量：分片是裸文本，中途无法可靠
            // 剥出 JSON 壳（见 `ResponsesStream::tool_delta_event` 同款取舍），
            // 按原样进 chat 的 function.arguments；完整包壳只在一个分片都没
            // 来过的 `.done` 兜底里做（wrap_freeform_input）
            "response.custom_tool_call_input.delta" => {
                let delta = {
                    let raw = event.get("delta").unwrap_or(event.get("input").unwrap_or(&Value::Null));
                    json_text(raw)
                };
                if delta.is_empty() {
                    return Vec::new();
                }
                let mut out = self.start();
                out.extend(self.ensure_tool(event, event));
                out.extend(self.push_arguments(event, event, &delta, false));
                out
            }
            // 参数收尾：增量一个都没来过时（少数网关只发 .done）补完整参数
            "response.function_call_arguments.done" => {
                let arguments = {
                    let raw = json_text(event.get("arguments").unwrap_or(&Value::Null));
                    if raw.is_empty() { "{}".to_string() } else { raw }
                };
                let mut out = self.start();
                out.extend(self.ensure_tool(event, event));
                out.extend(self.push_arguments(event, event, &arguments, true));
                out
            }
            "response.custom_tool_call_input.done" => {
                let input = json_text(event.get("input").unwrap_or(&Value::Null));
                let arguments = super::freeform::wrap_freeform_input(&input);
                let mut out = self.start();
                out.extend(self.ensure_tool(event, event));
                out.extend(self.push_arguments(event, event, &arguments, true));
                out
            }
            // 项收尾：与上面 .done 同口径的补漏（两端都可能先到）
            "response.output_item.done" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                let item_kind = string_field(item, "type").to_lowercase();
                let arguments = match item_kind.as_str() {
                    "function_call" => {
                        let raw = json_text(item.get("arguments").unwrap_or(&Value::Null));
                        if raw.is_empty() { "{}".to_string() } else { raw }
                    }
                    "custom_tool_call" => {
                        super::freeform::wrap_freeform_input(&json_text(item.get("input").unwrap_or(&Value::Null)))
                    }
                    _ => return Vec::new(),
                };
                let mut out = self.start();
                out.extend(self.ensure_tool(event, item));
                out.extend(self.push_arguments(event, item, &arguments, true));
                out
            }
            // 上游错误（事件流里的失败）：折成 chat 错误帧 + [DONE]
            "error" | "response.failed" | "response.cancelled" | "response.canceled" => self.fail(event),
            // 终态：收尾（usage 已在开头收过）
            "response.completed" | "response.done" => {
                match event.pointer("/response/status").and_then(Value::as_str) {
                    Some("failed" | "cancelled" | "canceled") => self.fail(event),
                    Some("incomplete") => self.incomplete(event),
                    _ => self.complete(None),
                }
            }
            "response.incomplete" => self.incomplete(event),
            _ => Vec::new(),
        }
    }

    fn incomplete(&mut self, event: &Value) -> Vec<bytes::Bytes> {
        let reason = event.pointer("/response/incomplete_details/reason")
            .or_else(|| event.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str).unwrap_or_default();
        let reason = match reason {
            "max_output_tokens" | "" => "length",
            other => other,
        };
        self.complete(Some(reason))
    }

    /// 首帧（role assistant）：与官方 bridge 同款 —— 空响应或只有工具的流
    /// 也能建立 assistant 消息（下游按 delta 累积时不会拿到「无角色」的帧）
    fn start(&mut self) -> Vec<bytes::Bytes> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        if self.id.is_empty() {
            self.id = random_id("chatcmpl");
        }
        vec![self.delta_frame(json!({ "role": "assistant", "content": "" }))]
    }

    /// 宣告一个工具（若未宣告过）：chat 的 tool_calls 首帧带 id / name / 空参数
    fn ensure_tool(&mut self, event: &Value, item: &Value) -> Vec<bytes::Bytes> {
        let keys = tool_keys(event, item);
        let mut existing = None;
        for index in keys.iter().filter_map(|key| self.tool_aliases.get(key).copied()) {
            if existing.is_some_and(|prior| prior != index) {
                return self.fail(&json!({"error":{"message":"上游 Responses 工具调用标识冲突"}}));
            }
            existing = Some(index);
        }
        if keys.len() == 1 && keys[0] == "anonymous" {
            self.anonymous_arguments = true;
            if self.tools.len() == 1 {
                existing = Some(0);
            } else if self.tools.len() > 1 {
                return self.fail(&json!({"error":{"message":"上游 Responses 工具参数缺少唯一调用标识"}}));
            }
        } else if existing.is_none() && self.tools.len() == 1
            && !self.tools[0].declared && self.tool_aliases.len() == 1
            && self.tool_aliases.contains_key("anonymous") {
            // 参数先于唯一声明到达：为原槽位补身份，不创建无名称的孤儿调用。
            existing = Some(0);
        }
        if existing.is_none() && !self.tools.is_empty() && self.anonymous_arguments {
            return self.fail(&json!({"error":{"message":"上游 Responses 多工具参数缺少唯一调用标识"}}));
        }
        let index = existing.unwrap_or_else(|| {
            let index = self.tools.len();
            self.tools.push(ToolSlot::default());
            index
        });
        for key in keys {
            self.tool_aliases.insert(key, index);
        }
        let slot = &mut self.tools[index];
        let call_id = string_field(item, "call_id");
        if !call_id.is_empty() {
            slot.call_id = call_id;
        } else if slot.call_id.is_empty() {
            slot.call_id = item.get("id").or_else(|| event.get("item_id"))
                .and_then(Value::as_str).unwrap_or_default().to_string();
        }
        let name = string_field(item, "name");
        if name.is_empty() || slot.declared {
            return Vec::new();
        }
        slot.declared = true;
        let call_id = if slot.call_id.is_empty() { random_id("call") } else { slot.call_id.clone() };
        let pending = std::mem::take(&mut slot.pending_arguments);
        let mut frames = vec![self.delta_frame(json!({
            "tool_calls": [{
                "index": index,
                "id": call_id,
                "type": "function",
                "function": { "name": name, "arguments": "" },
            }],
        }))];
        if !pending.is_empty() {
            frames.push(self.delta_frame(json!({ "tool_calls": [{ "index": index, "function": { "arguments": pending } }] })));
        }
        frames
    }

    /// 追加一段工具参数（槽位不存在时静默跳过 —— 没宣告过就没有 index 可挂）
    fn push_arguments(&mut self, event: &Value, item: &Value, delta: &str, snapshot: bool) -> Vec<bytes::Bytes> {
        if self.finished { return Vec::new(); }
        let Some(index) = self.tool_index(event, item) else {
            return Vec::new();
        };
        let slot = &mut self.tools[index];
        if slot.arguments_done { return Vec::new(); }
        if snapshot && slot.has_arguments {
            slot.arguments_done = true;
            return Vec::new();
        }
        slot.has_arguments = true;
        slot.arguments_done = snapshot;
        if !slot.declared {
            if slot.pending_arguments.len().saturating_add(delta.len()) > 8 * 1024 * 1024 {
                return self.fail(&json!({"error":{"message":"上游 Responses 工具参数超过缓冲上限"}}));
            }
            slot.pending_arguments.push_str(delta);
            return Vec::new();
        }
        vec![self.delta_frame(json!({
            "tool_calls": [{ "index": index, "function": { "arguments": delta } }],
        }))]
    }

    fn tool_index(&self, event: &Value, item: &Value) -> Option<usize> {
        let keys = tool_keys(event, item);
        if keys.len() == 1 && keys[0] == "anonymous" && self.tools.len() == 1 {
            return Some(0);
        }
        keys.iter().find_map(|key| self.tool_aliases.get(key).copied())
    }

    /// 收尾：finish_reason 帧 + usage 帧 + [DONE]（只做一次）
    fn complete(&mut self, incomplete_reason: Option<&str>) -> Vec<bytes::Bytes> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = self.start();
        // 兼容缺少名称声明的网关，收尾仍保留已经接收的参数。
        let pending: Vec<(usize, String)> = self.tools.iter_mut().enumerate()
            .filter_map(|(index, slot)| {
                if slot.pending_arguments.is_empty() { None }
                else { Some((index, std::mem::take(&mut slot.pending_arguments))) }
            }).collect();
        for (index, arguments) in pending {
            out.push(self.delta_frame(json!({"tool_calls":[{"index":index,"function":{"arguments":arguments}}]})));
        }
        let finish_reason = match incomplete_reason {
            Some(reason) => reason.to_string(),
            // Responses 没有 chat 的 finish_reason，按输出形态推导：
            // 有工具调用 → tool_calls；否则 stop（length/content_filter
            // 由 response.incomplete 的 reason 直接给出）
            None => {
                if self.tools.is_empty() {
                    "stop".to_string()
                } else {
                    "tool_calls".to_string()
                }
            }
        };
        out.push(self.finish_frame(&finish_reason));
        if let Some(usage) = self.usage.take() {
            // usage 帧（choices 空数组）：ForwardStream 的旁路提取与聚合器
            // 都从这一帧读（形状对齐官方 include_usage 的收尾帧）
            out.push(chat_frame(&json!({
                "id": self.id,
                "object": "chat.completion.chunk",
                "created": self.created,
                "model": self.model,
                "choices": [],
                "usage": chat_usage_from_responses(&usage),
            })));
        }
        out.push(bytes::Bytes::from_static(b"data: [DONE]\n\n"));
        out
    }

    /// 上游错误 → chat 错误帧 + [DONE]（只做一次）
    fn fail(&mut self, event: &Value) -> Vec<bytes::Bytes> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let error = event
            .get("error")
            .filter(|error| is_truthy(error))
            .or_else(|| event.pointer("/response/error").filter(|error| is_truthy(error)));
        let message = error.and_then(|error| error.get("message").and_then(Value::as_str).or_else(|| error.as_str()))
            .or_else(|| event.get("message").and_then(Value::as_str))
            .filter(|message| !message.trim().is_empty())
            .unwrap_or("上游流式返回错误");
        vec![
            chat_frame(&json!({
                "error": { "message": message, "type": "upstream_error" },
            })),
            bytes::Bytes::from_static(b"data: [DONE]\n\n"),
        ]
    }

    /// 一个 delta 帧（`choices[0].delta = delta`，finish_reason 为 null）
    fn delta_frame(&self, delta: Value) -> bytes::Bytes {
        chat_frame(&json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": Value::Null }],
        }))
    }

    /// 收尾帧（空 delta + finish_reason）
    fn finish_frame(&self, finish_reason: &str) -> bytes::Bytes {
        chat_frame(&json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
        }))
    }
}

/// 事件 / 项里的工具身份键：call_id 优先，退到 id / item_id / output_index。
///
/// 同一次调用的各个事件（added / delta / done）必须映射到同一个键，
/// 上游保证这几个字段在各事件里一致（官方与参考实现都按这个优先链取值）。
fn tool_keys(event: &Value, item: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    for value in [
        item.get("id").and_then(Value::as_str).map(|value| ("item", value)),
        event.pointer("/item/id").and_then(Value::as_str).map(|value| ("item", value)),
        event.get("item_id").and_then(Value::as_str).map(|value| ("item", value)),
        item.get("call_id").and_then(Value::as_str).map(|value| ("call", value)),
        event.get("call_id").and_then(Value::as_str).map(|value| ("call", value)),
    ] {
        if let Some((namespace, value)) = value.filter(|(_, value)| !value.is_empty()) {
            let key = format!("{namespace}:{value}");
            if !keys.contains(&key) { keys.push(key); }
        }
    }
    for value in [event.get("output_index"), item.get("output_index")] {
        if let Some(index) = value.and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok())) {
            let key = format!("output:{index}");
            if !keys.contains(&key) { keys.push(key); }
        }
    }
    if keys.is_empty() { keys.push("anonymous".to_string()); }
    keys
}

/// Responses 的 usage → chat 的 usage（字段名与明细结构按 chat 口径折）。
///
/// 与 `responses.rs::usage_to_responses` 互为反函数，字段清单逐条对照：
/// `input_tokens`→`prompt_tokens`、`output_tokens`→`completion_tokens`、
/// `input_tokens_details.cached_tokens`→`prompt_tokens_details.cached_tokens`、
/// `output_tokens_details.reasoning_tokens`→`completion_tokens_details.reasoning_tokens`。
fn chat_usage_from_responses(usage: &Value) -> Value {
    let input = json_number_of(usage, &["input_tokens", "prompt_tokens"]);
    let output = json_number_of(usage, &["output_tokens", "completion_tokens"]);
    let cached = usage
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_i64)
        .filter(|value| *value != 0)
        .unwrap_or_else(|| json_number_of(usage, &["cache_read_input_tokens"]));
    let reasoning = usage
        .pointer("/output_tokens_details/reasoning_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut out = Map::new();
    out.insert("prompt_tokens".to_string(), Value::from(input));
    if cached != 0 {
        out.insert(
            "prompt_tokens_details".to_string(),
            json!({ "cached_tokens": cached }),
        );
    }
    out.insert("completion_tokens".to_string(), Value::from(output));
    if reasoning != 0 {
        out.insert(
            "completion_tokens_details".to_string(),
            json!({ "reasoning_tokens": reasoning }),
        );
    }
    out.insert(
        "total_tokens".to_string(),
        Value::from(json_number_of(usage, &["total_tokens"]).max(input + output)),
    );
    Value::Object(out)
}
