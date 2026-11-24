# Plugins and Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for independent tasks, or superpowers:executing-plans for tightly coupled migration. Continuous execution is authorized by the user.

**Goal:** Restore retained provider accounts, make upstream plugin packages usable, and provide one proxy page with multi-account and multi-node bindings before publishing/deploying the verified result.

**Architecture:** Account proxy configurations remain the binding source of truth. Plugin compatibility is based on real host protocols/capabilities; legacy RPC and new WASM are integrated through reviewed interfaces. Existing custom routing and Docker flows remain protected.

**Tech Stack:** Rust/Axum/SQLite, React/TypeScript islands and mobile, official WASM runtime and existing native RPC.

**Spec:** docs/superpowers/specs/2026-11-24-plugins-proxy-design.md

## Global Constraints

- Product version 3.5.1 tracks fixed upstream 33f5e797836ac91d958022e9f4ca53c30d0432ec; only origin/beta, no main/tag/Release.
- Publish and deploy after verified completion, directly authorized 2026-11-24; target only 175.178.69.4:3065.
- Preserve custom routing groups, selected account/Key/model scopes, admin-only account secrets, multiplier semantics, sticky failure freeze, proxy subscription lifecycle, Docker/GHCR custom origins.
- No actual account migration tests on production data; backup and rollback before deployment.
- Native signature and capability checks remain effective; no fake plugin version or official badge.

## Review Focus

- A retained old native pack with same protocol must load regardless of gateway product version; incompatible packages must fail clearly.
- Community/third-party provenance must never acquire automatic official replacement or unapproved account ownership.
- Multiple bindings to one node and explicit rotate candidate bindings must survive restart, and changing proxy from accounts page must update displayed binding.
- Stale/missing/disabled target or unknown account rejects the complete batch before any account write; account credentials must not appear in binding payload.
- Subscription revision changes, paused/deleted nodes and concurrent proxy operations must preserve current cancellation and deny unintended direct fallback.

---

### Task 1: Plugin runtime, compatibility and market

**Files:** core/plugin_host modules, necessary host dependency modules, server Cargo manifests/lock, api/plugins, ui-shared/plugins and desktop/mobile plugin panels; exact dependency cut recorded by builder check before implementation.

**Interfaces:** Existing Host/RpcAdapter and PackRegistry remain integration boundary; genuine WASM init/store/http/stream/protocol capabilities from fixed upstream are bridged to current AccountStore and egress. Market payload includes installable actual target and capability errors.

- [x] Reproduce gateway-version native block and WASM target mismatch using published packages in temporary data.
- [x] Read architecture assessment, record dependency adoption rulings, and implement coherent official WASM host path without replacing custom routing/UI.
- [x] Validate package provenance, capabilities, store scope/CAS and fallback legacy ownership.
- [x] Build and run temporary-data native plus actual WASM installation/start/stream/restart tests.
- [x] Review final plugin change and record sources/authors in upstream-sync.

### Task 2: Proxy bindings and unified page

**Files:** api/proxies.rs (split bindings module if needed), AccountStore binding helper, HTTP/bridge registration, ui-islands/proxies-page and state/columns, proxy-groups shared component, mobile proxy page, ui-shared/proxy-usage and new binding types/dialog.

**Interfaces:** GET /api/proxies/bindings -> {accounts:[{id,name,provider,providerLabel,enabled,proxy}],items:ProxyPoolItem[]}; POST /api/proxies/bindings -> {accountIds:string[],proxyIds:string[]} applies pool for one and rotate for multiple, [] explicitly removes selected bindings. Response returns current binding/account and pool metadata. Reuse existing account-management auth and notification/lazy-listener lifecycle. Maximum 200 unique accounts per write.

- [x] Write failing HTTP cases for many accounts/one node, explicit multiple nodes, inverse account-page update, unknown/disabled/stale inputs, credential redaction and atomic reject.
- [x] Implement strict transactional binding updates derived from current account proxy, and register management HTTP/desktop bridge path.
- [x] Integrate subscription group selection within one subscription expansion; add visible binding column/dialog with provider grouping, multi-selection and resync.
- [x] Implement mobile parity and meaningful UI verification with actual server and temporary fixture.
- [x] Verify Rust/TypeScript/build/i18n, current actual Mihomo group/cancel lifecycle and custom account/Key regressions; record changed paths and evidence.

### Task 3: Integration, release, deployment

- [x] Run affected full server tests and custom route/protocol/Mihomo/browser checks on final source; independently review final combined changes.
- [x] Record final reviewed release log in user-visible commentary, retaining product 3.5.1 and upstream source/author trailers; direct push/deploy authorization already supplied.
- [ ] Commit verified files, fast-forward HEAD to origin/beta, verify CI dual-arch index/config revision.
- [ ] Snapshot current live account/proxy/plugin state and backup production before digest-pinned update; verify health, real plugin load and retained-account/binding counts, external pages; retain rollback container.
- [ ] Notify user with GitHub commit/site links and concrete verified functionality/limits.
