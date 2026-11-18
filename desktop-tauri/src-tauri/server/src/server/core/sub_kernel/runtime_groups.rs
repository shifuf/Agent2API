//! Safe management view of subscription groups. Controller credentials never leave here.
use super::*;
use std::sync::{Arc, Mutex};
use std::io::Write;

pub static CONTROL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TEST: Mutex<Option<(String, Arc<tokio::sync::Notify>)>> = Mutex::new(None);
static LIST_LIMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
const CHOICES: &str = "group-selections.json";

fn choices() -> Value {
    std::fs::read(crate::server::core::sub_kernel::kernel_dir().join(CHOICES))
        .ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

pub(super) fn restore_config(config: &str, groups: &HashMap<String, Value>) -> Result<String, String> {
    let mut config: Value = serde_yaml::from_str(config).map_err(|_| "代理组配置无效")?;
    let saved = choices();
    if let Some(entries) = config["proxy-groups"].as_array_mut() {
        for (key, definition) in groups {
            let Some(selected) = saved.get(key).and_then(Value::as_str) else { continue };
            let Some((provider, _)) = key.split_once("::") else { continue };
            if definition["type"] != "select" || !definition["proxies"].as_array()
                .is_some_and(|members| members.iter().any(|m| m == selected)) { continue; }
            let alias = alias_of_key(key);
            if let Some(group) = entries.iter_mut().find(|g| g["name"] == alias) {
                if let Some(members) = group["proxies"].as_array_mut() {
                    let target = node_alias(provider, selected);
                    if let Some(index) = members.iter().position(|m| m == &target || m == selected) {
                        let member = members.remove(index);
                        members.insert(0, member);
                    }
                }
            }
        }
    }
    serde_yaml::to_string(&config).map_err(|_| "代理组配置编码失败".to_string())
}

fn connection() -> Result<(u16, String), String> {
    if crate::server::core::sub_kernel::is_manually_halted() {
        return Err("内核已手动关闭，请先启动内核".into());
    }
    let state = read_state();
    let port = state["controllerPort"].as_u64().and_then(|p| u16::try_from(p).ok())
        .ok_or("内核尚未就绪")?;
    let secret = state["secret"].as_str().filter(|s| !s.is_empty()).ok_or("内核尚未就绪")?;
    Ok((port, secret.to_string()))
}

fn text<'a>(input: &'a Value, name: &str) -> &'a str {
    input.get(name).and_then(Value::as_str).unwrap_or("")
}

fn catalog() -> (Vec<ProviderInput>, HashMap<String, Value>, HashMap<String, Value>) {
    let providers = crate::server::core::subscriptions::enabled_provider_inputs();
    let nodes = read_provider_definitions(&providers);
    let groups = read_provider_groups(&providers);
    (providers, nodes, groups)
}

fn original(alias: &str, provider: &str, nodes: &HashMap<String, Value>, groups: &HashMap<String, Value>) -> String {
    nodes.iter().chain(groups.iter()).find_map(|(key, value)| {
        (key.starts_with(&format!("{provider}::")) && alias_of_key(key) == alias)
            .then(|| value["name"].as_str().unwrap_or(alias).to_string())
    }).unwrap_or_else(|| alias.to_string())
}

