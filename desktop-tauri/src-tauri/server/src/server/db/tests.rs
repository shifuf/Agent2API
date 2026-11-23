use super::Db;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

// A same-connection nested call must return None instead of blocking its thread.
#[test]
fn upstream_compat_nested_db_reads_fail_without_deadlock() {
    let db = Db::open(Path::new(":memory:")).unwrap();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = db.with(|_| db.clone().with(|conn| conn.is_autocommit()));
        send.send(result).unwrap();
    });
    assert_eq!(receive.recv_timeout(Duration::from_secs(1)).unwrap(), Some(None));
    worker.join().unwrap();
}

#[test]
fn upstream_compat_nested_mutable_db_access_fails_without_deadlock() {
    let db = Db::open(Path::new(":memory:")).unwrap();
    let (send, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = db.with_mut(|_| db.with_mut(|conn| conn.is_autocommit()));
        send.send(result).unwrap();
    });
    assert_eq!(receive.recv_timeout(Duration::from_secs(1)).unwrap(), Some(None));
    worker.join().unwrap();
}

#[test]
fn upstream_compat_other_database_remains_accessible_when_nested() {
    let first = Db::open(Path::new(":memory:")).unwrap();
    let second = Db::open(Path::new(":memory:")).unwrap();
    assert_eq!(first.with(|_| second.with(|conn| conn.is_autocommit())), Some(Some(true)));
}

#[test]
fn upstream_compat_panicked_connection_stays_unavailable() {
    let db = Db::open(Path::new(":memory:")).unwrap();
    let worker_db = db.clone();
    assert!(std::thread::spawn(move || worker_db.with::<()>(|_| panic!("fixture"))).join().is_err());
    assert_eq!(db.with(|_| 1), None);
    let other = Db::open(Path::new(":memory:")).unwrap();
    assert_eq!(other.with(|_| 2), Some(2));
}
