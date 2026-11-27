use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(true);
static ADMIN_CURRENT: AtomicBool = AtomicBool::new(true);
static SOURCE_CURRENT: AtomicBool = AtomicBool::new(true);
static SETTINGS_CHANGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Default)]
pub struct ProviderConfig {
    enabled: bool,
    client_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct PanelOauthSettings {
    public_base_url: String,
    google: ProviderConfig,
    github: ProviderConfig,
}

impl PanelOauthSettings {
    pub fn current() -> Self {
        let provider = ProviderConfig { enabled: ENABLED.load(Ordering::SeqCst), client_id: if SETTINGS_CHANGED.load(Ordering::SeqCst) { "replacement-client" } else { "qa-client" }.into() };
        Self { public_base_url: "https://panel.test".into(), google: provider.clone(), github: provider }
    }
    pub fn google_secret(&self) -> Result<String, String> { Ok("qa-secret".into()) }
    pub fn github_secret(&self) -> Result<String, String> { Ok("qa-secret".into()) }
    pub fn to_stored_value(&self) -> serde_json::Value {
        json!({"publicBaseUrl": self.public_base_url, "enabled": self.google.enabled, "clientId": self.google.client_id})
    }
    pub fn is_google_allowed(&self, _: &str, _: &str, _: bool) -> bool { true }
    pub fn is_github_allowed(&self, _: &str, _: &str) -> bool { true }
}

pub fn record_bound_google(_: &str, _: &str, _: &str) -> Result<(), String> { panic!("revoked flow must not bind") }
pub fn record_bound_github(_: &str, _: &str, _: &str, _: &str) -> Result<(), String> { panic!("revoked flow must not bind") }

mod server {
    pub mod access {
        #[derive(Clone, Debug)]
        pub struct IssuedSession { pub access_token: String }
        impl IssuedSession {
            pub fn new_session() -> Self { panic!("revoked flow must not issue sessions") }
        }
        pub fn admin_registered() -> bool { true }
        pub fn oauth_admin_stamp() -> Option<String> {
            Some(if crate::ADMIN_CURRENT.load(crate::Ordering::SeqCst) { "original-admin" } else { "new-admin" }.into())
        }
        pub fn random_hex(_: usize) -> String {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            format!("flow-{}", NEXT.fetch_add(1, crate::Ordering::SeqCst))
        }
        pub fn session_valid(_: &axum::http::HeaderMap) -> bool { crate::SOURCE_CURRENT.load(crate::Ordering::SeqCst) }
        pub mod login_source {
            #[derive(Clone)]
            pub struct Source;
            impl Source {
                pub fn is_current(&self) -> bool { crate::SOURCE_CURRENT.load(crate::Ordering::SeqCst) }
                pub fn with_current<Result>(&self, action: impl FnOnce() -> Result) -> Option<Result> { self.is_current().then(action) }
            }
        }
    }
    pub mod core {
        pub mod egress {
            pub fn client_for_system_proxy() -> &'static reqwest::Client { panic!("revoked OAuth flow attempted a network call") }
            pub fn describe_error_detail(error: &reqwest::Error) -> String { error.to_string() }
        }
        pub mod notifications {
            pub fn notify_login_failure(_: &str, _: &str, _: &str, _: &str) {}
            pub fn notify_login_success(_: &str, _: &str, _: &str) {}
        }
    }
    pub mod logging { pub fn log(_: &str, _: &str) {} }
}

#[path = "../desktop-tauri/src-tauri/server/src/server/core/panel_oauth/flow.rs"]
mod flow;

fn reset() { ENABLED.store(true, Ordering::SeqCst); ADMIN_CURRENT.store(true, Ordering::SeqCst); SOURCE_CURRENT.store(true, Ordering::SeqCst); SETTINGS_CHANGED.store(false, Ordering::SeqCst); }

#[test]
fn disabling_login_revokes_an_in_flight_external_browser_callback() {
    reset();
    let (state, _) = flow::start_flow(flow::OauthProvider::Google, flow::OauthMode::Login, true, "/m", "https://panel.test").unwrap();
    ENABLED.store(false, Ordering::SeqCst);
    let result = tokio::runtime::Runtime::new().unwrap().block_on(flow::complete_callback(&state, Some("unused-code"), None, "127.0.0.1"));
    assert!(result.error.is_some());
    assert!(result.session.is_none());
}

#[test]
fn replacing_the_admin_revokes_an_in_flight_external_browser_callback() {
    reset();
    let (state, _) = flow::start_flow(flow::OauthProvider::Github, flow::OauthMode::Login, true, "/m", "https://panel.test").unwrap();
    ADMIN_CURRENT.store(false, Ordering::SeqCst);
    let result = tokio::runtime::Runtime::new().unwrap().block_on(flow::complete_callback(&state, Some("unused-code"), None, "127.0.0.1"));
    assert!(result.error.is_some());
    assert!(result.session.is_none());
}

#[test]
fn binding_cannot_be_started_without_an_authenticated_owner() {
    reset();
    assert!(flow::start_flow(flow::OauthProvider::Google, flow::OauthMode::Bind, true, "", "https://panel.test").is_err());
}

#[test]
fn logout_revokes_an_in_flight_binding_without_losing_external_browser_support() {
    reset();
    let (state, url) = flow::start_bind_flow(flow::OauthProvider::Google, "https://panel.test", server::access::login_source::Source).unwrap();
    assert!(url.starts_with("https://accounts.google.com/"));
    assert_eq!(flow::poll_state(&state)["status"], "pending");
    SOURCE_CURRENT.store(false, Ordering::SeqCst);
    let result = tokio::runtime::Runtime::new().unwrap().block_on(flow::complete_callback(&state, Some("unused-code"), None, "127.0.0.1"));
    assert!(result.error.is_some());
    assert!(result.session.is_none());
}

#[test]
fn replacing_client_settings_revokes_the_previous_callback_before_network_access() {
    reset();
    let (state, _) = flow::start_flow(flow::OauthProvider::Google, flow::OauthMode::Login, false, "/m", "https://panel.test").unwrap();
    SETTINGS_CHANGED.store(true, Ordering::SeqCst);
    let result = tokio::runtime::Runtime::new().unwrap().block_on(flow::complete_callback(&state, Some("unused-code"), None, "127.0.0.1"));
    assert!(result.error.is_some());
    assert!(result.session.is_none());
}

#[test]
fn a_callback_can_only_be_processed_once() {
    reset();
    let (state, _) = flow::start_flow(flow::OauthProvider::Github, flow::OauthMode::Login, true, "/m", "https://panel.test").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let canceled = runtime.block_on(flow::complete_callback(&state, None, Some("canceled"), "127.0.0.1"));
    assert!(canceled.error.is_some());
    let repeated = runtime.block_on(flow::complete_callback(&state, Some("unused-code"), None, "127.0.0.1"));
    assert!(repeated.error.is_some());
    assert!(repeated.session.is_none());
}

#[test]
fn a_revoked_owner_cannot_start_a_new_binding() {
    reset();
    SOURCE_CURRENT.store(false, Ordering::SeqCst);
    assert!(flow::start_bind_flow(flow::OauthProvider::Github, "https://panel.test", server::access::login_source::Source).is_err());
}

#[test]
fn an_unknown_ticket_never_issues_a_session() {
    reset();
    assert!(flow::take_ticket("not-an-issued-ticket").is_none());
}
