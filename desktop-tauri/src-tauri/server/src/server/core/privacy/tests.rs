use std::sync::Arc;

use serde_json::{json, Value};

use super::{stream::Events, Rules, Vault};

fn vault(word: &str) -> Arc<Vault> {
    Arc::new(
        Vault::new(&Rules {
            words: vec![word.to_owned()],
        })
        .unwrap(),
    )
}

fn frame(value: Value) -> String {
    format!("data: {value}\r\n\r\n")
}

#[test]
fn masks_encoded_tool_values_and_fails_closed_on_keys_ids_and_binary_input() {
    let vault = vault("démo");
    let mut request =
        json!({"function":{"arguments":r#"{"value":"d\u00e9mo"}"#}, "content":"démo"});
    vault.mask_json(&mut request).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(request["function"]["arguments"].as_str().unwrap()).unwrap()
            ["value"],
        request["content"]
    );
    for mut request in [
        json!({"démo":"v"}),
        json!({"id":"démo"}),
        json!({"type":"input_file","file_id":"fixture"}),
        json!({"value":13900000001i64}),
    ] {
        assert!(vault.mask_json(&mut request).is_err());
    }
    let token = request["content"].as_str().unwrap();
    assert_eq!(vault.restore(token, false).unwrap(), "démo");
    assert_eq!(
        super::Vault::new(&Rules::default())
            .unwrap()
            .restore(token, false)
            .unwrap(),
        token
    );
}

#[test]
fn builtins_are_masked_and_other_requests_cannot_restore_them() {
    let vault = vault("example-term");
    let other = super::Vault::new(&Rules::default()).unwrap();
    for literal in [
        "test@fixture.invalid",
        concat!("1390", "0000001"),
        concat!("110101", "20001130", "123X"),
        concat!("sk-", "fixture-0123456789"),
        "example-term",
    ] {
        let token = vault.mask(literal).unwrap();
        assert_ne!(token, literal);
        assert_eq!(vault.mask(&token).unwrap(), token);
        assert_eq!(vault.restore(&token, false).unwrap(), literal);
        assert_eq!(other.restore(&token, false).unwrap(), token);
    }
}

#[test]
fn all_fragment_boundaries_and_crlf_are_safe_for_each_tool_protocol() {
    let literal = "fixture \"quote\" \\ 秘";
    let vault = vault(literal);
    let token = vault.mask(literal).unwrap();
    for kind in ["chat", "responses", "anthropic"] {
        let (wrap, pointer): (fn(&str) -> Value, &str) = match kind {
            "chat" => (
                |text| json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":text}}]}}]}),
                "/choices/0/delta/tool_calls/0/function/arguments",
            ),
            "responses" => (
                |text| json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":text}),
                "/delta",
            ),
            _ => (
                |text| json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":text}}),
                "/delta/partial_json",
            ),
        };
        for cut in 0..=token.len() {
            let mut events = Events::new(vault.clone());
            let input = frame(wrap(&format!("{{\"v\":\"{}", &token[..cut])))
                + &frame(wrap(&format!("{}\"}}", &token[cut..])))
                + "data: [DONE]\n\n";
            let mut out = Vec::new();
            for byte in input.as_bytes() {
                out.extend(events.push(std::slice::from_ref(byte), false).unwrap());
            }
            out.extend(events.push(&[], true).unwrap());
            let text = std::str::from_utf8(&out).unwrap();
            let args = text
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .map(|v| v.pointer(pointer).unwrap().as_str().unwrap().to_owned())
                .collect::<String>();
            assert_eq!(serde_json::from_str::<Value>(&args).unwrap()["v"], literal);
        }
    }
}

#[test]
fn partial_literal_and_interleaved_choices_survive_end() {
    let vault = vault("fixture-word");
    let token = vault.mask("fixture-word").unwrap();
    let mut events = Events::new(vault);
    let input = [(0, "["), (1, &token[..5]), (2, "other"), (1, &token[5..])]
        .into_iter()
        .map(|(index, text)| frame(json!({"choices":[{"index":index,"delta":{"content":text}}]})))
        .collect::<String>()
        + "data: [DONE]\n\n";
    let out = String::from_utf8(events.push(input.as_bytes(), true).unwrap()).unwrap();
    let mut results = [String::new(), String::new(), String::new()];
    for data in out
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
    {
        let choice = &data["choices"][0];
        results[choice["index"].as_u64().unwrap() as usize]
            .push_str(choice["delta"]["content"].as_str().unwrap());
    }
    assert_eq!(results, ["[", "fixture-word", "other"]);
}
