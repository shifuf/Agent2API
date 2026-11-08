# Magpie Routing Implementation Plan

> **For agentic workers:** Use executing-plans for root integration and dispatching-parallel-agents for independently owned backend, runtime and UI tasks. Track completed checks here; do not push or release.

**Goal:** Direct developer/model selection and functional Magpie-style routing across the gateway.

**Architecture:** Extend the existing Rust routing resolver and forwarding chain, sharing decisions with management preview. Separate metadata discovery, group/rule resolution, runtime strategies and React editors behind the design's contracts.

**Tech Stack:** Rust, Axum, Tokio, React, TypeScript, Base UI, Node/Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-magpie-routing-design.md`

## Global Constraints

- Preserve version 3.4.2 and user data; references are read-only.
- No branch/tag push or release. Root coordinates Cargo builds and service restart.
- Preserve built-in adapters, Key restrictions, explicit account selection and old IDs.
- New models and raw upstream catalogs remain manually published.
- UI choices must map to implemented runtime behavior; preview has no sending/cursor side effects.

## Review Focus

- Nested/pattern/classifier routes must never escape Key model/provider and credential-group restrictions (tasks 2/3/5).
- Empty or disabled selections must not expand into all accounts (tasks 2/4/5).
- Legacy usage and absent fields retain old behavior (tasks 2/3).
- Stream timeout/fallback must never mix two replies after content is committed (tasks 3/5).
- Metadata failures or alternate spellings must neither merge distinct variants nor publish unavailable models (tasks 1/5).

## Task 1: Direct model ID and metadata

Files: shared model editor/picker/catalog and tests; new server `core/routing_metadata.rs`, `core/routing_discovery.rs`; public catalog cache integration.

- [x] Direct combobox behavior tests fail before implementation, including custom candidates.
- [x] Implement direct selection; desktop/mobile typechecks and 12 shared tests pass.
- [x] Test canonical identities, vendor names, known metadata and offline fallback.
- [x] Implement metadata fetch/cache and automatic same-model suggestions with eligible accounts.

## Task 2: Group configuration and pure rules

Files: `config/routing_groups.rs`, `routing_profiles.rs`, `types.rs`; `core/routing_groups.rs`, new pure rule modules.

- [x] Extend defaulted schema and validate nesting/cycles/limits/patterns/rule shapes.
- [x] Expand nested/pattern groups with stable candidate paths and permission filtering.
- [x] Implement request fact/rule evaluation including time zones and pause behavior.
- [x] Cover legacy defaults, empty accounts, cycle rejection, matching and Key boundaries in focused tests.

## Task 3: Runtime strategies and execution

Files: `core/routing.rs`, new strategy/stat modules, `core/upstream/*` routing/forwarding pipeline.

- [x] Implement deterministic tested strategy order using real quota/usage/latency.
- [x] Add nested policy ordering, member weights, manual selection, true turn/strict affinity.
- [x] Integrate pure rules and bounded cached classifier calls; annotate decisions.
- [x] Apply effort/fast, pre-content timeout and bounded transient patience across protocols.
- [x] Verify failure boundaries and actual target selection with isolated fixtures.

## Task 4: Routing management UI and API

Files: `api/routing_groups.rs`, `routing_api.rs`, pipeline/catalog integration; routing React components/styles and browser tests.

- [x] Expose found groups, metadata, collection actions and preview facts with revision checks.
- [x] Build searchable provider/developer/model catalog, groups/cards and full editor controls.
- [x] Add patterns/nesting/rules/classifier, enabled/manual controls, copy/import/export/templates.
- [x] Preserve current replay/flow, dirty-draft handling, mobile layout and keyboard access.
- [x] Typecheck and verify desktop/mobile browser workflows.

## Task 5: Integration and delivery

- [x] Verify all model lookup surfaces use the same effective groups and unavailable-model filters.
- [x] Update translations and six installation guides for changed operations.
- [x] Build UI and Rust once changes settle; run relevant unit/HTTP/browser suites.
- [x] Review the whole diff against the design, fix material issues and rerun affected checks.
- [x] Restart local service on 3065 with existing data and verify health/login/assets.
- [x] Record evidence and a concise user report; leave the changes uncommitted for review.

## Decisions

- Existing installation auto-discovery defaults off to preserve previously requested manual publication; suggestions remain available without an outbound model appearing.
- New least-used ID avoids silently reinterpreting the old removed usage strategy.
- Reuse connected-provider permissions and protocol conversion, rather than importing Magpie's separate gateway stack.
- Ordinary global/model profiles exclude manual and weight because they have no member picker or weight settings. Routing groups retain both strategies.
- Portable exports omit entire directory-dependent rules; deleting just the directory condition would broaden their meaning.
- Old editors preserve omitted advanced fields; explicit empty/false/zero values remain valid resets.

## Verification ledger (complete)

- Final Rust suite: **387 passed, 0 failed**, including nested cursor/affinity, explicit Stop and classifier cancellation regressions. Evidence: `F:/tmp/agent2api-routing-rust-tests-final.log`.
- Final routing HTTP fixture: **18/18 passed**, including all four nested leaves, turn/strict affinity, Key boundaries, dynamic patterns, rules/classifier, first-content timeout, post-content no-switch and transient patience. Evidence: `C:/Users/shifuf/AppData/Local/Temp/agent2api-magpie-routing-u0o259`.
- Routing browser: **6/6 passed**, no page errors, final rebuilt desktop/mobile assets. Advanced member edits retain dynamic manual/rule targets; preview facts and simulated classification do not mutate saved settings. Evidence: `F:/tmp/agent2api-magpie-ui-final/2026-11-08T14-56-26-485Z/results.json`.
- Direct model browser: **8/8 passed**, `F:/tmp/agent2api-model-ui-final/2026-11-08T14-51-49-450Z/results.json`.
- Key browser: **6/6 passed**, `F:/tmp/agent2api-key-ui-final/run-bcY6iO/results.json`.
- Channel browser: **11/11 passed**, no browser/request/HTTP errors, `F:/tmp/agent2api-direct-channel-ui-fixed/2026-11-08T14-12-32-440Z/results.json`.
- Existing managed-channels, model-lifecycle and public-model-catalog HTTP regressions passed against the final backend binary.
- Shared model/catalog and routing tools unit tests: **14/14 passed**, including dynamic-choice cache invalidation and portable directory-rule omission.
- Desktop/mobile production builds and typechecks passed after the final dynamic-choice fix. Desktop dashboard/editor/preview and mobile editor screenshots were visually inspected; mobile overflow assertion passed.
- Five translation catalogs have zero missing keys; six installation guides document model selection and routing. Check log: `F:/tmp/agent2api-i18n-final-check.log`.
- Independent final re-review confirmed the nested cursor/affinity, adapter Stop and classifier cancellation fixes; no remaining Important findings within the reviewed scope. `git diff --check` passed.
- Local service restarted using `F:/Agent2API/target/debug/agent2api-server.exe` with existing `F:/Agent2API/data`; listener `127.0.0.1:3065`, PID 25440, managed PTY session 9224. `/health` reports `ok`; login and desktop/mobile assets return HTTP 200.
- Version remains **3.4.2**. No commit, push, tag or release was performed.
