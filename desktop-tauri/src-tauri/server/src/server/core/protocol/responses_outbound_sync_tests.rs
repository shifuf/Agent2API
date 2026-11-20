use super::*;

fn events(input: &[Value]) -> Vec<Value> {
    let mut stream = ChatFromResponsesStream::new("public-model");
    let mut frames = Vec::new();
    for event in input { frames.extend(stream.push(format!("data: {event}\n\n").as_bytes())); }
    frames.extend(stream.finish());
    frames.iter().flat_map(|frame| std::str::from_utf8(frame).unwrap().lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect::<Vec<_>>()).collect()
}

#[test]
fn beta2_tool_item_call_and_output_aliases_share_one_slot() {
    let frames = events(&[
        json!({"type":"response.output_item.added", "output_index":0,
            "item":{"type":"function_call", "id":"item-1", "call_id":"call-1", "name":"read"}}),
        json!({"type":"response.function_call_arguments.delta", "item_id":"item-1", "output_index":0, "delta":"{\"path\":"}),
        json!({"type":"response.function_call_arguments.delta", "output_index":0, "delta":"\"a\"}"}),
        json!({"type":"response.function_call_arguments.done", "call_id":"call-1", "arguments":"{\"path\":\"a\"}"}),
        json!({"type":"response.completed"}),
    ]);
    let calls: Vec<&Value> = frames.iter().flat_map(|frame| frame.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array).into_iter().flatten()).collect();
    assert_eq!(calls.iter().filter(|call| call.get("id").is_some()).count(), 1);
    assert!(calls.iter().all(|call| call["index"] == 0));
    let arguments: String = calls.iter().filter_map(|call| call.pointer("/function/arguments").and_then(Value::as_str)).collect();
    assert_eq!(arguments, "{\"path\":\"a\"}");
}

#[test]
fn beta2_arguments_before_name_are_buffered_until_declaration() {
    let frames = events(&[
        json!({"type":"response.function_call_arguments.delta", "item_id":"item-1", "output_index":0, "delta":"{}"}),
        json!({"type":"response.output_item.added", "output_index":0,
            "item":{"type":"function_call", "id":"item-1", "call_id":"call-1", "name":"read"}}),
        json!({"type":"response.output_item.done", "output_index":0,
            "item":{"type":"function_call", "id":"item-1", "call_id":"call-1", "name":"read", "arguments":"{}"}}),
        json!({"type":"response.completed"}),
    ]);
    let calls: Vec<&Value> = frames.iter().flat_map(|frame| frame.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array).into_iter().flatten()).collect();
    let declared: Vec<_> = calls.iter().filter(|call| call.get("id").is_some()).collect();
    assert_eq!(declared.len(), 1);
    assert_eq!(declared[0]["id"], "call-1");
    assert_eq!(declared[0]["function"]["name"], "read");
    let arguments: String = calls.iter().filter_map(|call| call.pointer("/function/arguments").and_then(Value::as_str)).collect();
    assert_eq!(arguments, "{}");
}

