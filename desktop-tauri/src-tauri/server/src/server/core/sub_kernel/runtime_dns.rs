//! Keep direct DNS bootstrap resolvers from full subscriptions inside Mihomo.
//! ECH needs HTTPS records, which the host resolver may not return. A source's
//! DNS listeners, fake-IP mode and routing policies are not gateway settings.
use super::ProviderInput;
use serde_json::{json, Value};

const FIELDS: [&str; 4] = [
    "nameserver", "default-nameserver", "proxy-server-nameserver", "direct-nameserver",
];

pub(super) fn load(providers: &[ProviderInput]) -> Option<Value> {
    let mut resolvers: [Vec<Value>; 4] = std::array::from_fn(|_| Vec::new());
    for provider in providers {
        let content = if provider.content.is_empty() {
            let file = crate::server::core::sub_kernel::kernel_dir()
                .join("providers").join(format!("sub_{}.yaml", provider.id));
            match std::fs::read_to_string(file) {
                Ok(content) => content,
                Err(_) => continue,
            }
        } else {
            provider.content.clone()
        };
        let Ok(source) = serde_yaml::from_str::<Value>(&content) else { continue };
        let dns = &source["dns"];
        if dns["enable"] != true { continue; }
        for (index, field) in FIELDS.iter().enumerate() {
            for server in dns[*field].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let server = server.trim();
                // A # fragment can refer to a source routing group or policy.
                // Importing those globally could change another subscription's
                // route or create a DNS/dialer cycle. Only direct bootstrap
                // resolvers are shared; scoped policies stay in the source.
                if server.is_empty() || server.contains('#') { continue; }
                let server = Value::String(server.to_string());
                if !resolvers[index].contains(&server) { resolvers[index].push(server); }
            }
        }
    }
    if resolvers[0].is_empty() { return None; }
    let mut output = json!({ "enable": true, "ipv6": false });
    for (field, servers) in FIELDS.into_iter().zip(resolvers) {
        if !servers.is_empty() { output[field] = Value::Array(servers); }
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, source: Value) -> ProviderInput {
        ProviderInput { id: id.into(), name: id.into(), url: String::new(),
            content: source.to_string() }
    }

    #[test]
    fn full_sources_share_direct_bootstrap_without_exposing_dns_or_source_routes() {
        let sources = [
            provider("one", json!({"dns":{"enable":true,"listen":"0.0.0.0:1053",
                "enhanced-mode":"fake-ip","nameserver":["https://dns.example/query","https://scoped.example/query#exit"],
                "default-nameserver":["223.5.5.5"],"proxy-server-nameserver":["https://dns.example/query"],
                "nameserver-policy":{"geosite:cn":["https://policy.example/query"]}}})),
            provider("two", json!({"dns":{"enable":true,
                "nameserver":["https://dns.example/query","https://second.example/query"],
                "direct-nameserver":["119.29.29.29"]}})),
            provider("off", json!({"dns":{"enable":false,"nameserver":["https://disabled.example/query"]}})),
        ];
        assert_eq!(load(&sources), Some(json!({"enable":true,"ipv6":false,
            "nameserver":["https://dns.example/query","https://second.example/query"],
            "default-nameserver":["223.5.5.5"],"proxy-server-nameserver":["https://dns.example/query"],
            "direct-nameserver":["119.29.29.29"]})));
        assert!(load(&[provider("scoped", json!({"dns":{"enable":true,
            "nameserver":["https://dns.example/query#exit"]}}))]).is_none());
    }
}
