//! Per-entry channel health. A channel includes all of its account/Key candidates.
use std::collections::HashMap;
use std::sync::Mutex;

use crate::server::core::routing_groups;

const MAX_CHANNELS: usize = 10_000;

#[derive(Clone, Debug)]
pub(super) struct ChannelLease {
    pub scope: String,
    pub candidate: String,
    generation: u64,
}

struct ChannelEntry {
    failures: u32,
    failed_candidate: Option<String>,
    frozen_until: i64,
    last_seen: i64,
    generation: u64,
}

#[derive(Default)]
struct HealthTable {
    entries: HashMap<(String, String), ChannelEntry>,
    generation: u64,
}

#[derive(Default)]
pub(super) struct RouteHealth {
    table: Mutex<HealthTable>,
}

pub(super) struct ChannelFailure {
    pub failures: u32,
    pub frozen_until: Option<i64>,
}

fn channel_key(scope: &str, candidate: &str) -> (String, String) {
    (scope.to_owned(), routing_groups::member_key(candidate).unwrap_or(candidate).to_owned())
}

impl RouteHealth {
    /// Capture before sending, so a success started before a freeze cannot
    /// reset health or restore affinity, including after the freeze expires.
    pub fn begin(&self, scope: &str, candidate: &str, now: i64) -> Result<ChannelLease, i64> {
        let key = channel_key(scope, candidate);
        let mut table = self.table.lock().unwrap_or_else(|error| error.into_inner());
        if !table.entries.contains_key(&key) {
            if table.entries.len() >= MAX_CHANNELS {
                let oldest = table.entries.iter().filter(|(_, entry)| entry.frozen_until <= now)
                    .min_by_key(|(_, entry)| entry.last_seen).map(|(key, _)| key.clone());
                if let Some(oldest) = oldest { table.entries.remove(&oldest); }
                else { return Err(table.entries.values().map(|entry| entry.frozen_until).min().unwrap_or(now.saturating_add(1_000))); }
            }
            table.generation = table.generation.wrapping_add(1);
            let generation = table.generation;
            table.entries.insert(key.clone(), ChannelEntry { failures: 0, failed_candidate: None, frozen_until: 0, last_seen: now, generation });
        }
        if table.entries.get(&key).is_some_and(|entry| entry.frozen_until > 0 && entry.frozen_until <= now) {
            table.generation = table.generation.wrapping_add(1);
            let generation = table.generation;
            let entry = table.entries.get_mut(&key).expect("entry exists");
            entry.failures = 0;
            entry.failed_candidate = None;
            entry.frozen_until = 0;
            entry.generation = generation;
        }
        let entry = table.entries.get_mut(&key).expect("entry exists");
        if entry.frozen_until > now { return Err(entry.frozen_until); }
        entry.last_seen = now;
        Ok(ChannelLease { scope: scope.into(), candidate: candidate.into(), generation: entry.generation })
    }

    pub fn frozen_until(&self, scope: &str, candidate: &str, now: i64) -> Option<i64> {
        self.table.lock().unwrap_or_else(|error| error.into_inner()).entries.get(&channel_key(scope, candidate))
            .map(|entry| entry.frozen_until).filter(|until| *until > now)
    }

    /// Only a completed response clears this preference across requests.
    pub fn failed_candidate(&self, scope: &str, candidate: &str) -> Option<String> {
        self.table.lock().unwrap_or_else(|error| error.into_inner()).entries.get(&channel_key(scope, candidate))
            .and_then(|entry| entry.failed_candidate.clone())
    }

    /// Both callbacks run under the health lock, always health -> sticky. A
    /// freeze and a late successful binding therefore cannot cross each other.
    pub fn failure(&self, lease: &ChannelLease, timeout_seconds: i64, now: i64, on_freeze: impl FnOnce()) -> ChannelFailure {
        let mut table = self.table.lock().unwrap_or_else(|error| error.into_inner());
        let key = channel_key(&lease.scope, &lease.candidate);
        let Some(entry) = table.entries.get(&key) else { return ChannelFailure { failures: 0, frozen_until: None }; };
        if entry.frozen_until > now { return ChannelFailure { failures: entry.failures, frozen_until: Some(entry.frozen_until) }; }
        if entry.generation != lease.generation { return ChannelFailure { failures: 0, frozen_until: None }; }
        let failures = entry.failures.saturating_add(1);
        let generation = if failures >= 2 {
            table.generation = table.generation.wrapping_add(1);
            table.generation
        } else { lease.generation };
        let entry = table.entries.get_mut(&key).expect("entry exists");
        entry.failures = failures;
        entry.failed_candidate = Some(lease.candidate.clone());
        entry.last_seen = now;
        entry.generation = generation;
        let frozen_until = if failures >= 2 {
            let until = now.saturating_add(timeout_seconds.clamp(10, 600) * 1_000);
            entry.frozen_until = until;
            on_freeze();
            Some(until)
        } else { None };
        ChannelFailure { failures, frozen_until }
    }

    pub fn success(&self, lease: &ChannelLease, now: i64, on_success: impl FnOnce()) -> bool {
        let mut table = self.table.lock().unwrap_or_else(|error| error.into_inner());
        let Some(entry) = table.entries.get_mut(&channel_key(&lease.scope, &lease.candidate)) else { return false; };
        if entry.generation != lease.generation || entry.frozen_until > 0 { return false; }
        entry.failures = 0;
        entry.failed_candidate = None;
        entry.last_seen = now;
        on_success();
        true
    }
}

#[cfg(test)]
mod tests;
