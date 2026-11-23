//! Cache SQL enumerations; display rules remain live in RequestStats::filter_options.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::Value;

use super::{source_report, sql, RequestSource, MAX_FILTER_OPTIONS};

const MEMORY_TRUST_WINDOW: Duration = Duration::from_secs(15);
const ACTIVE_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub(super) struct FilterData {
    pub models: Vec<String>,
    pub providers: Vec<String>,
    pub sources: Value,
}

struct CachedFilters {
    external: i64,
    local: u64,
    computed_at: Instant,
    checked_at: Instant,
    invalidated: bool,
    written: bool,
    models: HashSet<String>,
    providers: HashSet<String>,
    clients: HashMap<String, String>,
    api_keys: HashMap<String, String>,
    data: FilterData,
}

#[derive(Default)]
pub(super) struct FilterOptionsCache {
    cached: Mutex<Option<CachedFilters>>,
}

fn labels(value: &Value, field: &str) -> HashMap<String, String> {
    value[field].as_array().into_iter().flatten().filter_map(|item| {
        Some((item["value"].as_str()?.to_owned(), item["label"].as_str().unwrap_or("").to_owned()))
    }).collect()
}

impl FilterOptionsCache {
    pub fn invalidate(&self) {
        if let Some(cached) = self.cached.lock().unwrap_or_else(|error| error.into_inner()).as_mut() {
            cached.invalidated = true;
        }
    }

    /// Called after a successful commit, before releasing the connection lock.
    /// Test caps independently: a full model list must not hide a new API Key.
    pub fn note_written(&self, model: &str, upstream_model: &str, provider: &str, source: Option<&RequestSource>, before: u64, after: u64) {
        let mut guard = self.cached.lock().unwrap_or_else(|error| error.into_inner());
        let Some(cached) = guard.as_mut() else { return; };
        cached.invalidated |= cached.local != before;
        cached.local = after;
        cached.written = true;
        let unseen = |value: &str, known: &HashSet<String>| !value.is_empty() && known.len() < MAX_FILTER_OPTIONS && !known.contains(value);
        cached.invalidated |= unseen(model, &cached.models) || unseen(upstream_model, &cached.models) || unseen(provider, &cached.providers);
        if let Some(source) = source {
            let client_label = if source.recorded_client_name().is_empty() { source_report::client_label(&source.client) } else { source.recorded_client_name() };
            if !source.client.is_empty() {
                cached.invalidated |= match cached.clients.get(&source.client) {
                    Some(label) => label != client_label,
                    None => cached.clients.len().saturating_sub(1) < MAX_FILTER_OPTIONS,
                };
            }
            let key = source.api_key.filter_value();
            cached.invalidated |= match cached.api_keys.get(&key) {
                Some(label) => !source.api_key.name.is_empty() && *label != source_report::key_label(&source.api_key),
                None => cached.api_keys.len() < MAX_FILTER_OPTIONS,
            };
        }
    }

    pub fn read_fast(&self, now: Instant, local: u64) -> Option<FilterData> {
        let guard = self.cached.lock().unwrap_or_else(|error| error.into_inner());
        let cached = guard.as_ref()?;
        if cached.invalidated || cached.local != local || now.saturating_duration_since(cached.checked_at) >= MEMORY_TRUST_WINDOW
            || (cached.written && now.saturating_duration_since(cached.computed_at) >= ACTIVE_REFRESH_INTERVAL) {
            return None;
        }
        Some(cached.data.clone())
    }

    /// Lock ordering is always stats -> connection -> cache. The fast read never
    /// holds its cache lock while asking for the database, so writes cannot race
    /// a stale cache publication or deadlock with a reader.
    pub fn read_or_compute(&self, conn: &Connection, now: Instant, local: u64) -> rusqlite::Result<FilterData> {
        let external = conn.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))?;
        let mut guard = self.cached.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(cached) = guard.as_mut() {
            if !cached.invalidated && cached.local == local && cached.external == external
                && (!cached.written || now.saturating_duration_since(cached.computed_at) < ACTIVE_REFRESH_INTERVAL) {
                cached.checked_at = now;
                return Ok(cached.data.clone());
            }
        }
        let (models, providers) = sql::select_filter_options(conn, MAX_FILTER_OPTIONS)?;
        let sources = sql::source_filter_options(conn, MAX_FILTER_OPTIONS)?;
        let data = FilterData { models, providers, sources };
        *guard = Some(CachedFilters {
            external, local, computed_at: now, checked_at: now, invalidated: false, written: false,
            models: data.models.iter().cloned().collect(), providers: data.providers.iter().cloned().collect(),
            clients: labels(&data.sources, "clients"), api_keys: labels(&data.sources, "apiKeys"), data: data.clone(),
        });
        Ok(data)
    }
}
