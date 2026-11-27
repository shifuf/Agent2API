extern crate self as tauri;

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

pub struct AppHandle;
static CURRENT: AtomicBool = AtomicBool::new(true);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
static REPLY: Mutex<Option<Value>> = Mutex::new(None);
static DELAY_MS: AtomicU64 = AtomicU64::new(0);
static CANCEL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static CHANGE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[path = "../desktop-tauri/src-tauri/src/login/result.rs"]
mod result;
#[path = "../desktop-tauri/src-tauri/src/login/managed_wait.rs"]
mod managed_wait;

mod panel_session {
    pub fn revision() -> u64 {
        super::GENERATION.load(super::Ordering::SeqCst)
    }
}

mod gateway {
    pub async fn call_without_auth_replay(method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
        assert_eq!(method, "GET");
        assert_eq!(path, "/api/session/login/wait?state=original-flow");
        assert!(body.is_none());
        super::CALLS.fetch_add(1, super::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(super::DELAY_MS.load(super::Ordering::SeqCst))).await;
        if super::CANCEL_IN_FLIGHT.load(super::Ordering::SeqCst) {
            super::CURRENT.store(false, super::Ordering::SeqCst);
        }
        if super::CHANGE_IN_FLIGHT.load(super::Ordering::SeqCst) {
            super::GENERATION.fetch_add(1, super::Ordering::SeqCst);
        }
        super::REPLY.lock().unwrap().clone().ok_or_else(|| "interrupted".into())
    }
}

fn emit_login_progress(_: &AppHandle, _: &str, _: &Value, _: &str, _: Option<&str>) {}
fn login_is_current(_: &AppHandle, flow: &str) -> bool {
    flow == "original-flow" && CURRENT.load(Ordering::SeqCst)
}

fn reset() {
    CURRENT.store(true, Ordering::SeqCst);
    GENERATION.store(0, Ordering::SeqCst);
    CALLS.store(0, Ordering::SeqCst);
    DELAY_MS.store(0, Ordering::SeqCst);
    CANCEL_IN_FLIGHT.store(false, Ordering::SeqCst);
    CHANGE_IN_FLIGHT.store(false, Ordering::SeqCst);
    *REPLY.lock().unwrap() = Some(json!({
        "managedLogin": true, "provider": "trae", "flow": "original-flow", "methodIndex": 0,
        "phase": "saved", "saved": true, "pending": false, "done": true,
        "session": {"provider":"trae", "accountUid":"saved-account"}
    }));
}

fn wait(remaining_ms: u64) -> Result<Value, String> {
    tokio::runtime::Runtime::new().unwrap().block_on(managed_wait::wait(
        &AppHandle, "trae", "original-flow",
        &json!({"methodIndex": 0, "remainingMs": remaining_ms, "pollIntervalMs": 1000}), "", 0,
    ))
}

#[test]
fn saved_receipt_is_accepted_only_for_the_current_owner() {
    reset();
    assert_eq!(wait(500).unwrap()["ok"], true);
    reset();
    REPLY.lock().unwrap().as_mut().unwrap()["flow"] = json!("another-flow");
    assert!(wait(500).is_err());
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn cancellation_discards_a_saved_reply_from_an_in_flight_wait() {
    reset();
    CANCEL_IN_FLIGHT.store(true, Ordering::SeqCst);
    assert_eq!(wait(500).unwrap()["canceled"], true);
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn a_management_session_change_discards_the_reply_without_replay() {
    reset();
    CHANGE_IN_FLIGHT.store(true, Ordering::SeqCst);
    assert!(wait(500).unwrap_err().contains("管理会话已变化"));
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn an_expired_budget_makes_no_request() {
    reset();
    assert!(wait(0).is_err());
    assert_eq!(CALLS.load(Ordering::SeqCst), 0);
}

#[test]
fn a_wait_reply_after_the_deadline_cannot_claim_a_saved_account() {
    reset();
    DELAY_MS.store(50, Ordering::SeqCst);
    assert!(wait(1).is_err());
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn transport_failure_does_not_retry_or_repost_credentials() {
    reset();
    *REPLY.lock().unwrap() = None;
    assert!(wait(500).is_err());
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}
