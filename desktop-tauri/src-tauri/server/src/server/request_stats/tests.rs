use super::*;
use std::sync::mpsc;
use std::time::Duration;

fn store() -> (Db, Arc<RequestStats>) {
    // Production initializes this before accepting requests; do the same here.
    let _ = crate::server::logging::process_started_at();
    let db = Db::open(std::path::Path::new(":memory:")).unwrap();
    let stats = Arc::new(RequestStats::with_db(Some(db.clone()), Retention::default));
    (db, stats)
}

fn values(options: &Value, name: &str) -> Vec<String> {
    options[name].as_array().unwrap().iter().map(|value| value.as_str().or_else(|| value["value"].as_str()).unwrap().to_owned()).collect()
}

// A warm filter request must not queue behind an unrelated DB operation.
#[test]
fn upstream_compat_warm_filter_cache_avoids_database_lock() {
    let (db, stats) = store();
    stats.record(NewRequestEntry::new("cached-model", 200));
    assert_eq!(values(&stats.filter_options(), "models"), ["cached-model"]);
    let (locked_send, locked_receive) = mpsc::channel();
    let (unlock_send, unlock_receive) = mpsc::channel();
    let holder = std::thread::spawn(move || db.with(|_| {
        locked_send.send(()).unwrap();
        unlock_receive.recv().unwrap();
    }));
    locked_receive.recv().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || send.send(stats.filter_options()).unwrap());
    let result = receive.recv_timeout(Duration::from_secs(1));
    unlock_send.send(()).unwrap();
    holder.join().unwrap();
    reader.join().unwrap();
    assert!(result.is_ok(), "cached filters waited for the database lock");
    assert_eq!(values(&result.unwrap(), "models"), ["cached-model"]);
}

#[test]
fn upstream_compat_new_filter_dimensions_appear_after_committed_writes() {
    let (_, stats) = store();
    stats.record(NewRequestEntry::new("old", 200));
    let _ = stats.filter_options();
    let mut entry = NewRequestEntry::new("alias", 200);
    entry.upstream_model = "actual".into();
    entry.provider = Some("new-provider".into());
    entry.source = RequestSource {
        client: "fixture-client".into(),
        api_key: ApiKeyIdentity { source: "key".into(), id: "fixture".into(), name: "Fixture key".into() },
        ..Default::default()
    };
    stats.record(entry);
    let options = stats.filter_options();
    assert_eq!(values(&options, "models"), ["actual", "alias", "old"]);
    assert_eq!(options["providers"][0]["id"], "new-provider");
    assert!(values(&options, "clients").contains(&"fixture-client".to_owned()));
    assert!(values(&options, "apiKeys").contains(&"key:fixture".to_owned()));
}

#[test]
fn upstream_compat_running_rows_refresh_filter_dimensions() {
    let (_, stats) = store();
    let _ = stats.filter_options();
    stats.record_started("running-fixture", now_ms(), "alias", "", "", &RequestSource { client: "new-client".into(), ..Default::default() }, false);
    let _ = stats.filter_options();
    let progress = RunningProgress {
        provider: "running-provider".into(), upstream_model: "running-actual".into(),
        account_id: String::new(), account_name: String::new(), upstream_reasoning: String::new(),
        attempts: 1, first_response_ms: None, phase: "connecting".into(), phase_started_at: None,
        attempt_details: Vec::new(), route: None, sensitive_hits: Vec::new(),
    };
    stats.update_running("running-fixture", &progress);
    let options = stats.filter_options();
    assert_eq!(values(&options, "models"), ["alias", "running-actual"]);
    assert_eq!(options["providers"][0]["id"], "running-provider");
    assert!(values(&options, "clients").contains(&"new-client".to_owned()));
}

