//! Grok relays may serialize an omitted JSON Schema `required` as null.
//! On the affected relay both absent and null fail; an explicit empty array
//! succeeds. Normalize only Grok tool schemas after model/protocol translation.
//! Schema literals (default, const, enum, examples) and property names are data,
//! not schema keywords, and must remain untouched.

use serde_json::Value;

pub(super) fn normalize_grok_tools(body: &mut Value) {
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    let name = model.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    if name != "grok" && !name.starts_with("grok-") && !name.starts_with("grok:") {
        return;
    }
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        for path in ["/function/parameters", "/parameters", "/input_schema"] {
            if let Some(schema) = tool.pointer_mut(path) {
                normalize_required(schema, true);
            }
        }
    }
}

fn normalize_required(schema: &mut Value, tool_root: bool) {
    let Some(object) = schema.as_object_mut() else { return };
    let object_type = match object.get("type") {
        Some(Value::String(kind)) => kind == "object",
        Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind.as_str() == Some("object")),
        _ => false,
    };
    let object_schema = object_type || object.contains_key("properties")
        || (tool_root && !object.contains_key("type"));
    if object.get("required").is_some_and(Value::is_null)
        || (object_schema && !object.contains_key("required"))
    {
        object.insert("required".to_string(), Value::Array(Vec::new()));
    }
    // These values are maps of names to schemas; never treat the map itself as
    // a schema, including when a property happens to be named "required".
    for key in ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                normalize_required(child, false);
            }
        }
    }
    for key in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_array_mut) {
            for child in children { normalize_required(child, false); }
        }
    }
    for key in ["items", "additionalItems", "contains", "additionalProperties",
        "unevaluatedProperties", "unevaluatedItems", "propertyNames", "not", "if", "then", "else"]
    {
        if let Some(child) = object.get_mut(key) {
            if key == "items" && child.is_array() {
                if let Some(items) = child.as_array_mut() {
                    for item in items { normalize_required(item, false); }
                }
            } else {
                normalize_required(child, false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grok_schema_handles_all_three_tool_protocols_and_nullable_objects() {
        for (tool, path) in [
            (json!({"type":"function", "function":{"parameters":{"type":["object","null"]}}}), "/function/parameters"),
            (json!({"type":"function", "parameters":{"required":null}}), "/parameters"),
            (json!({"name":"status", "input_schema":{}}), "/input_schema"),
        ] {
            let mut body = json!({"model":"x-ai/Grok-4.7", "tools":[tool]});
            normalize_grok_tools(&mut body);
            assert_eq!(body["tools"][0].pointer(path).unwrap()["required"], json!([]));
            let once = body.clone();
            normalize_grok_tools(&mut body);
            assert_eq!(body, once);
        }
    }

    #[test]
    fn grok_schema_preserves_literal_values_and_real_required_lists() {
        let mut body = json!({"model":"grok-4.7", "tools":[{"function":{"parameters":{
            "type":"object", "required":["name"], "additionalProperties":false,
            "properties":{"name":{"type":"string"}, "required":{"const":null}},
            "default":{"required":null}, "const":{"required":null}, "enum":[{"required":null}],
            "examples":[{"type":"object", "required":null}]
        }}}]});
        let before = body.clone();
        normalize_grok_tools(&mut body);
        assert_eq!(body, before);
    }

    #[test]
    fn grok_schema_visits_schema_containers_without_changing_other_models() {
        let mut body = json!({"model":"grok-4.7", "tools":[{"parameters":{
            "type":"object", "$defs":{"record":{"type":"object"}},
            "properties":{"rows":{"type":"array", "items":[{"type":"object"}, false]}},
            "additionalProperties":{"type":"object"}, "anyOf":[{"required":null}],
            "dependencies":{"a":["b"]}, "then":{"type":"object"}
        }}]});
        normalize_grok_tools(&mut body);
        let schema = &body["tools"][0]["parameters"];
        for path in ["/required", "/$defs/record/required", "/properties/rows/items/0/required",
            "/additionalProperties/required", "/anyOf/0/required", "/then/required"] {
            assert_eq!(schema.pointer(path), Some(&json!([])), "{path}");
        }
        assert_eq!(schema["dependencies"]["a"], json!(["b"]));
        assert_eq!(schema["properties"]["rows"]["items"][1], false);
        let mut other = json!({"model":"other-model", "tools":[{"parameters":{"type":"object", "required":null}}]});
        let before = other.clone();
        normalize_grok_tools(&mut other);
        assert_eq!(other, before);
        let mut plain = json!({"model":"grok-4.7", "messages":[{"role":"user", "content":"OK"}]});
        let before = plain.clone();
        normalize_grok_tools(&mut plain);
        assert_eq!(plain, before);
    }
}
