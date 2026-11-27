use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use reqwest::{Client, Url};

use super::types::normalize_domain;

pub(crate) fn endpoint(domain: &str, raw: &str) -> Option<Url> {
    if raw.len() > 1024 || normalize_domain(domain).ok()?.as_str() != domain { return None; }
    let rest = raw.strip_prefix("https://")?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority != domain && authority != format!("{domain}:443") { return None; }
    if !path.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte)) || path.split('/').any(|segment| matches!(segment, "." | "..")) { return None; }
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "https" && url.host_str() == Some(domain) && url.port_or_known_default() == Some(443)).then_some(url)
}

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [first, second, third, _] = ip.octets();
            first > 0 && first < 224 && !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_documentation()
                && !(first == 100 && (64..128).contains(&second)) && !(first == 192 && (second == 0 && third == 0 || second == 88 && third == 99))
                && !(first == 198 && matches!(second,18|19))
        }
        IpAddr::V6(ip) => {
            let [first,second,..] = ip.segments();
            first & 0xe000 == 0x2000 && !matches!(first,0x2002|0x3ffe) && !(first == 0x2001 && (second < 0x200 || second == 0xdb8)) && !(first == 0x3fff && second < 0x1000)
        }
    }
}

fn permitted_addresses(addresses: &[SocketAddr]) -> bool {
    !addresses.is_empty() && addresses.len() <= 64 && addresses.iter().all(|address| address.port() == 443 && public(address.ip()))
}

fn pinned(host: &str, addresses: &[SocketAddr]) -> reqwest::ClientBuilder {
    Client::builder().no_proxy().http1_only().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never())
        .timeout(Duration::from_secs(5)).resolve_to_addrs(host, addresses)
}

async fn head(client: Client, url: Url, addresses: &[SocketAddr]) -> Option<u16> {
    let response = client.head(url).header("accept-encoding","identity").send().await.ok()?;
    if response.status().is_redirection() || !addresses.contains(&response.remote_addr()?) { return None; }
    Some(response.status().as_u16())
}

pub(super) async fn status(domain: &str, raw: &str, deadline: Instant, authorized: impl Fn() -> bool) -> Option<u16> {
    let url = endpoint(domain, raw)?;
    if !authorized() { return None; }
    let request = async {
        let absolute_name = format!("{domain}.");
        let addresses: Vec<_> = tokio::net::lookup_host((absolute_name.as_str(),443)).await.ok()?.take(65).collect();
        if !permitted_addresses(&addresses) || !authorized() { return None; }
        let client = pinned(domain, &addresses).https_only(true).build().ok()?;
        head(client, url, &addresses).await
    };
    let deadline = deadline.min(Instant::now() + Duration::from_secs(5));
    let mut pulse = tokio::time::interval(Duration::from_millis(40));
    tokio::pin!(request);
    loop {
        tokio::select! {
            biased;
            _ = pulse.tick() => if Instant::now() >= deadline || !authorized() { return None; },
            result = &mut request => return result.filter(|_| Instant::now() < deadline && authorized()),
        }
    }
}

#[cfg(test)]
mod tests;
