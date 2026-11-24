use std::sync::{Arc, OnceLock};
use std::time::Duration;

use agent2api_provider_protocol as proto;
use serde_json::{json, Value};
use wasmtime::{Caller, Config, Engine, Linker, Memory, Module, Store, StoreLimitsBuilder};

use super::context::{Context, Shared, Sink};

struct State {
    context: Context,
    limits: super::limits::Limits,
    reply: Vec<u8>,
}

pub struct Runtime {
    pub shared: Arc<Shared>,
    module: Module,
    module_digest: String,
    linker: Linker<State>,
}

fn engine() -> Result<Engine, String> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut config = Config::new();
        config.async_support(true).consume_fuel(true).max_wasm_stack(512 * 1024);
        Engine::new(&config).map_err(|error| format!("Wasm 运行环境初始化失败：{error}"))
    }).clone()
}

fn memory(caller: &mut Caller<'_, State>) -> wasmtime::Result<Memory> {
    caller.get_export("memory").and_then(|export| export.into_memory())
        .ok_or_else(|| wasmtime::Error::msg("Wasm 缺少内存导出"))
}

fn read(caller: &mut Caller<'_, State>, pointer: i32, length: i32) -> wasmtime::Result<Vec<u8>> {
    if pointer < 0 || length < 0 || length as usize > caller.data().context.message_limit() {
        return Err(wasmtime::Error::msg("Wasm 消息长度无效"));
    }
    let memory = memory(caller)?;
    let end = (pointer as usize).checked_add(length as usize).ok_or_else(|| wasmtime::Error::msg("Wasm 内存越界"))?;
    let data = memory.data(&*caller).get(pointer as usize..end)
        .ok_or_else(|| wasmtime::Error::msg("Wasm 内存越界"))?;
    Ok(data.to_vec())
}

