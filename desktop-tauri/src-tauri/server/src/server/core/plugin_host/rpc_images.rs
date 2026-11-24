//! WASM 已执行图片请求；直接使用真实宿主材料化后的标准结果。
use std::sync::Arc;
use std::time::Duration;

use axum::http::HeaderMap;
use serde_json::{json, Value};

use super::{headers_json, rpc_error, wire_proxy, RpcAdapter};
use crate::server::core::proxies::ResolvedProxy;
use crate::server::core::providers::images::ImageOperation;
use crate::server::core::upstream::{usage::RequestTelemetry, ForwardOutcome};
use crate::server::errors::GatewayError;

impl RpcAdapter {
    pub(super) async fn wasm_images(
        &self, account: &str, body: &Value, headers: &HeaderMap, proxy: Option<ResolvedProxy>,
        operation: ImageOperation, telemetry: &Arc<RequestTelemetry>,
    ) -> Result<ForwardOutcome, GatewayError> {
        let execution = self.execution().await?;
        let host = execution.host.clone();
        let options = host.options.wasm.as_ref()
            .ok_or_else(|| GatewayError::with_status(501, "非 WASM 图片通道"))?;
        if !options.allows("images.v1") {
            return Err(GatewayError::with_status(501, "插件未声明标准图片能力"));
        }
        super::super::wasm::catalog::ensure(execution, account, body["model"].as_str().unwrap_or("")).await?;
        let _lease = execution.lease.clone().or_else(|| host.activity.acquire())
            .ok_or_else(|| super::super::activity::AvailabilityError::Unavailable.gateway())?;
        host.ensure().await.map_err(|message| GatewayError::with_status(503, message))?;
        let mut params = execution.base();
        params.insert("account".into(), json!(account));
        params.insert("body".into(), body.clone());
        params.insert("headers".into(), headers_json(headers));
        params.insert("proxy".into(), proxy.map_or(Value::Null, wire_proxy));
        params.insert("wire_model".into(), json!(body["model"].as_str().unwrap_or("")));
        params.insert("session".into(), json!(super::session_of(headers)));
        if let Some(trace) = super::super::script::register_trace(telemetry) {
            params.insert("plugin_trace".into(), json!({"id":trace}));
        }
        let params = Value::Object(params);
        let size = serde_json::to_vec(&params)
            .map_err(|_| GatewayError::bad_request("图片请求无法序列化"))?.len();
        if size > 14 * 1024 * 1024 {
            return Err(GatewayError::with_status(413, "图片请求内联数据总大小不得超过 14 MiB"));
        }
        // 直接等待原 WASM future；取消时销毁它及其 HTTP 资源，不留下脱离请求的生图任务。
        let invocation = host.call_wasm(operation.method(), params, Duration::from_secs(3600));
        let result = if let Some(token) = telemetry.cancel_token() {
            tokio::select! {
                biased;
                _ = token.cancelled() => return Err(crate::server::core::upstream::cancellation::cancelled_error()),
                result = invocation => result,
            }
        } else { invocation.await };
        let body = result.map_err(|error| {
            let mut failure = rpc_error(self.id, error, operation.method());
            if failure.status_code >= 500 {
                failure.code = Some("image_output_uncertain".into());
                failure.retry_forbidden = true;
                telemetry.note_attempt_notice("生图结果尚未确认，未自动重发，以免重复消耗额度");
            }
            failure
        })?;
        if let Some(usage) = body.get("usage").filter(|usage| usage.is_object()) {
            telemetry.report_usage(usage);
        }
        Ok(ForwardOutcome::Completion { body })
    }
}
