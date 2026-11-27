use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::server::core::debug_traffic::TrafficCapture;
use crate::server::core::upstream::usage::RequestTelemetry;

struct Trace {
    capture: Option<Weak<TrafficCapture>>,
    dispatch: Weak<std::sync::atomic::AtomicBool>,
}

fn captures() -> &'static Mutex<HashMap<String, Trace>> {
    static CAPTURES: OnceLock<Mutex<HashMap<String, Trace>>> = OnceLock::new();
    CAPTURES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(telemetry: &RequestTelemetry) -> Option<String> {
    let capture = telemetry.capture();
    let dispatch = telemetry.dispatch_tracker();
    let mut captures = captures().lock().ok()?;
    captures.retain(|_, trace| trace.dispatch.strong_count() > 0
        || trace.capture.as_ref().is_some_and(|capture| capture.strong_count() > 0));
    if captures.len() >= 1024 {
        return None;
    }
    let id = crate::server::core::protocol::random_id("script-trace");
    captures.insert(id.clone(), Trace {
        capture: capture.as_ref().map(Arc::downgrade), dispatch: Arc::downgrade(&dispatch.0),
    });
    Some(id)
}

pub fn find(id: &str) -> Option<Arc<TrafficCapture>> {
    captures().lock().ok()?.get(id)?.capture.as_ref()?.upgrade()
}

pub(super) fn dispatch(id: &str) -> Option<crate::server::core::upstream::usage::DispatchTracker> {
    captures().lock().ok()?.get(id)?.dispatch.upgrade()
        .map(crate::server::core::upstream::usage::DispatchTracker)
}

pub(super) fn mark_dispatched(params: &serde_json::Value) {
    let Some(id) = params["trace"].as_str() else { return; };
    let dispatch = captures().lock().ok().and_then(|captures| captures.get(id)?.dispatch.upgrade());
    if let Some(dispatch) = dispatch { dispatch.store(true, std::sync::atomic::Ordering::Release); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn tracked_http_and_ws_mark_only_valid_dispatched_requests() {
        let hits = Arc::new(AtomicUsize::new(0));
        let received = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(move || {
            received.fetch_add(1, Ordering::SeqCst);
            async { "local fixture" }
        });
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for websocket in [false, true] {
            let telemetry = RequestTelemetry::new();
            telemetry.note_attempt_started("dispatch-fixture", "local");
            let dispatch = telemetry.dispatch_tracker();
            let mut params = json!({"url":format!("{}://{address}/", if websocket { "ws" } else { "http" }),
                "id":format!("dispatch-fixture-{websocket}"), "headers":{"bad\nheader":"value"},
                "trace":register(&telemetry).unwrap()});
            let before = hits.load(Ordering::SeqCst);
            let result = if websocket { super::super::websocket::open(&params).await }
                else { super::super::transport::open(&params).await };
            assert!(result.is_err());
            assert!(!dispatch.dispatched());
            assert_eq!(hits.load(Ordering::SeqCst), before);
            params["headers"] = json!({});
            let result = if websocket { super::super::websocket::open(&params).await }
                else { super::super::transport::open(&params).await };
            assert!(dispatch.dispatched());
            assert_eq!(hits.load(Ordering::SeqCst), before + 1);
            if websocket { assert!(result.is_err()); }
            else { assert!(result.is_ok()); super::super::transport::close(&params); }
        }
        task.abort();
    }
}