impl Runtime {
    pub async fn load(path: std::path::PathBuf, shared: Arc<Shared>) -> Result<Arc<Self>, String> {
        let engine = engine()?;
        let compiler = engine.clone();
        let permit = super::compile_slot().acquire().await.map_err(|_| "Wasm 编译队列已关闭")?;
        let (module, module_digest) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let metadata = std::fs::metadata(&path).map_err(|_| "Wasm 文件不可读".to_string())?;
            if metadata.len() > 16 * 1024 * 1024 { return Err("Wasm 文件超过 16 MiB 上限".into()); }
            let bytes = std::fs::read(path).map_err(|_| "Wasm 文件不可读".to_string())?;
            if bytes.len() > 16 * 1024 * 1024 { return Err("Wasm 文件超过 16 MiB 上限".into()); }
            if !bytes.starts_with(b"\0asm\x01\0\0\0") { return Err("插件入口不是 Wasm 模块".into()); }
            let digest = super::super::install::sha256_hex(&bytes);
            Module::new(&compiler, &bytes).map(|module| (module, digest))
                .map_err(|error| format!("Wasm 模块校验失败：{error}"))
        }).await.map_err(|_| "Wasm 编译任务中断".to_string())??;
        for import in module.imports() {
            if import.module() != "agent2api" || !matches!(import.name(), "call" | "read") {
                return Err("Wasm 模块导入了未授权的系统接口".into());
            }
        }
        let mut linker: Linker<State> = Linker::new(&engine);
        linker.func_wrap_async("agent2api", "call", |mut caller: Caller<'_, State>, (ptr, len): (i32, i32)| {
            Box::new(async move {
                let started = tokio::time::Instant::now();
                let bytes = read(&mut caller, ptr, len)?;
                let input: Value = serde_json::from_slice(&bytes).map_err(|_| wasmtime::Error::msg("Wasm 主程序调用不是 JSON"))?;
                let method = input["method"].as_str().ok_or_else(|| wasmtime::Error::msg("Wasm 调用缺少方法"))?;
                let result = caller.data_mut().context.invoke_at(method, input["params"].clone(), started).await;
                let result = match result {
                    Ok(result) => json!({ "result": result }),
                    Err(error) => json!({ "error": error }),
                };
                let reply = serde_json::to_vec(&result).map_err(|_| wasmtime::Error::msg("Wasm 回应序列化失败"))?;
                if reply.len() > caller.data().context.message_limit() { return Err(wasmtime::Error::msg("Wasm 主程序回应过大")); }
                let length = reply.len() as i32;
                caller.data_mut().reply = reply;
                Ok(length)
            })
        }).map_err(|error| error.to_string())?;
        linker.func_wrap("agent2api", "read", |mut caller: Caller<'_, State>, pointer: i32, capacity: i32| -> wasmtime::Result<i32> {
            let length = caller.data().reply.len();
            if pointer < 0 || capacity < 0 || (capacity as usize) < length {
                return Err(wasmtime::Error::msg("Wasm 回应缓冲区不足"));
            }
            let memory = memory(&mut caller)?;
            let reply = std::mem::take(&mut caller.data_mut().reply);
            memory.write(&mut caller, pointer as usize, &reply)?;
            Ok(length as i32)
        }).map_err(|error| error.to_string())?;
        Ok(Arc::new(Self { shared, module, module_digest, linker }))
    }

    pub(crate) fn module_digest(&self) -> &str { &self.module_digest }

    pub async fn invoke(&self, method: &str, params: Value, timeout: Duration, sink: Option<Sink>) -> Result<Value, proto::WireError> {
        self.invoke_scoped(method, params, timeout, sink, None, None, None, None, None).await
    }

    pub(super) async fn invoke_claim(&self, method: &str, params: Value, timeout: Duration,
        owner: Option<super::verification::lease::Owner>) -> Result<Value, proto::WireError> {
        self.invoke_scoped(method, params, timeout, None, None, owner, None, None, None).await
    }

    pub(super) async fn invoke_verification(&self, call: super::verification::VerificationCall) -> Result<Value, proto::WireError> {
        let params = call.params();
        let timeout = call.remaining();
        self.invoke_scoped("admin.action", params, timeout, None, Some(call), None, None, None, None).await
    }

    pub(super) async fn invoke_managed(&self, call: crate::server::core::login::managed::Call,
        params: Value, timeout: Duration) -> Result<Value, proto::WireError> {
        call.validate(&self.shared.options.provider).map_err(super::managed::wire)?;
        let method = call.method();
        self.invoke_scoped(method, params, timeout, None, None, None, Some(call), None, None).await
    }

    pub(super) async fn invoke_desktop_import(&self, call: super::native::chatglm::DesktopCall,
        params: Value, timeout: Duration) -> Result<Value, proto::WireError> {
        self.invoke_scoped(proto::methods::gateway::ACCOUNT_NORMALIZE, params, timeout,
            None, None, None, None, Some(call), None).await
    }

    pub(super) async fn invoke_conversation(&self, call: super::conversation::ConversationCall,
        mut ended: super::conversation::ExecutionGuard, params: Value, sink: Sink,
    ) -> Result<Value, proto::WireError> {
        if !ended.matches(&call) {
            return Err(proto::WireError::with_code("Wasm 执行结束守卫不属于原对话调用", "forbidden"));
        }
        let timeout = call.deadline().saturating_duration_since(tokio::time::Instant::now());
        let result = self.invoke_scoped(proto::methods::gateway::CONVERSATION, params, timeout,
            Some(sink), None, None, None, None, Some(call)).await;
        // 守卫在 Host spawn 前签发；未 poll、排队取消、超时和 trap 都能留下真实退场事实。
        ended.finish(result.is_ok());
        result
    }

    async fn invoke_scoped(&self, method: &str, params: Value, timeout: Duration, sink: Option<Sink>,
        verification: Option<super::verification::VerificationCall>, claim_owner: Option<super::verification::lease::Owner>,
        managed: Option<crate::server::core::login::managed::Call>,
        desktop_import: Option<super::native::chatglm::DesktopCall>,
        conversation: Option<super::conversation::ConversationCall>,
    ) -> Result<Value, proto::WireError> {
        // One absolute deadline includes waiting for both concurrency queues.
        let call_deadline = (tokio::time::Instant::now() + timeout)
            .min(managed.as_ref().map(|call| call.deadline()).unwrap_or(tokio::time::Instant::now() + timeout))
            .min(conversation.as_ref().map(|call| call.deadline()).unwrap_or(tokio::time::Instant::now() + timeout));
        let cancel = sink.as_ref().map(|sink| sink.cancel.clone()).unwrap_or_else(|| self.shared.cancel.child_token());
        let original_cancel = conversation.as_ref().and_then(|call| call.call_cancel());
        let streaming = sink.is_some() || matches!(method, "images.generate" | "images.edit" | "tasks.run");
        let work = async {
            let slots = if streaming { &self.shared.slots } else { &self.shared.control_slots };
            let _slot = if verification.is_none() { Some(slots.acquire().await.map_err(|_|
                proto::WireError::with_code("Wasm 插件已关闭", "plugin_unavailable"))?) } else { None };
            let _global = if verification.is_none() { Some(super::global_slots(streaming).acquire().await
                .map_err(|_| proto::WireError::with_code("Wasm 运行环境已关闭", "plugin_unavailable"))?) } else { None };
            if method != proto::methods::gateway::INIT && params["provider"].as_str() != Some(self.shared.options.provider.as_str()) {
                return Err(proto::WireError::with_code("调用不属于当前插件提供商", "forbidden"));
            }
            if matches!(method, "images.generate" | "images.edit") && !self.shared.options.allows("images.v1") {
                return Err(proto::WireError::with_code("插件未声明标准图片能力", "forbidden"));
            }
            if method == "tasks.run" && !self.shared.options.allows("tasks.v1") {
                return Err(proto::WireError::with_code("插件未声明后台任务能力", "forbidden"));
            }
            if method == proto::methods::gateway::CONVERSATION && conversation.is_none() {
                return Err(proto::WireError::with_code("Wasm 对话必须由原模型请求及调用租约发起", "forbidden"));
            }
            let mut context = Context::new(self.shared.clone(), &params, sink, call_deadline);
            if let Some(call) = conversation {
                call.validate_params(&self.shared, &params)?;
                if self.shared.options.provider == "catpaw" {
                    context.catpaw_material = Some(Arc::new(super::conversation::CatPawMaterial::from_call_body(&call, &params["body"])?));
                }
                context.conversation = Some(call);
            }
            if let Some(call) = verification { call.validate().await?; context.bind_verification(call); }
            context.claim_owner = claim_owner;
            if let Some(call) = managed {
                call.validate(&self.shared.options.provider).map_err(super::managed::wire)?;
                if params["flow"].as_str() != Some(call.flow()) { return Err(proto::WireError::with_code("登录流程与可信调用不一致", "forbidden")); }
                context.managed = Some(call);
            }
            if let Some(call) = desktop_import {
                call.enter_context(self, method, &params)?;
                context.desktop_import = Some(call);
            }
            // These flags are issued by this actual host invocation, never by guest JSON.
            context.account_maintenance = matches!(method, "token.refresh" | "usage.query" | "checkin.claim" | "admin.action");
            if method == proto::methods::gateway::ACCOUNT_NORMALIZE {
                context.desktop_selected = params["source"]["kind"] == "desktop";
                if super::legacy_credentials::selected(&self.shared.options.provider, &params)? {
                    context.permission("credentials.legacy-import.v1")?;
                    context.supplied_legacy_credentials = Some(super::legacy_credentials::prepare(&self.shared.options.provider)?);
                }
            }
            if context.flow.len() > 256 || context.session.len() > 1024 || context.session.contains('\0') {
                return Err(proto::WireError::with_code("登录或会话标识无效", "bad_params"));
            }
            if !context.account.is_empty() { context.invoke("account.get", json!({})).await?; }
            let mut params = params;
            if let Some(map) = params.as_object_mut() {
                for key in ["proxy", "proxy_override", "plugin_trace", "client_stream"] { map.remove(key); }
                if let Some(payload) = map.get_mut("payload").and_then(Value::as_object_mut) { payload.remove("proxy"); }
                if let Some(payload) = map.get_mut("source").and_then(|source| source.get_mut("payload")).and_then(Value::as_object_mut) {
                    payload.remove("proxy");
                }
                if let Some(headers) = map.get_mut("headers").and_then(Value::as_object_mut) {
                    headers.retain(|name, _| !matches!(name.to_ascii_lowercase().as_str(),
                        "authorization" | "x-api-key" | "api-key" | "cookie" | "proxy-authorization"));
                }
            }
            let limits = StoreLimitsBuilder::new().memory_size(self.shared.options.manifest.memory_mib * 1024 * 1024)
                .instances(1).memories(1).tables(2).table_elements(100_000).trap_on_grow_failure(true).build();
            let limits = super::limits::Limits { store: limits, exhausted: false };
            let mut store = Store::new(self.module.engine(), State { context, limits, reply: Vec::new() });
            store.limiter(|state| &mut state.limits);
            let fuel = if store.data().context.verification.is_some() { super::verification::FUEL } else { 2_000_000_000 };
            store.set_fuel(fuel).map_err(|_| super::error("Wasm 计算配额配置失败"))?;
            store.fuel_async_yield_interval(Some(100_000)).map_err(|_| super::error("Wasm 调度配置失败"))?;
            let result = self.execute(&mut store, method, params).await;
            if let Some(error) = store.data().context.catpaw_service.failure() { return Err(error); }
            match result {
                Ok(mut value) => {
                    if let Some(call) = &store.data().context.managed {
                        call.validate(&self.shared.options.provider).map_err(super::managed::wire)?;
                    }
                    if let Some(call) = &store.data().context.desktop_import { call.validate(&self.shared)?; }
                    if matches!(method, "images.generate" | "images.edit") {
                        super::resources::materialize(&mut value, &store.data().context.blobs, &self.shared.options)?;
                    }
                    Ok(value)
                }
                Err(_) if store.data().limits.exhausted => Err(proto::WireError::with_code(
                    "Wasm 插件超过内存或表容量限制", "plugin_resource_limit")),
                Err(error) => Err(super::errors::interrupted(&error)),
            }
        };
        tokio::select! {
            biased;
            _ = self.shared.cancel.cancelled() => Err(proto::WireError::with_code("Wasm 插件已关闭", "plugin_unavailable")),
            _ = cancel.cancelled() => Err(proto::WireError::with_code("Wasm 调用已取消", proto::WireError::ABORTED)),
            _ = async {
                match original_cancel { Some(token) => token.cancelled().await, None => std::future::pending::<()>().await }
            } => Err(proto::WireError::with_code("原模型请求已取消", proto::WireError::ABORTED)),
            result = tokio::time::timeout_at(call_deadline, work) => result
                .map_err(|_| proto::WireError::with_code("Wasm 插件调用超时", "timeout"))?,
        }
    }

    async fn execute(&self, store: &mut Store<State>, method: &str, params: Value) -> wasmtime::Result<Value> {
        let instance = self.linker.instantiate_async(&mut *store, &self.module).await?;
        let abi = instance.get_typed_func::<(), i32>(&mut *store, "a2a_abi_version")?;
        if abi.call_async(&mut *store, ()).await? != super::manifest::ABI as i32 {
            return Err(wasmtime::Error::msg("Wasm 导出接口版本不一致"));
        }
        let allocate = instance.get_typed_func::<i32, i32>(&mut *store, "a2a_alloc")?;
        let call = instance.get_typed_func::<(i32, i32), i64>(&mut *store, "a2a_call")?;
        let memory = instance.get_memory(&mut *store, "memory").ok_or_else(|| wasmtime::Error::msg("Wasm 内存导出缺失"))?;
        let bytes = serde_json::to_vec(&json!({ "method": method, "params": params }))?;
        if bytes.len() > store.data().context.message_limit() { return Err(wasmtime::Error::msg("Wasm 输入消息过大")); }
        let pointer = allocate.call_async(&mut *store, bytes.len() as i32).await?;
        if pointer < 0 { return Err(wasmtime::Error::msg("Wasm 分配地址无效")); }
        memory.write(&mut *store, pointer as usize, &bytes)?;
        let packed = call.call_async(&mut *store, (pointer, bytes.len() as i32)).await? as u64;
        let pointer = (packed & 0xffff_ffff) as usize;
        let length = (packed >> 32) as usize;
        if length > store.data().context.message_limit() { return Err(wasmtime::Error::msg("Wasm 输出消息过大")); }
        let data = memory.data(&*store).get(pointer..pointer.checked_add(length).ok_or_else(|| wasmtime::Error::msg("Wasm 输出越界"))?)
            .ok_or_else(|| wasmtime::Error::msg("Wasm 输出越界"))?;
        serde_json::from_slice(data).map_err(Into::into)
    }
}
