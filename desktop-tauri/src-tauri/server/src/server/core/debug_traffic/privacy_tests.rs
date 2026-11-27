use std::sync::Arc;

use serde_json::json;

use super::TrafficCapture;
use crate::server::core::privacy;

#[tokio::test]
async fn private_capture_keeps_upstream_body_out_of_storage_after_request_scope_ends() {
    let capture = privacy::ACTIVE.scope(Arc::new(()), async {
        let capture = TrafficCapture::begin("private-native-error");
        capture.reset_request(
            "http://127.0.0.1:1234/v1/responses", "fixture", &[],
            &json!({"input":"masked request"}),
        );
        capture
    }).await;
    assert!(!privacy::private_log(), "handler privacy scope has ended");
    capture.attach_response(400, &reqwest::header::HeaderMap::new());
    capture.push(b"{\"error\":{\"message\":\"private diagnostic\"}}");
    assert_eq!(capture.captured_body(), "", "private upstream bytes must never be captured");
    capture.finish();
    capture.finish();
    assert_eq!(capture.captured_body(), "");
}

#[test]
fn ordinary_capture_keeps_upstream_diagnostics() {
    let capture = TrafficCapture::begin("ordinary-native-error");
    let diagnostic = b"{\"error\":{\"message\":\"ordinary diagnostic\"}}";
    capture.push(diagnostic);
    assert_eq!(capture.captured_body().as_bytes(), diagnostic);
}