/// Summaries omit members; expand uses a separate request to avoid mounting huge lists.
pub async fn list(input: Option<&Value>) -> Result<Value, String> {
    let _permit = LIST_LIMIT.try_acquire().map_err(|_| "代理组正在刷新，请稍后重试")?;
    let input = input.cloned();
    let parsed = tokio::task::spawn_blocking(catalog).await.map_err(|_| "读取订阅失败")?;
    let (providers, nodes, groups) = parsed;
    let live = if let Ok((port, secret)) = connection() {
        controller_get(port, &secret, "/proxies").await.unwrap_or_else(|| json!({}))
    } else { json!({}) };
    let saved = choices();
    let selections = live["proxies"].as_object()
        .map(|all| all.iter().filter(|(name, value)| name.starts_with("wbn_") && value.get("now").is_some())
            .map(|(name, value)| (name.clone(), value["now"].clone())).collect::<std::collections::BTreeMap<_, _>>())
        .unwrap_or_default();
    let chain_revision = short_hash(&serde_json::to_string(&selections).unwrap_or_default());
    let mut output = Vec::new();
    for provider in providers {
        // Source order matters to the user (front first, exit second).
        let source = std::fs::read_to_string(crate::server::core::sub_kernel::kernel_dir()
            .join("providers").join(format!("sub_{}.yaml", provider.id))).unwrap_or_default();
        let parsed: Value = serde_yaml::from_str(&source).unwrap_or_default();
        for definition in parsed["proxy-groups"].as_array().into_iter().flatten() {
            let name = text(definition, "name");
            if name.is_empty() { continue; }
            if let Some(input) = input.as_ref() {
                if text(input, "providerId") != provider.id || text(input, "group") != name { continue; }
            }
            let key = node_key(&provider.id, name);
            let alias = alias_of_key(&key);
            let status = &live["proxies"][&alias];
            let selected = status["now"].as_str().map(|s| original(s, &provider.id, &nodes, &groups));
            let members: Vec<_> = definition["proxies"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).collect();
            let stale = saved[&key].as_str().is_some_and(|s| !members.contains(&s));
            let mut row = json!({"providerId":provider.id,"subscription":provider.name,
                "name":name,"type":definition["type"],"count":members.len(),
                "selected":selected,"available":!status.is_null(),
                "selectable":status["type"]=="Selector","selectionRemoved":stale,
                "error":if status.is_null() {Some("代理组尚未加载：请检查内核状态及组格式")} else {None}});
            if input.is_some() {
                row["members"] = Value::Array(members.iter().map(|member| {
                    let key = node_key(&provider.id, member);
                    let node = nodes.get(&key).or_else(|| groups.get(&key));
                    let alias = if node.is_some() {alias_of_key(&key)} else {member.to_string()};
                    let status = &live["proxies"][&alias];
                    let dialer = node.and_then(|n| n["dialer-proxy"].as_str());
                    let front = dialer.map(|d| {
                        let a = node_alias(&provider.id, d);
                        let current = live["proxies"][&a]["now"].as_str().unwrap_or(d);
                        original(current, &provider.id, &nodes, &groups)
                    });
                    json!({"name":member,"type":node.map(|n| &n["type"]),
                        "server":node.and_then(|n| n["server"].as_str()),
                        "dialer":dialer,"front":front,"isGroup":groups.contains_key(&key),
                        "delay":status["history"].as_array().and_then(|h|h.last()).and_then(|h|h["delay"].as_u64())})
                }).collect());
            }
            output.push(row);
        }
    }
    if input.is_some() && output.is_empty() { return Err("代理组不存在或订阅已禁用".into()); }
    Ok(json!({"groups":output,"revision":chain_revision}))
}

fn validate(input: &Value, groups: &HashMap<String, Value>) -> Result<(String, String, String), String> {
    let provider = text(input, "providerId");
    let group = text(input, "group");
    let node = text(input, "node");
    let definition = groups.get(&node_key(provider, group)).ok_or("代理组不存在或订阅已禁用")?;
    if !definition["proxies"].as_array().is_some_and(|a| a.iter().any(|m| m == node)) {
        return Err("节点不是该代理组的成员".into());
    }
    Ok((provider.to_string(), group.to_string(), node.to_string()))
}

