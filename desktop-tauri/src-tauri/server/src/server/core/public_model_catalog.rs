//! PublicProviderConf candidates for manually managed models. This catalog never
//! grants access, changes channels, or publishes models to the gateway.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

pub const SOURCE_URL: &str = "https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/refs/heads/dev/dist/all.json";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const CACHE_TTL_SECONDS: i64 = 3600;
const RETRY_DELAY: Duration = Duration::from_secs(30);
// all.json exceeds 8 MiB; real transfers can take 30-45 seconds even when
// headers arrive immediately. Stay within the desktop bridge's 60-second limit.
const FETCH_TIMEOUT: Duration = Duration::from_secs(50);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub providers: Vec<CatalogProvider>,
    pub source_url: String,
    pub fetched_at: String,
    pub updated_at: String,
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct CatalogCache {
    path: PathBuf,
    state: Mutex<CacheState>,
    generation: AtomicU64,
}

#[derive(Default)]
struct CacheState {
    loaded: bool,
    snapshot: Option<CatalogSnapshot>,
    error: Option<String>,
    attempted_at: Option<Instant>,
}

impl CacheState {
    fn response(&self) -> Result<CatalogSnapshot, String> {
        match &self.snapshot {
            Some(snapshot) => {
                let mut response = snapshot.clone();
                response.stale = self.error.is_some() || !is_fresh(snapshot);
                response.error = self.error.clone();
                Ok(response)
            }
            None => Err(self
                .error
                .clone()
                .unwrap_or_else(|| "Public model catalog is unavailable".into())),
        }
    }
}

impl CatalogCache {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(CacheState::default()),
            generation: AtomicU64::new(0),
        }
    }

    async fn snapshot_with<F, Fut>(&self, force: bool, fetch: F) -> Result<CatalogSnapshot, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let generation = self.generation.load(Ordering::Acquire);
        // This lock is local to this catalog. Holding it across the bounded
        // download collapses both automatic and simultaneous explicit refreshes.
        let mut state = self.state.lock().await;
        if !state.loaded {
            state.snapshot = read_cache(&self.path).await;
            state.loaded = true;
        }
        if generation != self.generation.load(Ordering::Acquire) {
            return state.response();
        }
        if !force {
            let cooling_down = state.error.is_some()
                && state
                    .attempted_at
                    .is_some_and(|attempt| attempt.elapsed() < RETRY_DELAY);
            let fresh = state.error.is_none() && state.snapshot.as_ref().is_some_and(is_fresh);
            if cooling_down || fresh {
                return state.response();
            }
        }
        match fetch().await.and_then(|bytes| parse_catalog(&bytes)) {
            Ok(snapshot) => {
                if let Err(error) = write_cache(&self.path, &snapshot).await {
                    crate::server::logging::log(
                        "[Models]",
                        &format!("公开模型目录缓存写入失败: {error}"),
                    );
                }
                state.snapshot = Some(snapshot);
                state.error = None;
            }
            Err(error) => state.error = Some(error),
        }
        state.attempted_at = Some(Instant::now());
        self.generation.fetch_add(1, Ordering::Release);
        state.response()
    }
}

/// Public candidates only: no provider/account headers or gateway credentials
/// are involved, and callers cannot choose a URL or redirect the request.
pub async fn snapshot(force: bool) -> Result<CatalogSnapshot, String> {
    static CACHE: OnceLock<CatalogCache> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            CatalogCache::new(crate::paths::config_dir().join("public-model-catalog.json"))
        })
        .snapshot_with(force, fetch_catalog)
        .await
}