#[test]
fn upstream_compat_clear_and_prune_remove_obsolete_filter_values() {
    let db = Db::open(std::path::Path::new(":memory:")).unwrap();
    let stats = RequestStats::with_db(Some(db), || Retention { request_days: 7, ..Retention::default() });
    stats.record(NewRequestEntry::new("old", 200));
    let _ = stats.filter_options();
    stats.clear_requests(&RequestQuery::default(), false).unwrap();
    assert!(values(&stats.filter_options(), "models").is_empty());
    let mut expired = NewRequestEntry::new("expired", 200);
    expired.ts = Some(1);
    stats.record(expired);
    let _ = stats.filter_options();
    stats.prune();
    assert!(values(&stats.filter_options(), "models").is_empty());
}

#[test]
fn upstream_compat_full_model_list_does_not_hide_other_new_dimensions() {
    let (_, stats) = store();
    for n in 0..201 { stats.record(NewRequestEntry::new(format!("model-{n:03}"), 200)); }
    assert_eq!(values(&stats.filter_options(), "models").len(), 200);
    let mut entry = NewRequestEntry::new("model-000", 200);
    entry.provider = Some("new-provider".into());
    entry.source.client = "new-client".into();
    stats.record(entry);
    let options = stats.filter_options();
    assert_eq!(options["providers"][0]["id"], "new-provider");
    assert!(values(&options, "clients").contains(&"new-client".to_owned()));
}

#[test]
fn upstream_compat_filter_cache_sees_other_writes_on_the_shared_connection() {
    let (db, stats) = store();
    stats.record(NewRequestEntry::new("old", 200));
    assert_eq!(values(&stats.filter_options(), "models"), ["old"]);
    // Migration and administrative operations can write through Db directly.
    db.with(|conn| conn.execute("UPDATE requests SET model = 'imported'", []).unwrap());
    assert_eq!(values(&stats.filter_options(), "models"), ["imported"]);
}

#[test]
fn upstream_compat_filter_cache_rechecks_external_commits_after_the_short_window() {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!("agent2api-filter-external-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&directory).unwrap();
    {
        let db = Db::open(&directory.join("agent2api.db")).unwrap();
        let stats = RequestStats::with_db(Some(db.clone()), Retention::default);
        stats.record(NewRequestEntry::new("old", 200));
        let now = Instant::now();
        let original = db.with(|conn| stats.filters.read_or_compute(conn, now, db.request_revision()).unwrap()).unwrap();
        assert_eq!(original.models, ["old"]);
        let external = rusqlite::Connection::open(db.file()).unwrap();
        external.execute("UPDATE requests SET model = 'external'", []).unwrap();
        assert_eq!(stats.filters.read_fast(now + Duration::from_secs(14), db.request_revision()).unwrap().models, ["old"]);
        assert!(stats.filters.read_fast(now + Duration::from_secs(15), db.request_revision()).is_none());
        let refreshed = db.with(|conn| stats.filters.read_or_compute(conn, now + Duration::from_secs(15), db.request_revision()).unwrap()).unwrap();
        assert_eq!(refreshed.models, ["external"]);
        assert!(stats.filters.read_fast(now + Duration::from_secs(29), db.request_revision()).is_some(), "an unchanged DB check must renew the lock-free window");
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn upstream_compat_filter_cache_refreshes_ranking_after_active_traffic() {
    use std::time::Instant;
    let (db, stats) = store();
    stats.record(NewRequestEntry::new("alpha", 200));
    stats.record(NewRequestEntry::new("beta", 200));
    let now = Instant::now();
    let original = db.with(|conn| stats.filters.read_or_compute(conn, now, db.request_revision()).unwrap()).unwrap();
    assert_eq!(original.models, ["alpha", "beta"]);
    for _ in 0..3 { stats.record(NewRequestEntry::new("beta", 200)); }
    let cached = db.with(|conn| stats.filters.read_or_compute(conn, now + Duration::from_secs(299), db.request_revision()).unwrap()).unwrap();
    assert_eq!(cached.models, ["alpha", "beta"]);
    let refreshed = db.with(|conn| stats.filters.read_or_compute(conn, now + Duration::from_secs(300), db.request_revision()).unwrap()).unwrap();
    assert_eq!(refreshed.models, ["beta", "alpha"]);
}