pub async fn select(input: &Value) -> Result<Value, String> {
    let _control = CONTROL.try_lock().map_err(|_| "内核正忙，请稍后重试")?;
    let (_, nodes, groups) = catalog();
    let (provider, group, node) = validate(input, &groups)?;
    if groups[&node_key(&provider, &group)]["type"] != "select" {
        return Err("此组由内核自动选择，不能手动切换".into());
    }
    let (port, secret) = connection()?;
    let path = format!("/proxies/{}", node_alias(&provider, &group));
    let old = controller_get(port, &secret, &path).await.ok_or("代理组尚未加载")?;
    let key = node_key(&provider, &node);
    let target = if nodes.contains_key(&key) || groups.contains_key(&key) {alias_of_key(&key)} else {node.clone()};
    controller_put_json(port, &secret, &path, &json!({"name":target})).await?;
    let actual = controller_get(port, &secret, &path).await.ok_or("切换结果读取失败")?;
    if actual["now"] != target { return Err("内核未确认选择，请刷新后重试".into()); }
    let mut saved = choices();
    saved[node_key(&provider, &group)] = json!(node);
    let dir = crate::server::core::sub_kernel::kernel_dir();
    let result = (|| -> Result<(), String> {
        let bytes = serde_json::to_vec(&saved).map_err(|e|e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|e|e.to_string())?;
        file.write_all(&bytes).map_err(|e|e.to_string())?;
        file.as_file().sync_all().map_err(|e|e.to_string())?;
        file.persist(dir.join(CHOICES)).map_err(|e|e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        if let Some(previous) = old["now"].as_str() {
            let _ = controller_put_json(port, &secret, &path, &json!({"name":previous})).await;
        }
        return Err("选择保存失败，请检查数据目录权限并刷新".into());
    }
    // New requests must not reuse an idle upstream connection from the old path.
    // Existing in-flight streams retain their clients and finish normally.
    crate::server::core::egress::invalidate_clients();
    list(Some(input)).await
}

struct TestSlot;
impl Drop for TestSlot {
    fn drop(&mut self) { *TEST.lock().unwrap_or_else(|e|e.into_inner()) = None; }
}

pub fn cancel(input: &Value) -> Value {
    let slot = TEST.lock().unwrap_or_else(|e|e.into_inner());
    let canceled = if let Some((id, notify)) = slot.as_ref() {
        if id == text(input, "id") { notify.notify_one(); true } else {false}
    } else {false};
    json!({"canceled":canceled})
}

pub async fn test(input: &Value) -> Result<Value, String> {
    let id = text(input, "id");
    if id.is_empty() || id.len()>128 { return Err("测速任务标识无效".into()); }
    let notify = Arc::new(tokio::sync::Notify::new());
    {
        let mut slot = TEST.lock().unwrap_or_else(|e|e.into_inner());
        if slot.is_some() { return Err("已有测速正在进行，请先取消或等待完成".into()); }
        *slot = Some((id.to_string(), notify.clone()));
    }
    let _slot = TestSlot;
    let _control = CONTROL.try_lock().map_err(|_| "内核正忙，请稍后重试")?;
    let _test = crate::server::api::proxies::SUB_TEST_LOCK.try_lock().map_err(|_| "测试通道正忙")?;
    let (_, nodes, groups) = catalog();
    let (provider, _, node) = validate(input, &groups)?;
    let key = node_key(&provider, &node);
    if !nodes.contains_key(&key) && !groups.contains_key(&key) {return Err("此成员不支持测速".into());}
    let alias = alias_of_key(&key);
    let (port, secret) = connection()?;
    let kind = text(input, "kind");
    if !matches!(kind, "delay" | "speed" | "exit") { return Err("未知测试类型".into()); }
    let url = text(input, "url");
    let default = if kind == "speed" {"https://speed.cloudflare.com/__down?bytes=5242880"}
        else {"https://www.gstatic.com/generate_204"};
    let url = if url.is_empty() {default} else {url};
    let parsed = reqwest::Url::parse(url).map_err(|_| "测试网址无效")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some() || url.len()>2048 {
        return Err("测试网址必须是无鉴权信息的 HTTP(S) 地址".into());
    }
    let work = async {
        if kind == "delay" {
            let response = controller_client().get(format!("http://127.0.0.1:{port}/proxies/{alias}/delay"))
                .bearer_auth(&secret).query(&[("url",url),("timeout","5000")])
                .timeout(Duration::from_secs(6)).send().await.map_err(|_| "延迟测试超时或失败")?;
            if !response.status().is_success() {return Err("延迟测试失败：节点不可达".to_string());}
            let value: Value = response.json().await.map_err(|_| "延迟结果无效")?;
            return Ok(json!({"delay":value["delay"]}));
        }
        controller_put_json(port, &secret, &format!("/proxies/{TEST_GROUP_NAME}"), &json!({"name":alias})).await?;
        let state = read_state();
        let test_port = state["testPort"].as_u64().ok_or("测试端口未就绪")?;
        if kind == "exit" {
            let proxy = crate::server::core::proxies::ResolvedProxy {
                source:"pool".into(), protocol:"http".into(), host:"127.0.0.1".into(),
                port:Some(test_port as u16), username:String::new(), password:String::new(), label:node.clone(),
            };
            return Ok(crate::server::core::egress::test_proxy(Some(&proxy)).await.to_json());
        }
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{test_port}")).map_err(|_| "测试端口无效")?;
        let client = reqwest::Client::builder().no_proxy().proxy(proxy)
            .redirect(reqwest::redirect::Policy::limited(3)).timeout(Duration::from_secs(6))
            .build().map_err(|_| "无法创建测速连接")?;
        let start = tokio::time::Instant::now();
        let deadline = start + Duration::from_secs(5);
        let mut response = tokio::time::timeout_at(deadline, client.get(url).header("Accept-Encoding","identity").send())
            .await.map_err(|_| "下载测速超时")?.map_err(|_| "下载测速连接失败")?;
        if !response.status().is_success() {return Err(format!("下载测速返回 HTTP {}",response.status().as_u16()));}
        let mut bytes = 0usize;
        while bytes < 5*1024*1024 {
            match tokio::time::timeout_at(deadline, response.chunk()).await {
                Ok(Ok(Some(chunk))) => bytes += chunk.len().min(5*1024*1024-bytes),
                Ok(Ok(None)) | Err(_) => break,
                Ok(Err(_)) => return Err("下载测速中断".into()),
            }
        }
        if bytes==0 { return Err("测试地址没有返回下载数据".into()); }
        let elapsed = start.elapsed().as_secs_f64().max(0.001);
        Ok(json!({"bytes":bytes,"bytesPerSecond":(bytes as f64/elapsed) as u64,"durationMs":(elapsed*1000.0) as u64}))
    };
    let result: Result<Value,String> = tokio::select! {
        _ = notify.notified() => Err("测试已取消".into()),
        result = tokio::time::timeout(Duration::from_secs(20), work) => result.unwrap_or_else(|_|Err("测试超时".into())),
    };
    let mut value = result.unwrap_or_else(|error| json!({"success":false,"error":error}));
    if value.get("success").is_none() {value["success"] = json!(true);}
    value["id"] = json!(id);
    value["kind"] = json!(kind);
    value["at"] = json!(crate::server::logging::now_ms());
    Ok(value)
}