async fn fetch_catalog() -> Result<Vec<u8>, String> {
    // Follow the machine's proxy settings for this account-independent public
    // download, with a separate client that has no credential-bearing headers.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(FETCH_TIMEOUT)
        .user_agent("Agent2API-public-model-catalog")
        .build()
        .map_err(|error| format!("Could not create catalog client: {error}"))?;
    let response = client
        .get(SOURCE_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not fetch public model catalog: {error}"))?;
    read_response(response).await
}

async fn read_response(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "Public model catalog returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let declared_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if [declared_length, response.content_length()]
        .into_iter()
        .flatten()
        .any(|length| length > MAX_BYTES as u64)
    {
        return Err("Public model catalog exceeds the 16 MiB limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read public model catalog: {error}"))?
    {
        if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
            return Err("Public model catalog exceeds the 16 MiB limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Deserialize)]
struct SourceCatalog {
    providers: BTreeMap<String, SourceProvider>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct SourceProvider {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    models: Vec<SourceModel>,
}

#[derive(Deserialize)]
struct SourceModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

fn label<'a>(values: &[Option<&'a str>], fallback: &'a str) -> String {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn parse_catalog(bytes: &[u8]) -> Result<CatalogSnapshot, String> {
    if bytes.len() > MAX_BYTES {
        return Err("Public model catalog exceeds the 16 MiB limit".into());
    }
    let source: SourceCatalog = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid public model catalog: {error}"))?;
    let mut providers = BTreeMap::<String, CatalogProvider>::new();
    let mut model_ids = HashSet::new();
    for (key, raw) in source.providers {
        let id = label(&[raw.id.as_deref()], key.trim());
        if id.is_empty() {
            continue;
        }
        let name = label(&[raw.display_name.as_deref(), raw.name.as_deref()], &id);
        let provider = providers
            .entry(id.clone())
            .or_insert_with(|| CatalogProvider {
                id: id.clone(),
                name,
                models: Vec::new(),
            });
        for raw_model in raw.models {
            let model_id = label(&[raw_model.id.as_deref()], "");
            if model_id.is_empty() || !model_ids.insert((id.clone(), model_id.clone())) {
                continue;
            }
            provider.models.push(CatalogModel {
                name: label(
                    &[raw_model.display_name.as_deref(), raw_model.name.as_deref()],
                    &model_id,
                ),
                kind: label(&[raw_model.kind.as_deref()], "chat"),
                id: model_id,
            });
        }
    }
    let mut providers: Vec<_> = providers
        .into_values()
        .filter(|provider| !provider.models.is_empty())
        .collect();
    if providers.is_empty() {
        return Err("Public model catalog contains no usable models".into());
    }
    for provider in &mut providers {
        provider
            .models
            .sort_by_cached_key(|model| (model.name.to_lowercase(), model.id.clone()));
    }
    providers.sort_by_cached_key(|provider| (provider.name.to_lowercase(), provider.id.clone()));
    Ok(CatalogSnapshot {
        providers,
        source_url: SOURCE_URL.into(),
        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        updated_at: source.updated_at.unwrap_or_default(),
        stale: false,
        error: None,
    })
}

fn is_fresh(snapshot: &CatalogSnapshot) -> bool {
    chrono::DateTime::parse_from_rfc3339(&snapshot.fetched_at).is_ok_and(|fetched| {
        let age = chrono::Utc::now().timestamp() - fetched.timestamp();
        (0..CACHE_TTL_SECONDS).contains(&age)
    })
}

async fn read_cache(path: &Path) -> Option<CatalogSnapshot> {
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let mut cached: CatalogSnapshot = serde_json::from_slice(&bytes).ok()?;
    if cached.source_url != SOURCE_URL
        || cached.providers.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&cached.fetched_at).is_err()
    {
        return None;
    }
    let mut provider_ids = HashSet::new();
    for provider in &cached.providers {
        if provider.id.trim().is_empty()
            || provider.name.trim().is_empty()
            || provider.models.is_empty()
            || !provider_ids.insert(&provider.id)
        {
            return None;
        }
        let mut model_ids = HashSet::new();
        for model in &provider.models {
            if model.id.trim().is_empty()
                || model.name.trim().is_empty()
                || model.kind.trim().is_empty()
                || !model_ids.insert(&model.id)
            {
                return None;
            }
        }
    }
    cached.stale = false;
    cached.error = None;
    Some(cached)
}

async fn write_cache(path: &Path, snapshot: &CatalogSnapshot) -> Result<(), String> {
    let path = path.to_path_buf();
    let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        let parent = path
            .parent()
            .ok_or_else(|| "Catalog cache directory is missing".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(path)
            .map_err(|error| error.error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    const SOURCE: &[u8] = br#"{
        "updated_at":"2026-11-06T19:19:22.445Z",
        "providers":{
            "vendor":{"id":"Vendor","name":"Vendor","display_name":"Vendor Display","models":[
                {"id":"Org/Model-A","name":"Original","display_name":"Model A","type":"chat"},
                {"id":"Org/Model-A","name":"Duplicate","type":"chat"},
                {"id":"embed-1","name":"Embedding","type":"embedding"},
                {"id":"  ","name":"Invalid"}
            ]},
            "vendor-copy":{"id":"Vendor","models":[{"id":"Model-B"}]},
            "fallback":{"models":[{"id":"Slash/Case"}]},
            "empty":{"name":"Empty","models":[]}
        }
    }"#;

    fn cache() -> (tempfile::TempDir, CatalogCache) {
        let dir = tempfile::tempdir().unwrap();
        let cache = CatalogCache::new(dir.path().join("public-model-catalog.json"));
        (dir, cache)
    }

    #[test]
    fn parses_display_names_merges_duplicate_providers_and_preserves_model_ids() {
        let parsed = parse_catalog(SOURCE).unwrap();
        assert_eq!(parsed.providers.len(), 2);
        let vendor = parsed
            .providers
            .iter()
            .find(|provider| provider.id == "Vendor")
            .unwrap();
        assert_eq!(vendor.name, "Vendor Display");
        assert_eq!(vendor.models.len(), 3);
        let model = vendor
            .models
            .iter()
            .find(|model| model.id == "Org/Model-A")
            .unwrap();
        assert_eq!(model.name, "Model A");
        assert_eq!(model.kind, "chat");
        let fallback = parsed
            .providers
            .iter()
            .find(|provider| provider.id == "fallback")
            .unwrap();
        assert_eq!(fallback.name, "fallback");
        assert_eq!(fallback.models[0].id, "Slash/Case");
        assert_eq!(fallback.models[0].name, "Slash/Case");
        assert_eq!(fallback.models[0].kind, "chat");
        assert_eq!(parsed.source_url, SOURCE_URL);
        assert_eq!(parsed.updated_at, "2026-11-06T19:19:22.445Z");
        assert!(chrono::DateTime::parse_from_rfc3339(&parsed.fetched_at).is_ok());
        assert!(!parsed.stale);
    }

    #[test]
    fn rejects_malformed_empty_and_oversized_sources() {
        for invalid in [
            b"not JSON".as_slice(),
            br#"{}"#,
            br#"{"providers":[]}"#,
            br#"{"providers":{}}"#,
            br#"{"providers":{"empty":{"models":[]}}}"#,
            br#"{"providers":{"bad":{"models":[{"id":42}]}}}"#,
        ] {
            assert!(parse_catalog(invalid).is_err());
        }
        let mut oversized = SOURCE.to_vec();
        oversized.resize(MAX_BYTES + 1, b' ');
        assert!(parse_catalog(&oversized).is_err());
    }

    #[tokio::test]
    async fn fresh_memory_and_disk_cache_avoid_another_download() {
        let (_dir, cache) = cache();
        let first = cache
            .snapshot_with(false, || async { Ok(SOURCE.to_vec()) })
            .await
            .unwrap();
        assert!(cache.path.is_file());
        let memory = cache
            .snapshot_with(false, || async { Err("must not fetch".into()) })
            .await
            .unwrap();
        assert_eq!(memory, first);
        let restarted = CatalogCache::new(cache.path.clone());
        let disk = restarted
            .snapshot_with(false, || async { Err("must not fetch".into()) })
            .await
            .unwrap();
        assert_eq!(disk, first);
    }

    #[tokio::test]
    async fn failed_or_empty_refresh_keeps_the_last_good_memory_and_disk_copy() {
        let (_dir, cache) = cache();
        let first = cache
            .snapshot_with(false, || async { Ok(SOURCE.to_vec()) })
            .await
            .unwrap();
        let saved = tokio::fs::read(&cache.path).await.unwrap();
        let stale = cache
            .snapshot_with(true, || async { Err("offline".into()) })
            .await
            .unwrap();
        assert_eq!(stale.providers, first.providers);
        assert_eq!(stale.fetched_at, first.fetched_at);
        assert!(stale.stale);
        assert_eq!(stale.error.as_deref(), Some("offline"));
        let invalid = cache
            .snapshot_with(true, || async { Ok(br#"{"providers":{}}"#.to_vec()) })
            .await
            .unwrap();
        assert_eq!(invalid.providers, first.providers);
        assert!(invalid.stale);
        assert!(invalid.error.is_some());
        assert_eq!(tokio::fs::read(&cache.path).await.unwrap(), saved);
        let recovered = cache
            .snapshot_with(true, || async { Ok(SOURCE.to_vec()) })
            .await
            .unwrap();
        assert!(!recovered.stale);
        assert!(recovered.error.is_none());
    }

    #[tokio::test]
    async fn expired_disk_cache_is_returned_when_refresh_fails() {
        let (_dir, cache) = cache();
        let mut old = parse_catalog(SOURCE).unwrap();
        old.fetched_at = "2000-01-01T00:00:00Z".into();
        tokio::fs::write(&cache.path, serde_json::to_vec(&old).unwrap())
            .await
            .unwrap();
        let stale = cache
            .snapshot_with(false, || async { Err("offline".into()) })
            .await
            .unwrap();
        assert!(stale.stale);
        assert_eq!(stale.fetched_at, "2000-01-01T00:00:00Z");
        assert_eq!(stale.providers, old.providers);
    }

    #[tokio::test]
    async fn cold_failure_is_reported_and_corrupt_disk_is_not_accepted() {
        let (_dir, cache) = cache();
        tokio::fs::write(&cache.path, b"{}").await.unwrap();
        assert_eq!(
            cache
                .snapshot_with(false, || async { Err("offline".into()) })
                .await
                .unwrap_err(),
            "offline"
        );
        let recovered = cache
            .snapshot_with(true, || async { Ok(SOURCE.to_vec()) })
            .await
            .unwrap();
        assert!(!recovered.providers.is_empty());
    }

    #[tokio::test]
    async fn concurrent_explicit_refreshes_share_one_download_and_result() {
        let (_dir, cache) = cache();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(SOURCE.to_vec())
        };
        let (left, right) = tokio::join!(
            cache.snapshot_with(true, fetch),
            cache.snapshot_with(true, fetch)
        );
        assert_eq!(left.unwrap(), right.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failure_cooldown_and_concurrent_failures_do_not_repeat_downloads() {
        let (_dir, cache) = cache();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Err("offline".into())
        };
        let (left, right) = tokio::join!(
            cache.snapshot_with(true, fetch),
            cache.snapshot_with(true, fetch)
        );
        assert_eq!(left.unwrap_err(), "offline");
        assert_eq!(right.unwrap_err(), "offline");
        assert_eq!(
            cache.snapshot_with(false, fetch).await.unwrap_err(),
            "offline"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let recovered = cache
            .snapshot_with(true, || async { Ok(SOURCE.to_vec()) })
            .await
            .unwrap();
        assert!(!recovered.stale);
    }

    #[test]
    fn freshness_expires_after_one_hour_and_rejects_future_clock_values() {
        let mut parsed = parse_catalog(SOURCE).unwrap();
        assert!(is_fresh(&parsed));
        parsed.fetched_at = (chrono::Utc::now() - chrono::Duration::seconds(3601)).to_rfc3339();
        assert!(!is_fresh(&parsed));
        parsed.fetched_at = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        assert!(!is_fresh(&parsed));
    }

    #[tokio::test]
    async fn download_rejects_non_success_and_both_declared_and_streamed_oversize() {
        let redirect = axum::http::Response::builder()
            .status(302)
            .body(Vec::<u8>::new())
            .unwrap();
        assert!(read_response(redirect.into())
            .await
            .unwrap_err()
            .contains("302"));
        let declared = axum::http::Response::builder()
            .header("content-length", (MAX_BYTES + 1).to_string())
            .body(Vec::<u8>::new())
            .unwrap();
        assert!(read_response(declared.into()).await.is_err());
        let chunks = futures::stream::iter([
            Ok::<_, std::io::Error>(vec![b' '; MAX_BYTES]),
            Ok(vec![b' ']),
        ]);
        let streamed = axum::http::Response::new(reqwest::Body::wrap_stream(chunks));
        assert!(read_response(streamed.into()).await.is_err());
        let valid = axum::http::Response::new(SOURCE.to_vec());
        assert_eq!(read_response(valid.into()).await.unwrap(), SOURCE);
    }

    #[tokio::test]
    async fn structurally_invalid_disk_cache_cannot_be_returned_as_a_success() {
        let (_dir, cache) = cache();
        let mut invalid = parse_catalog(SOURCE).unwrap();
        invalid.providers[0].models[0].id.clear();
        tokio::fs::write(&cache.path, serde_json::to_vec(&invalid).unwrap())
            .await
            .unwrap();
        assert_eq!(
            cache
                .snapshot_with(false, || async { Err("offline".into()) })
                .await
                .unwrap_err(),
            "offline"
        );
    }
}
