use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Module, Runtime};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::{store, types::TaskPlugin};
use crate::server::core::notifications;

pub struct SandboxInput {
    pub plugin: TaskPlugin,
    pub job_id: String,
    pub job_name: String,
    pub trigger: String,
    pub action_id: Option<String>,
    pub form_values: BTreeMap<String, Value>,
    pub initial_storage: BTreeMap<String, String>,
    pub proxy_id: String,
    pub timeout_seconds: i64,
    pub preview_mode: bool,
    pub abort: Arc<AtomicBool>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxOutcome {
    pub success: bool,
    pub duration_ms: i64,
    pub output: String,
    pub error: Option<&'static str>,
    #[serde(skip)]
    pub status_patch: Option<BTreeMap<String, String>>,
    #[serde(skip)]
    pub storage_dirty: bool,
    #[serde(skip)]
    notify_requested: bool,
    #[serde(skip)]
    pub new_storage: BTreeMap<String, String>,
}

fn failure(error: &'static str) -> SandboxOutcome { SandboxOutcome { error: Some(error), ..Default::default() } }

pub async fn execute(input: SandboxInput) -> SandboxOutcome {
    static SLOTS: Semaphore = Semaphore::const_new(4);
    let Ok(permit) = SLOTS.try_acquire() else { return failure("任务运行数量已达上限") };
    let (mut outcome, input, _permit) = match tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let mut outcome = run(&input, started);
        outcome.duration_ms = started.elapsed().as_millis() as i64;
        (outcome, input, permit)
    }).await { Ok(result) => result, Err(_) => return failure("任务沙箱不可用") };
    if outcome.notify_requested {
        if !may_notify(&input) || notifications::task_signal(|| !input.abort.load(Ordering::SeqCst) && may_notify(&input)).await.is_err() {
            outcome.success = false;
            outcome.error = Some("任务通知未授权或投递失败");
            outcome.storage_dirty = false;
        }
    }
    outcome
}

fn may_notify(input: &SandboxInput) -> bool {
    !input.preview_mode && input.plugin.enabled && input.plugin.declares_notify && input.plugin.notify_allowed
        && notifications::task_channel_enabled()
        && store::get_plugin(&input.plugin.id).ok().flatten().is_some_and(|current| current.enabled && current.declares_notify && current.notify_allowed && current.created_at == input.plugin.created_at && current.updated_at == input.plugin.updated_at && current.script_body == input.plugin.script_body)
}

fn run(input: &SandboxInput, started: Instant) -> SandboxOutcome {
    run_with_probe(input, started, |domain, url, deadline, authorized| {
        tokio::runtime::Handle::try_current().ok()?.block_on(super::probe::status(domain, url, deadline, authorized))
    })
}

type Probe = fn(&str, &str, Instant, &dyn Fn() -> bool) -> Option<u16>;

