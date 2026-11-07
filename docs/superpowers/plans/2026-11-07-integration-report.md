# Channels, managed models, subscriptions and Docker integration

Implemented on local `beta` from `e8bed7397aaf9d8962489074557c2f1f1a8d4f97` (3.4.2). The user approved applying manual model management to the entire gateway. No version, remote branch, tag or Release was changed.

## Delivered behavior

- API-template channels accept API URL, protocol and named Key groups. Each group has multiple encrypted credentials, an enabled state and an explicit upstream model selection. Model discovery uses the selected draft/saved Key and never publishes models automatically. Existing accounts retain IDs, proxy settings, priority and cooldown information during group edits.
- `/api/models/catalog` manages explicit public IDs, display names, enabled state and channel/upstream bindings. Optimistic revisions prevent overwriting concurrent edits; drafts survive conflicts. Bindings resolve once, including when a public ID equals a different upstream ID. Existing routing groups remain explicit public endpoints.
- Desktop and mobile default to the manual model list. The old source catalog remains available for discovery and source maintenance. Gateway Key choices use published models and channel intersections. An empty manual catalog does not expose raw upstream names. Deleting a channel preserves the Key's previous restrictions.
- Actual forwarding checks channel and group availability. Source-model tests preserve legacy source mappings and reasoning, bypass public alias rewriting, and authorize the resolved upstream against the Key's published bindings and routing-group account restrictions.
- Restored proxy subscriptions and Mihomo management from beta.5 against the current backend contracts, including desktop/mobile controls, imports, refresh, backup and lifecycle hooks. Pause/resume preserves account references, same-name node changes rebuild correctly, stale ports are cleared, and unavailable bound proxies fail without a direct-connection fallback.
- Added a repository-owned GHCR workflow for pushes to `main`/`beta` and manual builds. The image rebuilds desktop/mobile/i18n assets, supports amd64/arm64, preserves `/data`, and disables upstream self-update by default. Six install documents and README quick-start references are synchronized.

## Verification

- Server compilation and executable startup passed with the isolated Windows Rust GNU toolchain and direct LLVM lld final linking.
- Full Rust suite: 307 passed, 0 failed, 0 ignored, using the final test harness with `--test-threads=1` (17.01s). Log: `F:/tmp/agent2api-final-rust-tests.log`.
- `node --test desktop-tauri/ui-islands/src/islands/keys-page.test.mjs desktop-tauri/ui-shared/managed-models.test.mjs desktop-tauri/ui-shared/proxy-usage.test.mjs`: 10 passed, 0 failed.
- Desktop TypeScript/build, mobile TypeScript/build and i18n generation passed. Dictionary scan reported zero missing keys in all five locales; pre-existing untranslated entries remain unchanged.
- `node scripts/test-managed-channels.mjs target/debug/agent2api-server.exe`: passed using an isolated data directory and local HTTP/SSE upstream. Covers empty catalog, discovery, single-hop aliases, actual selected credentials, channel/model permissions, source-test authorization and reasoning, disabled channels/groups, empty groups, routing groups, stale revisions, channel deletion, stale bindings and unavailable proxy rejection. Disabled-channel and source-alias regressions were observed failing before their fixes.
- Subscription acceptance passed with official Mihomo v1.19.32 on Windows amd64, verifying archive and binary SHA256 against the pinned manifest. Local HTTP subscription/origin/proxy fixtures exercised actual forwarding, imports, pause/resume, stable IDs, reference preservation, same-name server/password replacement and deletion cleanup. The reproducible script is `scripts/test-proxy-subscriptions.mjs`; its optional second argument accepts an already downloaded kernel.
- `scripts/test-channel-ui.mjs` passed all 8 browser scenarios against the final server, covering desktop model creation, API-template Key selection/discovery, explicit publication, gateway Key selectors, subscription editing and mobile editing at 390px. Console, page, network-request and HTTP errors were all zero; screenshots were reviewed. Playwright remains an optional external dependency. Final results are in `F:/tmp/agent2api-browser/portable-final/2026-11-07T13-51-19-560Z/results.json`.
- `actionlint .github/workflows/docker.yml` passed. Workflow/Compose structure, Bash image tag selection and Dockerfile stage inputs were also checked.

## Existing test compatibility repairs

Three old fixtures required fields/arguments added by prior changes: RequestQuery defaults, WebDavConfig defaults and the send_with_retry telemetry/signature. The old CodeArts quota classifier test called `adapter_for`, which already returned a missing-plugin placeholder in the starting revision. The real implementation was removed in `e6e44344`. That test now verifies the current missing-plugin contract (Fatal 403 and no quota cooldown); the generic adapter reset-time persistence tests remain intact.

An existing gate-expiry test read the system clock separately for registration and its TTL boundary. Crossing a millisecond between those reads caused a false expiry failure. It now injects the same baseline into `hold_at` and `gated_at`, preserving both before-expiry and exact-expiry assertions without changing runtime behavior.

## Validation boundaries

- The machine has no Docker engine. Actual image build, publication and Linux amd64/arm64 container startup were not performed. The workflow is ready for an authorized push; its existence does not imply a package is already published.
- Proxy runtime verification used the pinned real Windows kernel with local HTTP fixtures. Remote subscription services, other proxy protocols and non-Windows kernel lifecycle were not exercised.
- Image-model bindings were reviewed and compiled; no live image-provider request was made.
- The temporary GNU linker produced executables that crashed during Rust initialization, before application main. LLDB localized an unrelocated Windows import; direct LLVM lld resolved it. Toolchain paths and binaries remain outside tracked product configuration.

## Maintenance entry points

- Managed catalog: `core/managed_models.rs`, `api/managed_models.rs`, `ui-shared/managed-models.ts`, desktop/mobile managed-model pages.
- Channels: `core/account_store/custom_accounts/key_groups.rs`, custom-provider APIs, `channel-key-groups.tsx` and the existing channel editor.
- Subscriptions: `core/subscriptions.rs`, `core/sub_kernel/`, subscription APIs and proxy UI modules.
- Containers: `.github/workflows/docker.yml`, `Dockerfile`, `docker-compose.yml`.
- User setup and upgrade behavior: `docs/install.md` and its five translations.
