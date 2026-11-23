use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct UiFixture(PathBuf);

impl UiFixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("agent2api-static-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn write(&self, name: &str, body: &str) {
        std::fs::write(self.0.join(name), body).unwrap();
    }

    async fn get(&self, uri: &str, etag: Option<&str>) -> AxumResponse {
        let mut request = Request::builder().uri(uri);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        serve(request.body(Body::empty()).unwrap(), self.0.clone()).await
    }
}

impl Drop for UiFixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

async fn text(response: AxumResponse) -> String {
    String::from_utf8(axum::body::to_bytes(response.into_body(), 2_000_000).await.unwrap().to_vec()).unwrap()
}

// Serving 304 for an HTML entry point leaves clients on an obsolete asset list.
#[tokio::test]
async fn upstream_compat_html_and_service_worker_always_return_fresh_bodies() {
    let ui = UiFixture::new();
    for (name, uri) in [("index.html", "/"), ("login.html", "/login"), ("sw.js", "/sw.js")] {
        ui.write(name, "<head></head><body>fixture</body>");
        let first = ui.get(uri, None).await;
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
        let repeated = ui.get(uri, Some(&etag)).await;
        assert_eq!(repeated.status(), StatusCode::OK, "{name}");
        assert_eq!(repeated.headers()[header::CACHE_CONTROL], "no-store", "{name}");
        assert!(text(repeated).await.contains("fixture"));
    }
}

#[tokio::test]
async fn upstream_compat_ordinary_assets_keep_conditional_requests() {
    let ui = UiFixture::new();
    ui.write("app.js", "window.fixture=1;");
    let first = ui.get("/app.js", None).await;
    let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
    assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache");
    assert_eq!(ui.get("/app.js", Some(&etag)).await.status(), StatusCode::NOT_MODIFIED);
    ui.write("app.js", "window.fixture=222;");
    assert_eq!(text(ui.get("/app.js", Some(&etag)).await).await, "window.fixture=222;");
}

#[tokio::test]
async fn upstream_compat_local_html_assets_follow_their_own_versions() {
    let ui = UiFixture::new();
    ui.write("login.html", r#"<head><link href="./app.css?v=old#theme"><script src="./app.js?theme=dark"></script></head><body><img src="/icon.svg"><script src="https://example.test/remote.js"></script><!-- <script src="ignored.js"></script> --></body>"#);
    ui.write("app.css", "body{}");
    ui.write("app.js", "window.fixture=1;");
    ui.write("icon.svg", "<svg/>");
    let before = text(ui.get("/login", None).await).await;
    assert!(before.contains("./app.css?v="));
    assert!(!before.contains("v=old"));
    assert!(before.contains("#theme\""));
    assert!(before.contains("./app.js?theme=dark&v="));
    assert!(before.contains("/icon.svg?v="));
    assert!(before.contains("https://example.test/remote.js\""));
    assert!(before.contains("<!-- <script src=\"ignored.js\"></script> -->"));
    ui.write("app.js", "window.fixture=123456;");
    let after = text(ui.get("/login", None).await).await;
    assert_ne!(before, after, "asset changes must update HTML even when its file is unchanged");
}

#[tokio::test]
async fn upstream_compat_index_keeps_the_web_bridge_before_local_scripts() {
    let ui = UiFixture::new();
    ui.write("index.html", "<head><script src=\"app.js\"></script></head>");
    ui.write("app.js", "window.fixture=1;");
    let body = text(ui.get("/", None).await).await;
    assert!(body.find("workbuddyDesktop").unwrap() < body.find("src=\"app.js?v=").unwrap());
}