#[test]
fn beta2_cancelled_response_is_an_error_terminal() {
    let frames = events(&[
        json!({"type":"response.output_text.delta", "delta":"partial"}),
        json!({"type":"response.cancelled", "response":{"error":{"message":"cancelled by upstream"}}}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.pointer("/error/message") == Some(&json!("cancelled by upstream"))));
    assert!(!frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason") == Some(&json!("stop"))));
}

#[test]
fn beta2_incomplete_token_limit_uses_chat_length_finish_reason() {
    let frames = events(&[json!({"type":"response.incomplete", "response":{"incomplete_details":{"reason":"max_output_tokens"}}})]);
    assert!(frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason") == Some(&json!("length"))));
}

#[test]
fn beta2_compatibility_keeps_eof_completion_and_usage_aliases() {
    let frames = events(&[
        json!({"type":"response.output_text.delta", "delta":"ok"}),
        json!({"type":"response.in_progress", "usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}),
    ]);
    assert!(frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason") == Some(&json!("stop"))));
    assert!(frames.iter().any(|frame| frame.pointer("/usage/prompt_tokens") == Some(&json!(12))));
}

#[test]
fn beta2_generic_terminal_reads_nested_response_status() {
    for (kind, status) in [("response.done", "failed"), ("response.completed", "cancelled")] {
        let frames = events(&[json!({"type":kind,"response":{"status":status,"error":{"message":"stopped upstream"}}})]);
        assert!(frames.iter().any(|frame| frame.pointer("/error/message") == Some(&json!("stopped upstream"))));
        assert!(!frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason").is_some_and(Value::is_string)));
    }
    let frames = events(&[json!({"type":"response.done","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}})]);
    assert!(frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason") == Some(&json!("length"))));
}

#[test]
fn beta2_idless_arguments_follow_the_only_tool_slot() {
    let frames = events(&[
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"read"}}),
        json!({"type":"response.function_call_arguments.delta","delta":"{}"}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.pointer("/choices/0/delta/tool_calls/0/function/arguments") == Some(&json!("{}")) && frame.pointer("/choices/0/delta/tool_calls/0/index") == Some(&json!(0))));
}

#[test]
fn beta2_pending_tool_arguments_are_preserved_at_completion() {
    let frames = events(&[
        json!({"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{}"}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.pointer("/choices/0/delta/tool_calls/0/function/arguments") == Some(&json!("{}"))));
}

#[test]
fn beta2_cancellation_without_error_returns_generic_message() {
    let frames = events(&[json!({"type":"response.cancelled","response":{"status":"cancelled","id":"internal-id"}})]);
    let message = frames.iter().find_map(|frame| frame.pointer("/error/message").and_then(Value::as_str)).unwrap();
    assert_eq!(message, "上游流式返回错误");
}

#[test]
fn flat_tool_ids_keep_parallel_calls_and_result_identity() {
    let frames = events(&[
        json!({"type":"response.function_call_arguments.delta","id":"A","name":"read","delta":"{}"}),
        json!({"type":"response.function_call_arguments.delta","id":"B","name":"write","delta":"{\"path\":\"b\"}"}),
        json!({"type":"response.completed"}),
    ]);
    let calls: Vec<&Value> = frames.iter().flat_map(|frame| frame.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array).into_iter().flatten()).collect();
    let declarations: Vec<_> = calls.iter().filter(|call| call.get("id").is_some()).collect();
    assert_eq!(declarations.len(), 2);
    assert_eq!(declarations[0]["id"], "A");
    assert_eq!(declarations[1]["id"], "B");
    let arguments = |index: i64| calls.iter().filter(|call| call["index"] == index)
        .filter_map(|call| call.pointer("/function/arguments").and_then(Value::as_str)).collect::<String>();
    assert_eq!(arguments(0), "{}");
    assert_eq!(arguments(1), "{\"path\":\"b\"}");
    let request = responses_request_from_chat(&json!({"messages":[
        {"role":"assistant","tool_calls":[{"id":"B","type":"function","function":{"name":"write","arguments":arguments(1)}}]},
        {"role":"tool","tool_call_id":"B","content":"saved"}
    ]}), "wire").unwrap();
    assert!(request["input"].as_array().unwrap().iter().any(|item| item["type"] == "function_call_output" && item["call_id"] == "B"));
}

#[test]
fn anonymous_arguments_cannot_succeed_after_a_second_tool_appears() {
    let frames = events(&[
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"A","name":"read"}}),
        json!({"type":"response.function_call_arguments.delta","delta":"{\"path\":\"for-B\"}"}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"B","name":"write"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"A","name":"read","arguments":"{}"}}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.get("error").is_some()));
    assert!(!frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason").is_some_and(Value::is_string)));
}

#[test]
fn anonymous_arguments_before_the_only_declaration_join_its_slot() {
    let frames = events(&[
        json!({"type":"response.function_call_arguments.delta","delta":"{}"}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"A","call_id":"call-A","name":"read"}}),
        json!({"type":"response.completed"}),
    ]);
    let calls: Vec<&Value> = frames.iter().flat_map(|frame| frame.pointer("/choices/0/delta/tool_calls").and_then(Value::as_array).into_iter().flatten()).collect();
    assert!(calls.iter().all(|call| call["index"] == 0));
    assert_eq!(calls.iter().filter(|call| call.get("id").is_some()).count(), 1);
    assert!(calls.iter().any(|call| call["id"] == "call-A"));
    assert_eq!(calls.iter().filter_map(|call| call.pointer("/function/arguments").and_then(Value::as_str)).collect::<String>(), "{}");
}

#[test]
fn anonymous_arguments_with_parallel_tools_are_an_explicit_error() {
    let frames = events(&[
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"A","name":"read"}}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"B","name":"write"}}),
        json!({"type":"response.function_call_arguments.delta","delta":"{}"}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.get("error").is_some()));
    assert!(!frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason").is_some_and(Value::is_string)));
}

#[test]
fn a_declared_anonymous_tool_cannot_absorb_another_named_tool() {
    let frames = events(&[
        json!({"type":"response.output_item.added","item":{"type":"function_call","name":"read"}}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"B","call_id":"call-B","name":"write"}}),
        json!({"type":"response.function_call_arguments.delta","item_id":"B","delta":"{}"}),
        json!({"type":"response.completed"}),
    ]);
    assert!(frames.iter().any(|frame| frame.get("error").is_some()));
    assert!(!frames.iter().any(|frame| frame.pointer("/choices/0/finish_reason").is_some_and(Value::is_string)));
}
