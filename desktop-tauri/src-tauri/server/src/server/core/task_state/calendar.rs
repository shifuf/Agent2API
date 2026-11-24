//! Calendar slots are absolute wall-clock times. Aligning a changed plan keeps
//! the real lease, min-gap and failure backoff instead of manufacturing a run.
use super::{storage::change, TaskState};

pub(crate) fn align(key: &str, now: i64, latest_slot: i64, next_slot: i64, min_gap: i64) -> Result<TaskState, String> {
    change(key, |state| align_state(state, now, latest_slot, next_slot, min_gap))
}

pub(super) fn align_state(state: &mut TaskState, now: i64, latest_slot: i64, next_slot: i64, min_gap: i64) {
    state.adjust_clock(now);
    if !state.owner.is_empty() && state.lease_until > now { return; }
    let planned = if latest_slot > 0 && state.last_attempt_at < latest_slot { latest_slot }
        else if state.failures > 0 { state.retry_at }
        else { next_slot };
    state.next_run_at = planned.max(state.last_attempt_at.saturating_add(min_gap));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moved_earlier_calendar_slot_becomes_due_but_keeps_min_gap_and_retry() {
        let mut state = TaskState { last_attempt_at: 1_000, next_run_at: 18_000, ..Default::default() };
        align_state(&mut state, 10_000, 8_000, 32_000, 1_000);
        assert_eq!(state.next_run_at, 8_000, "moving 18:00 to 08:00 can run today's unattempted slot");
        state.last_attempt_at = 9_500;
        align_state(&mut state, 10_000, 9_800, 32_000, 1_000);
        assert_eq!(state.next_run_at, 10_500);
        state.failures = 2;
        state.retry_at = 20_000;
        align_state(&mut state, 10_000, 8_000, 32_000, 1_000);
        assert_eq!(state.retry_at, 20_000);
        assert_eq!(state.due_at(), 20_000, "changing calendar never clears failure backoff");
    }

    #[test]
    fn calendar_changes_never_steal_active_lease() {
        let mut state = TaskState { last_attempt_at: 9_000, next_run_at: 18_000,
            lease_until: 90_000, owner: "real-owner".into(), failures: 1, retry_at: 25_000, ..Default::default() };
        align_state(&mut state, 10_000, 8_000, 32_000, 1_000);
        assert_eq!(state.owner, "real-owner");
        assert_eq!(state.lease_until, 90_000);
        assert_eq!(state.next_run_at, 18_000);
        assert_eq!(state.retry_at, 25_000);
    }
}
