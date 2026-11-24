//! RAII ownership for fixed host operations using the bounded plugin transport.
//! The same absolute deadline covers opening and every body read.
use std::{future::Future, sync::{Arc, atomic::{AtomicBool, Ordering}}};

use agent2api_provider_protocol as proto;
use serde_json::{json, Value};
use tokio::time::Instant;

#[derive(Clone, Copy, Default)]
pub(in crate::server::core::plugin_host) struct HttpDeadline(Option<Instant>);

impl HttpDeadline {
    pub fn at(deadline: Instant) -> Self { Self(Some(deadline)) }
    pub fn check(self) -> Result<(), proto::WireError> {
        if self.0.is_some_and(|deadline| Instant::now() >= deadline) { Err(timeout()) } else { Ok(()) }
    }
    pub async fn run_until<T>(self, work: impl Future<Output = Result<T, proto::WireError>>) -> Result<T, proto::WireError> {
        self.check()?;
        match self.0 {
            Some(deadline) => tokio::time::timeout_at(deadline, work).await.map_err(|_| timeout())?,
            None => work.await,
        }
    }
}

fn timeout() -> proto::WireError { proto::WireError::with_code("插件 HTTP 请求总期限已到", "timeout") }

struct Owner { id: String, ended: AtomicBool }

impl Owner {
    fn close(&self) {
        if !self.ended.swap(true, Ordering::AcqRel) { super::close_http(&json!({ "id": self.id })); }
    }
}
impl Drop for Owner { fn drop(&mut self) { self.close(); } }

#[derive(Clone)]
pub(in crate::server::core::plugin_host) struct HttpHandle { owner: Arc<Owner>, deadline: HttpDeadline }

impl HttpHandle {
    pub fn id(&self) -> &str { &self.owner.id }
    pub fn deadline(&self) -> HttpDeadline { self.deadline }
    pub fn close(&self) { self.owner.close(); }
    pub async fn read(&self) -> Result<Value, proto::WireError> {
        if self.owner.ended.load(Ordering::Acquire) { return Ok(json!({ "done": true })); }
        let params = json!({ "id": self.owner.id });
        let result = self.deadline.run_until(super::read_http(&params)).await;
        if result.is_err() || result.as_ref().is_ok_and(|value| value["done"] == true) { self.close(); }
        result
    }
}

pub(in crate::server::core::plugin_host) async fn open_body_with_policy(params: &Value,
    body: Option<super::RequestBody>, system_proxy_when_unset: bool, deadline: HttpDeadline,
) -> Result<(Value, HttpHandle), proto::WireError> {
    let id = params["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 80)
        .ok_or_else(|| proto::WireError::with_code("固定网络调用缺少连接标识", "bad_params"))?.to_string();
    let owner = Arc::new(Owner { id, ended: AtomicBool::new(false) });
    // The selected proxy remains authoritative; system proxy is a host policy.
    let mut params = params.clone();
    params["system_proxy_when_unset"] = json!(system_proxy_when_unset);
    let head = deadline.run_until(super::open_body(&params, body)).await?;
    deadline.check()?;
    Ok((head, HttpHandle { owner, deadline }))
}
