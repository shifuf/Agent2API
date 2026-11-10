use super::*;

fn declaration(name: &str) -> Value {
    json!({"type":"function", "name":name, "parameters":{"type":"object","properties":{}}})
}

#[test]
fn upstream_sync_duplicate_declarations_use_latest_definition_without_reordering() {
    let request = json!({"tools":[declaration("read"), declaration("write")], "input":[
        {"type":"additional_tools", "tools":[{"type":"function", "name":"read", "description":"latest", "parameters":{"type":"object","properties":{"path":{"type":"string"}}}}]}
    ]});
    let chat = chat_from_responses(&request).unwrap();
    assert_eq!(chat["tools"].as_array().unwrap().len(), 2);
    assert_eq!(chat["tools"][0]["function"]["name"], "read");
    assert_eq!(chat["tools"][0]["function"]["description"], "latest");
    assert_eq!(chat["tools"][1]["function"]["name"], "write");
}

#[test]
fn upstream_sync_namespace_history_and_choice_use_the_same_wire_name() {
    let request = json!({"tools":[{"type":"namespace", "name":"files", "tools":[declaration("read")]}],
        "tool_choice":{"type":"function", "namespace":"files", "name":"read"},
        "input":[{"type":"function_call", "namespace":"files", "name":"read", "call_id":"call-1", "arguments":"{}"}]});
    let chat = chat_from_responses(&request).unwrap();
    assert_eq!(chat["tools"][0]["function"]["name"], "files__read");
    assert_eq!(chat["tool_choice"]["function"]["name"], "files__read");
    assert_eq!(chat["messages"][0]["tool_calls"][0]["function"]["name"], "files__read");
}

#[test]
fn upstream_sync_names_stay_unique_valid_and_roundtrip_to_originals() {
    let long = "long/工具".repeat(20);
    let originals = ["files__read", "read", long.as_str()];
    let request = json!({"tools":[declaration(originals[0]),
        {"type":"namespace","name":"files","tools":[declaration("read")]}, declaration(&long)]});
    let chat = chat_from_responses(&request).unwrap();
    let mut names = std::collections::BTreeSet::new();
    for (i, tool) in chat["tools"].as_array().unwrap().iter().enumerate() {
        let wire = tool["function"]["name"].as_str().unwrap();
        assert!(!wire.is_empty() && wire.len() <= 64);
        assert!(wire.bytes().all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-'));
        assert!(names.insert(wire.to_string()));
        let response = responses_from_chat(&json!({"choices":[{"message":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":wire,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}), "public-id", &request);
        assert_eq!(response["output"][0]["name"], originals[i]);
        if i == 1 { assert_eq!(response["output"][0]["namespace"], "files"); }
        else { assert!(response["output"][0].get("namespace").is_none()); }
    }
}

#[test]
fn upstream_sync_ambiguous_legacy_history_is_rejected() {
    let request = json!({"tools":[
        {"type":"namespace","name":"a","tools":[declaration("bc")]},
        {"type":"namespace","name":"ab","tools":[declaration("c")]}
    ],"input":[{"type":"function_call","name":"abc","call_id":"old","arguments":"{}"}]});
    assert!(chat_from_responses(&request).is_err());
}

#[test]
fn upstream_sync_stream_restores_names_in_all_tool_events() {
    let request = json!({"tools":[{"type":"namespace","name":"files","tools":[declaration("read")]}]});
    let chat = chat_from_responses(&request).unwrap();
    let wire = chat["tools"][0]["function"]["name"].as_str().unwrap();
    let mut stream = ResponsesStream::new("public-id", &request);
    let chunks = [json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":wire,"arguments":"{}"}}]}}]}),
        json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]})];
    let mut output = Vec::new();
    for chunk in chunks { output.extend(stream.push(format!("data: {chunk}\n\n").as_bytes())); }
    output.extend(stream.push(b"data: [DONE]\n\n"));
    output.extend(stream.finish());
    let text = String::from_utf8(output.iter().flat_map(|chunk| chunk.iter().copied()).collect()).unwrap();
    let events: Vec<Value> = text.lines().filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|line| serde_json::from_str(line).ok()).collect();
    for kind in ["response.output_item.added", "response.output_item.done", "response.function_call_arguments.delta", "response.function_call_arguments.done"] {
        let event = events.iter().find(|event| event["type"] == kind).unwrap_or_else(|| panic!("missing {kind}: {text}"));
        let item = event.get("item").unwrap_or(event);
        assert_eq!(item["name"], "read", "{kind}");
        assert_eq!(item["namespace"], "files", "{kind}");
    }
}

#[test]
fn upstream_sync_single_input_additional_tools_and_custom_calls_are_supported() {
    let request = json!({"input":{"type":"additional_tools","tools":[{"type":"custom","name":"apply/patch","description":"patch"}]}});
    let chat = chat_from_responses(&request).unwrap();
    let wire = chat["tools"][0]["function"]["name"].as_str().unwrap();
    let response = responses_from_chat(&json!({"choices":[{"message":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":wire,"arguments":"{\"input\":\"patch text\"}"}}]},"finish_reason":"tool_calls"}]}), "public-id", &request);
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply/patch");
    assert_eq!(response["output"][0]["input"], "patch text");
}