pub(super) fn run_with_probe(input: &SandboxInput, started: Instant, perform: Probe) -> SandboxOutcome {
    if !input.proxy_id.is_empty() { return failure("绑定的代理不支持固定目标地址的状态探测，未直连"); }
    let Ok(rt) = Runtime::new() else { return failure("任务沙箱不可用") };
    let deadline = started + Duration::from_secs(input.timeout_seconds.clamp(1, 60) as u64);
    let abort = input.abort.clone();
    let stopped = move || abort.load(Ordering::SeqCst) || Instant::now() >= deadline;
    rt.set_memory_limit(32 * 1024 * 1024);
    rt.set_max_stack_size(512 * 1024);
    rt.set_interrupt_handler(Some(Box::new(stopped.clone())));
    let Ok(context) = Context::full(&rt) else { return failure("任务沙箱不可用") };
    let storage = Rc::new(RefCell::new(input.initial_storage.clone()));
    let permitted = may_notify(input);
    let requested = Rc::new(Cell::new(false));
    let probe_plugin = input.plugin.clone();
    let probe_job = input.job_id.clone();
    let probe_enabled = !input.preview_mode && input.plugin.enabled;
    let scheduled = input.trigger == "schedule";
    let spent = Cell::new(false);
    let meta = json!({"form":input.form_values,"task":{"id":input.job_id,"name":input.job_name,"trigger":input.trigger,"action":input.action_id}});
    let result: rquickjs::Result<()> = context.with(|ctx| {
        let globals = ctx.globals();
        let probe_stopped = stopped.clone();
        globals.set("__status", Function::new(ctx.clone(), move |domain: String| -> Option<u16> {
            if !probe_enabled || spent.replace(true) || !probe_plugin.domains.contains(&domain) { return None; }
            let url = probe_plugin.network_grants.get(&domain)?;
            let authorized = || !probe_stopped() && store::probe_current(&probe_plugin, &probe_job, scheduled);
            if !authorized() { return None; }
            perform(&domain, url, deadline, &authorized)
        })?)?;
        globals.set("__meta", ctx.json_parse(meta.to_string())?)?;
        let read = storage.clone();
        globals.set("__get", Function::new(ctx.clone(), move |key: String| read.borrow().get(&key).cloned())?)?;
        let write = storage.clone();
        globals.set("__set", Function::new(ctx.clone(), move |key: String, value: String| {
            let mut map = write.borrow_mut();
            if key.len() > 128 || value.len() > 8192 || (!map.contains_key(&key) && map.len() >= 64) { return false; }
            let bytes = map.iter().filter(|(name, _)| *name != &key).map(|(name, text)| name.len() + text.len()).sum::<usize>();
            if bytes + key.len() + value.len() > 65536 { return false; }
            map.insert(key, value);
            true
        })?)?;
        let signal = requested.clone();
        globals.set("__signal", Function::new(ctx.clone(), move || { if permitted { signal.set(true); } permitted })?)?;
        let sleep_stopped = stopped.clone();
        globals.set("__sleep", Function::new(ctx.clone(), move |ms: i32| {
            let end = (Instant::now() + Duration::from_millis(ms.max(0) as u64)).min(deadline);
            while !sleep_stopped() && Instant::now() < end { std::thread::sleep(Duration::from_millis(10)); }
            !sleep_stopped()
        })?)?;
        ctx.eval::<(), _>(r#"(() => {
          const meta=__meta, get=__get, set=__set, signal=__signal, wait=__sleep, probe=__status;
          for(const key of ['__meta','__get','__set','__signal','__sleep','__status']) delete globalThis[key];
          const http=Object.freeze({status:async(...args)=>{if(args.length!==1 || typeof args[0]!=='string') throw Error(); const code=probe(args[0]); if(typeof code!=='number') throw Error(); return code;}});
          const sleep=async(ms)=>{if(!wait(ms)) throw Error()};
          const notify=Object.freeze({send:async()=>{if(!signal()) throw Error()}});
          const storage=Object.freeze({get:async(k)=>get(String(k)),set:async(k,v)=>{if(!set(String(k),String(v))) throw Error()}});
          Object.defineProperty(globalThis,'taskCtx',{value:Object.freeze({...meta,http,sleep,notify,storage,log:()=>{}})});
        })()"#)?;
        let entry = if input.action_id.is_some() { "await onAction(taskCtx.task.action, taskCtx);" } else { "await onSchedule(taskCtx);" };
        let source = format!("{}\n{entry}", input.plugin.script_body);
        let promise = Module::evaluate(ctx.clone(), "local-task", source)?;
        loop {
            if stopped() { return Err(rquickjs::Error::WouldBlock); }
            if let Some(result) = promise.result::<()>() { return result; }
            if !ctx.execute_pending_job() { return Err(rquickjs::Error::WouldBlock); }
        }
    });
    if input.abort.load(Ordering::SeqCst) { return failure("任务已停止"); }
    if Instant::now() >= deadline { return failure("任务已超时"); }
    if result.is_err() { return failure("任务脚本执行失败或能力未授权"); }
    let new_storage = storage.borrow().clone();
    SandboxOutcome { success: true, notify_requested: requested.get(), storage_dirty: !input.preview_mode && new_storage != input.initial_storage, new_storage, ..Default::default() }
}
