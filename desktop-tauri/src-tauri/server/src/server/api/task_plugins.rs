use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use super::task_jobs;
use crate::server::core::task_plugins::{scheduler, store, store_remote, types};
use crate::server::{access, errors::management_error, http::ok_json, ServerState};

pub fn router() -> Router<ServerState> {
    Router::new()
        .route("/api/task-plugins", get(list).post(create))
        .route("/api/task-plugins/import", post(create))
        .route("/api/task-plugins/preview", post(preview))
        .route("/api/task-plugins/store", get(store_snapshot))
        .route("/api/task-plugins/store/refresh", post(refresh_store))
        .route("/api/task-plugins/install-store", post(install_store))
        .route("/api/task-plugins/{id}/script", get(export_script))
        .route("/api/task-plugins/{id}", axum::routing::put(update).delete(remove))
        .route("/api/task-plugins/{id}/permissions", post(permissions))
        .route("/api/task-jobs", get(task_jobs::list).post(task_jobs::create))
        .route("/api/task-jobs/cron-preview", post(task_jobs::cron_preview))
        .route("/api/task-jobs/{id}", axum::routing::put(task_jobs::update).patch(task_jobs::patch).delete(task_jobs::remove))
        .route("/api/task-jobs/{id}/run", post(task_jobs::run_now))
        .route("/api/task-jobs/{id}/stop", post(task_jobs::stop_now))
        .route("/api/task-jobs/{id}/duplicate", post(task_jobs::duplicate))
        .route("/api/task-jobs/{id}/action", post(task_jobs::trigger_action))
        .route("/api/task-jobs/{id}/runs", get(task_jobs::list_runs).delete(task_jobs::clear_runs))
        .layer(DefaultBodyLimit::max(384 * 1024))
        .route_layer(middleware::from_fn(admin_only))
}

async fn admin_only(request: Request, next: Next) -> Response {
    let mut response = if !access::session_valid(request.headers()) { management_error(403, "任务管理需要管理员会话") }
    else if let Ok(_guard) = crate::server::core::task_plugins::running_guard() { next.run(request).await }
    else { management_error(409, "整库恢复期间不能操作任务") };
    response.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
    response
}

fn decode(value: Value) -> Result<types::TaskPlugin, String> {
    let mut plugin = if let Some(raw) = value.get("rawScript").and_then(Value::as_str) {
        types::parse_single_file(raw, "local")?
    } else { serde_json::from_value(value).map_err(|_| "任务插件清单格式无效")? };
    plugin.source = "local".into();
    plugin.signed = false;
    plugin.enabled = false;
    plugin.notify_allowed = false;
    types::validate_and_normalize_plugin(plugin)
}

fn body(payload: Bytes) -> Result<Value, String> { serde_json::from_slice(&payload).map_err(|_| "任务参数无效".into()) }
fn reply(result: Result<Value, String>) -> Response { match result { Ok(value) => ok_json(value), Err(error) => management_error(400, error) } }

async fn list() -> Response { reply(store::list_plugins().map(|plugins| json!({"plugins":plugins,"networkAvailable":false,"fixedHttpsStatusAvailable":true,"storeAvailable":true}))) }

async fn export_script(Path(id): Path<String>) -> Response {
    reply(store::get_plugin(&id).and_then(|plugin| plugin.map(|item| json!({"rawScript":types::serialize_single_file(&item)})).ok_or_else(|| "任务插件不存在".into())))
}

async fn store_snapshot() -> Response { ok_json(store_remote::snapshot()) }
async fn refresh_store() -> Response { reply(store_remote::refresh().await) }
async fn install_store(payload: Bytes) -> Response {
    let result = async {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Selection { id: String, sha256: String }
        let selection: Selection = serde_json::from_slice(&payload).map_err(|_| "请选择目录中的任务插件版本")?;
        store_remote::install(&selection.id, &selection.sha256).await.map(|plugin| json!({"plugin":plugin}))
    }.await;
    reply(result)
}

async fn create(payload: Bytes) -> Response {
    reply(body(payload).and_then(decode).and_then(|plugin| {
        store::create_plugin(plugin).map(|plugin| json!({"plugin":plugin}))
    }))
}

async fn update(Path(id): Path<String>, payload: Bytes) -> Response {
    reply(body(payload).and_then(decode).and_then(|plugin| {
        if id != plugin.id || store::get_plugin(&id)?.is_none() { return Err("任务插件不存在".into()); }
        store::upsert_plugin(plugin, false).map(|plugin| json!({"plugin":plugin}))
    }))
}

async fn permissions(Path(id): Path<String>, payload: Bytes) -> Response {
    reply(body(payload).and_then(|value| {
        let plugin = store::get_plugin(&id)?.ok_or("任务插件不存在")?;
        let enabled = value.get("enabled").and_then(Value::as_bool);
        let allowed = value.get("notifyAllowed").and_then(Value::as_bool);
        let revision = value.get("expectedUpdatedAt").and_then(Value::as_i64);
        let grants = value.get("networkGrants").map(|value| {
            let grants = serde_json::from_value::<std::collections::BTreeMap<String,String>>(value.clone()).map_err(|_| "固定状态探测授权格式无效")?;
            if revision != Some(plugin.updated_at) || grants.len() > types::MAX_DOMAINS || enabled == Some(false) && !grants.is_empty() { return Err("请刷新并重新确认探测授权"); }
            for (domain, endpoint) in &grants {
                if !plugin.domains.contains(domain) || crate::server::core::task_plugins::probe::endpoint(domain, endpoint).is_none() { return Err("仅可授权声明域内固定的 HTTPS 公网地址，不带凭证、查询或片段"); }
            }
            Ok(grants)
        }).transpose()?;
        if allowed == Some(true) && !plugin.declares_notify { return Err("插件未声明通知能力".into()); }
        if allowed.is_none() && enabled.is_none() && grants.is_none() { return Err("缺少授权开关".into()); }
        store::patch_plugin(&id, enabled, allowed, grants.as_ref(), revision).map(|plugin| json!({"plugin":plugin}))
    }))
}

async fn remove(Path(id): Path<String>) -> Response { reply(store::delete_plugin(&id).map(|_| json!({"deleted":true}))) }

async fn preview(payload: Bytes) -> Response {
    let result = async {
        let value = body(payload)?;
        let plugin = decode(value.get("plugin").cloned().unwrap_or(Value::Null))?;
        let values = serde_json::from_value(value.get("values").cloned().unwrap_or_else(|| json!({}))).map_err(|_| "表单值无效")?;
        let proxy = value.get("proxyId").and_then(Value::as_str).unwrap_or_default().into();
        let outcome = scheduler::preview_plugin(plugin, None, values, proxy, Default::default()).await?;
        Ok(json!({"outcome":outcome}))
    }.await;
    reply(result)
}
