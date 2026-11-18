# Subscription proxy groups implementation plan

> **For agentic workers:** Use executing-plans in this session. Preserve the existing uncommitted chain fix.

**Goal:** Clash Verge style subscription groups, persistent selection, group routing, bounded tests.
**Architecture:** Runtime catalog maps original names to isolated aliases. A serialized control API owns selection and testing. Shared React group cards serve desktop and mobile through injected API adapters.
**Tech Stack:** Rust, Tokio, reqwest, Mihomo REST, React, TypeScript.
**Spec:** ../specs/2026-11-16-subscription-proxy-groups-design.md

## Global constraints

- Keep beta checkout and current local data; no version change or push in this implementation.
- Default collapsed, paginated members, visible-page-only refresh.
- Download test: one concurrent task, 5 seconds / 5 MiB, streaming counter, explicit cancellation.
- Keep fixed node references, introduce group targets without renaming existing nodes.
- Never return proxy credentials, subscription URLs or controller secrets.

## Review focus

- Duplicate group names in different subscriptions remain isolated (runtime/integration tests).
- Restart/refresh cannot race selection or testing (control lock and HTTP test).
- Removed selected members visibly invalidate selection (catalog state and test).
- Tests never change business selections; cancellation releases capacity (two-hop HTTP test).
- Hidden/unmounted views ignore stale responses and stop scheduling work (browser tests).

## Task 1: Group catalog and routing

Files: sub_kernel/dependencies.rs, runtime.rs, new runtime_groups.rs; scripts/test-proxy-subscriptions.mjs.
Interface: runtime::groups::{list, select, test, cancel}; input {providerId,group,node?,kind?,url?}; safe JSON catalog and test result.
- [ ] Add HTTP regression asserting groups endpoint, switching front/exit, account group routing and restart persistence; run old server to see failure.
- [ ] Import valid explicit groups, include groups in pool targets/listeners/test group, preserve deterministic aliases.
- [ ] Serialize worker mutations with group operations; persist choices separately and restore before listeners start.
- [ ] Expose authenticated subscriptions/groups GET and selection POST; validate membership and selector type.
- [ ] Run Rust tests and local two-hop integration suite.

## Task 2: Bounded testing

Files: runtime_groups.rs and subscriptions.rs; HTTP integration script.
- [ ] Assert delay, speed, exit test shapes, cancellation and unchanged business selections.
- [ ] Delay via controller per-node API; speed/exit via existing dedicated test listener under lock; reject busy immediately, no unbounded queue.
- [ ] Stream at most 5 MiB / 5 seconds, cancel using task ID, configurable http(s) target, redact failures.
- [ ] Return timestamp and chain identity so UI can invalidate old results after selection changes.

## Task 3: Shared group UI

Files: new ui-shared/proxy-groups.tsx; desktop proxies-page.tsx; mobile ProxiesPage.tsx; bridge adapters.
- [ ] Add browser acceptance for collapsed cards, lazy members, search, selection, test results and cancellation.
- [ ] Shared cards: original labels/order, selected member, counts, chain, paginated member grid and search/sort; action labels accessible.
- [ ] Show delay/speed/exit separately, mark stale measurements, group delay batch with bounded sequential scheduling.
- [ ] Add group target guidance and preserve existing pool management.
- [ ] Typecheck both clients and build desktop/mobile/full translations/SW artifacts.

## Task 4: Acceptance and local service

- [ ] Run full Rust suite, subscription HTTP suite and browser checks; inspect visual layout.
- [ ] Review final changes; document remaining supported-format constraints.
- [ ] Restart local service on 3065 with existing data, validate live group catalog and kernel.

## Execution ledger

2026-11-16: initial HTTP red observed GET /api/subscriptions/groups => 404. First backend revision passed all 417 Rust tests. Desktop/mobile typechecks and builds passed; final revisions rebuilding. New routes, shared UI and HTTP/browser acceptance scripts implemented, not yet accepted. Running build logs: .verify/performance-audit/groups-server-build.log, rust-test-build.log, groups-frontend-final.log.

23:09: second Rust suite 417/417 passed (groups-rust-final.log). HTTP acceptance found main http.rs fixed-route registration missing; added five group routes. Rebuilding server via groups-server-build.ps1 (PID 31668). Actual custom output filename is .verify/local-runtime/groups-server-2ec10e4857db4ae2.exe. Latest frontend build groups-frontend-release.log succeeded including translations; no further UI edits pending. Local 3065 service remains old working process 27920 at target/debug/agent2api-server.exe. Do not stop until new HTTP/browser checks pass.

Ruling: explicit invalid unrelated groups remain visible as unavailable while required dialer dependencies fail closed — preserves usable existing subscriptions without activating unsupported routes.
Ruling: persist selections in a separate atomically replaced file and reorder selected members before kernel startup — avoids any direct-routing window and does not rewrite original subscription caches.
Ruling: group targets reuse subscription pool identity (providerId + original name); node/group collisions are rejected — existing fixed-node references remain stable.
Ruling: keep build output for new server under .verify/local-runtime/groups-server*.exe to avoid stopping the user's current 3065 service until validation passes.

Ruling: continue in existing beta checkout — the approved task extends the uncommitted tested chain fix and local runtime; no branch/publish change needed.
Ruling: execute inline — user authorized continuing implementation; dispatch tool has repeatedly dropped task messages, so independent review availability must be reported honestly.
Preflight: task 1 catalog supplies task 3 cards; task 2 results use the same provider/group/node identity and task IDs. Shared API adapters use authenticated existing bridges, never direct controller credentials.
