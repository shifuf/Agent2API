//! Bounded, process-local observations used by routing. No account/database I/O.
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use serde_json::Value;
use super::routing_strategies::Seat;

const STALE_MS: i64 = 60 * 60 * 1000;
const HALF_LIFE_MS: f64 = 20.0 * 60.0 * 1000.0;
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Default)]
pub(crate) struct Observation {
    at: i64,
    pub ttft_ms: Option<f64>,
    pub tps: Option<f64>,
    pub tokens: f64,
    pub cache_read: bool,
}
static OBSERVATIONS: OnceLock<Mutex<HashMap<String, Observation>>> = OnceLock::new();
fn key(account: &str, model: &str) -> String { format!("{account}\0{model}") }
fn decay(age: i64) -> f64 { 2.0f64.powf(-(age.max(0) as f64) / HALF_LIFE_MS) }

pub(crate) fn record(account: &str, model: &str, now: i64, ttft_ms: Option<f64>, elapsed_ms: f64, tokens: i64, output: i64, cache_read: bool) {
    if account.is_empty() || model.is_empty() { return; }
    let mut table = OBSERVATIONS.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner());
    table.retain(|_, observation| now.saturating_sub(observation.at) <= STALE_MS);
    let key = key(account, model);
    if table.len() >= MAX_ENTRIES && !table.contains_key(&key) {
        if let Some(oldest) = table.iter().min_by_key(|(_, item)| item.at).map(|(key, _)| key.clone()) { table.remove(&oldest); }
    }
    let observation = table.entry(key).or_default();
    let retained = if observation.at == 0 { 0.0 } else { decay(now - observation.at) * 0.8 };
    fn smooth(old: Option<f64>, new: Option<f64>, retained: f64) -> Option<f64> {
        match (old, new.filter(|value| value.is_finite() && *value >= 0.0)) {
            (Some(old), Some(new)) => Some(old * retained + new * (1.0 - retained)),
            (_, Some(new)) => Some(new), (old, _) => old,
        }
    }
    observation.tokens = observation.tokens * decay(now - observation.at) + tokens.max(0) as f64;
    observation.ttft_ms = smooth(observation.ttft_ms, ttft_ms, retained);
    let generation_ms = elapsed_ms - ttft_ms.unwrap_or(0.0);
    observation.tps = smooth(observation.tps, (generation_ms > 0.0 && output > 0).then(|| output as f64 * 1000.0 / generation_ms), retained);
    observation.at = now;
    observation.cache_read = cache_read;
}

pub(crate) fn snapshot(now: i64) -> HashMap<String, Observation> {
    OBSERVATIONS.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner()).iter()
        .filter(|(_, observation)| now.saturating_sub(observation.at) <= STALE_MS)
        .map(|(key, observation)| { let mut observation = observation.clone(); observation.tokens *= decay(now - observation.at); (key.clone(), observation) }).collect()
}

pub(crate) fn cache_warm(account: &str, model: &str, now: i64) -> bool {
    OBSERVATIONS.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner())
        .get(&key(account, model)).is_some_and(|observation| observation.cache_read && now.saturating_sub(observation.at) < STALE_MS)
}

pub(crate) fn seats(accounts: &[Value], now: i64) -> Vec<Seat> {
    let facts = super::limiter::sources::facts();
    let observations = snapshot(now);
    accounts.iter().map(|account| {
        let id = super::routing::account_id(account).unwrap_or("");
        let provider = super::routing::provider_of(account);
        let model = super::routing_groups::candidate_model(account).unwrap_or("");
        let mut seat = Seat { key: super::routing_groups::attempt_key(account),
            weight: account.get("routingWeight").and_then(Value::as_u64).unwrap_or(1) as usize, ..Default::default() };
        if let Some(observation) = observations.get(&key(id, model)) {
            seat.tokens = observation.tokens; seat.ttft_ms = observation.ttft_ms; seat.tps = observation.tps;
        }
        if let Some(facts) = facts.get(id) {
            let mut windows: Vec<(i64, i64)> = Vec::new();
            for source in facts.sources.iter().filter(|source| source.live_at(now)
                && (source.models.is_empty() || source.models.iter().any(|known| known.eq_ignore_ascii_case(model)))) {
                let share = source.remaining_percent.map(|value| 100.0 - value).or_else(|| source.total.filter(|total| *total > 0.0)
                    .and_then(|total| source.used.or_else(|| source.remaining.map(|remaining| total - remaining))).map(|used| used * 100.0 / source.total.unwrap_or(1.0)));
                if let Some(share) = share.filter(|share| share.is_finite()) { seat.known = true; seat.used = seat.used.max(share.clamp(0.0, 100.0)); }
                if source.resets_at > now {
                    let span = source.window.as_ref().map(|window| window.seconds).unwrap_or(0);
                    windows.push((span, source.resets_at));
                    let hours = ((source.resets_at - now) as f64 / 3_600_000.0).max(1.0 / 60.0);
                    if let Some(share) = share { let pace = (100.0 - share).max(0.0) / hours; seat.pace = Some(seat.pace.map_or(pace, |known| known.min(pace))); }
                } else if source.window.is_none() && !source.unlimited {
                    if let Some(remaining) = source.remaining.filter(|amount| amount.is_finite()) {
                        let unit = format!("{provider}:{}", source.unit);
                        if seat.balance.is_none() || seat.balance_unit == unit { seat.balance = Some(seat.balance.unwrap_or(0.0) + remaining); seat.balance_unit = unit; }
                    }
                }
                if source.ends_at > now && source.remaining.is_some_and(|remaining| remaining > 0.0) {
                    seat.lapse = Some(seat.lapse.map_or(source.ends_at, |known| known.min(source.ends_at)));
                }
            }
            windows.sort_by(|a, b| b.0.cmp(&a.0));
            seat.renewals = windows.into_iter().map(|(_, time)| time / 3_600_000).collect();
            if seat.balance.is_none() && seat.renewals.is_empty() && !facts.unlimited && !facts.unit.is_empty() {
                seat.balance = facts.remaining.filter(|amount| amount.is_finite());
                seat.balance_unit = format!("{provider}:{}", facts.unit);
            }
        }
        let cost = account.get("routingCost").cloned();
        seat.free = account.get("routingFree").and_then(Value::as_bool).unwrap_or(false)
            || model.ends_with(":free")
            || cost.as_ref().is_some_and(|cost| cost.get("input").and_then(Value::as_f64) == Some(0.0) && cost.get("output").and_then(Value::as_f64) == Some(0.0));
        seat
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_speed_does_not_rank_a_recovered_provider_forever() {
        record("observation-test", "model", 100, Some(50.0), 1050.0, 200, 100, true);
        let fresh = snapshot(100);
        assert_eq!(fresh["observation-test\0model"].ttft_ms, Some(50.0));
        assert_eq!(fresh["observation-test\0model"].tps, Some(100.0));
        assert!(!snapshot(STALE_MS + 101).contains_key("observation-test\0model"));
    }
}
