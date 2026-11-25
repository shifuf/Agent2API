use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn sticky_failover_two_failures_freeze_all_keys_of_only_the_matching_member() {
    let health = RouteHealth::default();
    let first = health.begin("entry", "member-a\0key-one", 1_000).unwrap();
    let event = health.failure(&first, 60, 1_001, || panic!("first failure must not unbind"));
    assert_eq!(event.failures, 1);
    assert_eq!(event.frozen_until, None);
    assert_eq!(health.failed_candidate("entry", "member-a\0key-two").as_deref(), Some("member-a\0key-one"));
    assert_eq!(health.failed_candidate("entry", "member-b\0key-one"), None);
    let second = health.begin("entry", "member-a\0key-two", 1_002).unwrap();
    let unbound = AtomicUsize::new(0);
    let event = health.failure(&second, 60, 1_002, || { unbound.fetch_add(1, Ordering::SeqCst); });
    assert_eq!(event.failures, 2);
    assert_eq!(event.frozen_until, Some(61_002));
    assert_eq!(unbound.load(Ordering::SeqCst), 1);
    assert_eq!(health.begin("entry", "member-a\0key-one", 1_003).unwrap_err(), 61_002);
    assert_eq!(health.frozen_until("entry", "member-a\0key-two", 1_003), Some(61_002));
    assert!(health.begin("entry", "member-b\0key-one", 1_003).is_ok());
    assert!(health.begin("other-entry", "member-a\0key-one", 1_003).is_ok());
}

#[test]
fn sticky_failover_completed_success_resets_the_unfrozen_failure_chain() {
    let health = RouteHealth::default();
    let lease = health.begin("entry", "a\0key", 1_000).unwrap();
    assert_eq!(health.failure(&lease, 60, 1_001, || {}).failures, 1);
    assert!(health.success(&lease, 1_002, || {}));
    assert_eq!(health.failed_candidate("entry", "a\0another-key"), None);
    assert_eq!(health.failure(&lease, 60, 1_003, || {}).failures, 1);
    assert_eq!(health.frozen_until("entry", "a\0another-key", 1_004), None);
}

#[test]
fn sticky_failover_late_success_and_failure_cannot_change_a_new_health_generation() {
    let health = RouteHealth::default();
    let early = health.begin("entry", "a\0key", 1_000).unwrap();
    health.failure(&early, 10, 1_001, || {});
    health.failure(&early, 10, 1_002, || {});
    assert!(!health.success(&early, 1_003, || panic!("late success must not restore affinity")));
    let recovered = health.begin("entry", "a\0key", 11_002).unwrap();
    assert_eq!(health.failed_candidate("entry", "a\0another-key"), None);
    assert!(!health.success(&early, 11_003, || panic!("old success must not bind after expiry")));
    assert_eq!(health.failure(&early, 10, 11_004, || panic!("old failure must not freeze a recovered member")).failures, 0);
    assert_eq!(health.failure(&recovered, 10, 11_005, || {}).failures, 1);
    assert!(health.success(&recovered, 11_006, || {}));
}

#[test]
fn sticky_failover_timeout_is_bounded_and_members_rejoin_at_expiry() {
    for (configured, until) in [(0, 11_002), (999, 601_002)] {
        let health = RouteHealth::default();
        let lease = health.begin("entry", "a\0key", 1_000).unwrap();
        health.failure(&lease, configured, 1_001, || {});
        assert_eq!(health.failure(&lease, configured, 1_002, || {}).frozen_until, Some(until));
        assert!(health.begin("entry", "a\0key", until - 1).is_err());
        assert!(health.begin("entry", "a\0key", until).is_ok());
    }
}

#[test]
fn sticky_failover_capacity_pressure_does_not_evict_frozen_members() {
    let health = RouteHealth::default();
    for number in 0..MAX_CHANNELS {
        let candidate = format!("a-{number}\0key");
        let lease = health.begin("entry", &candidate, 1_000).unwrap();
        health.failure(&lease, 60, 1_000, || {});
        health.failure(&lease, 60, 1_000, || {});
    }
    assert_eq!(health.begin("entry", "new-member\0key", 1_001).unwrap_err(), 61_000);
    assert_eq!(health.frozen_until("entry", "a-0\0key", 1_001), Some(61_000));
    assert!(health.begin("entry", "new-member\0key", 61_000).is_ok());
}
