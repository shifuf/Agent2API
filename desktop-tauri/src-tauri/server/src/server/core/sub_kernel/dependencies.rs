//! Preserve subscription-local proxy chains when promoting nodes to top-level aliases.
//! Only groups reachable from a node's dialer-proxy are imported; unrelated routing
//! groups/rules and provider URLs from a full Clash configuration are not activated.
use super::{alias_of_key, node_key};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

struct Resolver<'a> {
    nodes: &'a HashMap<String, Value>,
    groups: &'a HashMap<String, Value>,
    visiting: HashSet<String>,
    proxies: BTreeMap<String, Value>,
    imported: BTreeMap<String, Value>,
}

pub(super) fn inline(
    nodes: &HashMap<String, Value>,
    groups: &HashMap<String, Value>,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let mut resolver = Resolver {
        nodes, groups, visiting: HashSet::new(),
        proxies: BTreeMap::new(), imported: BTreeMap::new(),
    };
    let mut keys: Vec<_> = nodes.keys().collect();
    keys.sort();
    for key in keys {
        resolver.visit(key)?;
    }
    let mut keys: Vec<_> = groups.keys().collect();
    keys.sort();
    for key in keys {
        // Unsupported unrelated routing groups must not prevent usable nodes from
        // starting. Required dialer dependencies above still fail closed.
        let previous_proxies: HashSet<_> = resolver.proxies.keys().cloned().collect();
        let previous_groups: HashSet<_> = resolver.imported.keys().cloned().collect();
        if resolver.visit(key).is_err() {
            resolver.proxies.retain(|key, _| previous_proxies.contains(key));
            resolver.imported.retain(|key, _| previous_groups.contains(key));
            resolver.visiting.clear();
        }
    }
    Ok((resolver.proxies.into_values().collect(), resolver.imported.into_values().collect()))
}

impl Resolver<'_> {
    fn reference(&mut self, provider: &str, name: &str) -> Result<String, String> {
        let key = node_key(provider, name);
        if self.nodes.contains_key(&key) || self.groups.contains_key(&key) {
            self.visit(&key)?;
            Ok(alias_of_key(&key))
        } else if matches!(name, "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE") {
            Ok(name.to_string())
        } else {
            Err(format!("订阅 {provider} 的代理链依赖「{name}」不存在；请导入包含对应节点和 proxy-groups 的完整 Clash YAML"))
        }
    }

    fn visit(&mut self, key: &str) -> Result<(), String> {
        if self.proxies.contains_key(key) || self.imported.contains_key(key) {
            return Ok(());
        }
        if self.visiting.len() >= 128 || !self.visiting.insert(key.to_string()) {
            return Err(format!("订阅代理链存在循环或嵌套过深：{key}"));
        }
        let (provider, _) = key.split_once("::").ok_or("订阅节点标识无效")?;
        if self.nodes.contains_key(key) && self.groups.contains_key(key) {
            return Err(format!("订阅节点与代理组重名：{key}"));
        }
        let is_group = !self.nodes.contains_key(key);
        let definition = self.nodes.get(key).or_else(|| self.groups.get(key))
            .ok_or_else(|| format!("订阅代理链依赖不存在：{key}"))?;
        let mut entry = definition.as_object().cloned()
            .ok_or_else(|| format!("订阅代理定义无效：{key}"))?;
        entry.insert("name".into(), Value::String(alias_of_key(key)));
        if let Some(dialer) = entry.get("dialer-proxy") {
            let name = dialer.as_str().ok_or_else(|| format!("订阅 dialer-proxy 必须是名称：{key}"))?;
            if !name.is_empty() {
                let target = self.reference(provider, name)?;
                entry.insert("dialer-proxy".into(), Value::String(target));
            }
        }
        if is_group {
            // Dynamic/external providers cannot be copied without also importing their
            // fetch and selection semantics. Refuse rather than change the route silently.
            if entry.get("use").is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
                || ["include-all", "include-all-proxies", "include-all-providers"].iter()
                    .any(|field| entry.get(*field).and_then(Value::as_bool) == Some(true))
                || ["filter", "exclude-filter", "exclude-type"].iter()
                    .any(|field| entry.get(*field).and_then(Value::as_str).is_some_and(|v| !v.is_empty()))
            {
                return Err(format!("订阅代理链依赖的组 {key} 使用动态成员或筛选规则；请先展开为显式 proxies 列表"));
            }
            let members = entry.get("proxies").and_then(Value::as_array)
                .filter(|members| !members.is_empty())
                .ok_or_else(|| format!("订阅代理链依赖的组没有显式成员：{key}"))?;
            let mut rewritten = Vec::with_capacity(members.len());
            for member in members {
                let name = member.as_str().ok_or_else(|| format!("订阅代理组成员必须是名称：{key}"))?;
                rewritten.push(Value::String(self.reference(provider, name)?));
            }
            entry.insert("proxies".into(), Value::Array(rewritten));
            self.imported.insert(key.to_string(), Value::Object(entry));
        } else {
            self.proxies.insert(key.to_string(), Value::Object(entry));
        }
        self.visiting.remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_chain_groups_are_isolated_per_subscription_and_keep_member_order() {
        let mut nodes = HashMap::new();
        let mut groups = HashMap::new();
        for id in ["one", "two"] {
            nodes.insert(node_key(id, "exit"), json!({"name":"exit","server":format!("{id}.exit"),"dialer-proxy":"front"}));
            nodes.insert(node_key(id, "entry"), json!({"name":"entry","server":format!("{id}.entry")}));
            groups.insert(node_key(id, "front"), json!({"name":"front","type":"select","proxies":["nested","DIRECT"]}));
            groups.insert(node_key(id, "nested"), json!({"name":"nested","type":"fallback","url":"https://example.com/check","interval":600,"proxies":["entry"]}));
            groups.insert(node_key(id, "unused"), json!({"name":"unused","proxies":["missing"]}));
        }
        let (proxies, imported) = inline(&nodes, &groups).unwrap();
        assert_eq!(imported.len(), 4);
        for id in ["one", "two"] {
            let exit = proxies.iter().find(|p| p["server"] == format!("{id}.exit")).unwrap();
            let front = imported.iter().find(|g| g["name"] == exit["dialer-proxy"]).unwrap();
            assert_eq!(front["proxies"][1], "DIRECT");
            let nested = imported.iter().find(|g| g["name"] == front["proxies"][0]).unwrap();
            assert_eq!(nested["type"], "fallback");
            assert_eq!(nested["interval"], 600);
            let entry = proxies.iter().find(|p| p["name"] == nested["proxies"][0]).unwrap();
            assert_eq!(entry["server"], format!("{id}.entry"));
        }
    }

    #[test]
    fn missing_cyclic_and_dynamic_dependencies_fail_without_direct_fallback() {
        let nodes = HashMap::from([(node_key("sub", "exit"), json!({"name":"exit","dialer-proxy":"front"}))]);
        assert!(inline(&nodes, &HashMap::new()).unwrap_err().contains("不存在"));
        for group in [
            json!({"name":"front","type":"select","proxies":["exit"]}),
            json!({"name":"front","type":"select","proxies":["DIRECT"],"use":["external"]}),
            json!({"name":"front","type":"select","include-all":true}),
        ] {
            assert!(inline(&nodes, &HashMap::from([(node_key("sub", "front"), group)])).is_err());
        }
    }
}
