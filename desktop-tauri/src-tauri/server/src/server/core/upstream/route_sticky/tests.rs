use super::*;

#[test]
fn sticky_failover_forgets_only_matching_channel_bindings_at_all_nested_levels() {
    let sticky = StickySessions::default();
    for (key, model, candidate) in [
        ("one", "entry", "nested/a\0key-one"),
        ("two", "entry\0parent/child", "nested/a\0key-two"),
        ("other-member", "entry", "nested/b\0key-one"),
        ("other-entry", "other", "nested/a\0key-one"),
    ] {
        sticky.bind(key, model, candidate, "fixture", 1_000, 100_000, 0);
    }
    assert_eq!(sticky.forget_channel("entry", "nested/a\0key-one"), 2);
    assert_eq!(sticky.lookup("one", "entry", 1_001, 100_000), None);
    assert_eq!(sticky.lookup("two", "entry\0parent/child", 1_001, 100_000), None);
    assert_eq!(sticky.lookup("other-member", "entry", 1_001, 100_000), Some("nested/b\0key-one".into()));
    assert_eq!(sticky.lookup("other-entry", "other", 1_001, 100_000), Some("nested/a\0key-one".into()));
    // Fault invalidation must not cancel unrelated replacement bindings in flight.
    sticky.bind("one", "entry", "nested/b\0key-one", "fixture", 1_002, 100_000, 0);
    assert_eq!(sticky.lookup("one", "entry", 1_003, 100_000), Some("nested/b\0key-one".into()));
}

#[test]
fn sticky_failover_management_clear_still_blocks_old_in_flight_bindings() {
    let sticky = StickySessions::default();
    let generation = sticky.generation();
    sticky.bind("session", "entry", "a\0key", "fixture", 1_000, 100_000, generation);
    sticky.clear(None, Some("entry"));
    sticky.bind("session", "entry", "b\0key", "fixture", 1_001, 100_000, generation);
    assert_eq!(sticky.lookup("session", "entry", 1_002, 100_000), None);
}
