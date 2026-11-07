# Channels and managed models implementation plan

> **For agentic workers:** Use the applicable execution skill and follow the tasks below. User explicitly authorized direct implementation.

**Goal:** Implement AxonHub-style channels and opt-in public models, restore proxy subscriptions, and prepare fork-owned Docker publication.

**Architecture:** Extend existing custom providers and encrypted accounts for channel Key groups. Use an explicit managedModels catalog for one-hop public-to-upstream associations; retain routing groups for complex routing. Preserve the Rust/React architecture and current proxy behavior.

**Tech Stack:** Rust/Axum/SQLite, React/TypeScript, GitHub Actions/Buildx.

**Spec:** ../specs/2026-11-07-channels-models-design.md

## Constraints

- Work in local beta from the current checkout. No push, tag, release, version bump or release notes.
- Read reference projects only; do not modify axonhub or dns-panel.
- Model discovery is a candidate list, never automatic publication.
- Preserve credential encryption and actual request permission enforcement.
- Independent domains may be delegated using dispatching-parallel-agents; coordinate shared registration files. Do not revert another worker's changes.
- Preserve existing account data, existing proxy support and current non-proxy changes.

## Review focus

- Same upstream model across channels must not bypass a gateway Key's channel restrictions.
- Aliases resolve to the selected upstream model before Key-group selection; unknown group model does not fall through to unrelated keys.
- Empty manual catalog must never fall back to auto-exposing all upstream models.
- Restored subscription code must retain current request handling and configuration encryption.
- Container builds must include fresh UI and must not self-update to upstream binaries.

## Task 1: Channels and grouped credentials

Files: core/custom_providers.rs, core/account_store/custom_accounts.rs, api/custom_providers.rs, new focused channel helper modules; ui-islands/src/islands/add-custom-provider.tsx and related channel editor components; account routing filter integration.

- [x] Write behavioral tests for Key-group validation, duplicate keys, explicit empty model sets, and disjoint model routing.
- [x] Add create/edit/probe channel APIs with validated grouped account writes and rollback on failure.
- [x] Add API-template channel editor with grouped keys, enabled state and per-group model selection.
- [x] Verify account credential filtering in the actual forwarding path; document integration interface for parent.

## Task 2: Restore proxy subscriptions

Files: api/subscriptions*, core/subscriptions.rs, core/sub_kernel/*, core/proxy_pool*, core/proxies.rs, proxy lifecycle/backup/route registration, desktop/mobile proxy pages.

- [x] Compare beta.5 to beta.6 removal and current code; restore narrowly with current contracts.
- [x] Restore management, parsing, kernel lifecycle and proxy references; preserve fail-closed proxy errors.
- [x] Restore desktop/mobile controls and remove retirement UI.
- [x] Verify subscription parsing, path handling, process cleanup and compilation.

## Task 3: Fork Docker workflow

Files: .github/workflows/docker.yml, Dockerfile, docker-compose.yml, docs/install{,.en,.zh-Hant,.ja,.ko,.pt-BR}.md.

- [x] Implement push main/beta and workflow_dispatch using this repository's GHCR namespace.
- [x] Include fresh React assets and lockfile-based builds; retain amd64/arm64 build support and caching.
- [x] Disable automatic upstream container replacement in the fork deployment default.
- [x] Update six installation documents and validate workflow/build configuration; no actual publish.

## Task 4: Manual public models and gateway Key selection

Files: core/managed_models.rs, api/managed_models.rs, core/routing_groups.rs, providers/catalog/*, core/key_scope.rs, model React components and gateway Key selection.

- [x] Introduce explicit managed catalog semantics, preserving source catalogs for selection.
- [x] Implement model add/edit/delete with direct channel/upstream associations, including image models and IDs equal to upstream IDs.
- [x] Enforce selected models across advertising and execution; test source-vs-public distinction and Key intersections.
- [x] Update model page and gateway Key selectors to the manual catalog.

## Task 5: Integration and verification

- [x] Integrate workers, review actual diffs, fix conflicts and failing behavioral tests.
- [x] Compile and test server, run UI typecheck/build, mobile build and i18n generation/check.
- [x] Review permissions, migration behavior, secrets, Docker data persistence and restoration scope.
- [x] Report changed behavior, verification evidence and any environment limitations.

## Execution record

- 2026-11-07: Read all three reference implementations; current checkout 3.4.2 at e8bed73, clean. User approved entire-gateway direct implementation. Created local beta from current main without changing remote refs. Rust and Docker are not currently found on PATH; verification tooling needs investigation.
- 2026-11-07: Integrated channel groups, proxy subscriptions and fork Docker workflow. Added the explicit managedModels catalog, optimistic revisions, desktop/mobile editors, scoped advertisement and forwarding. Preserved deleted-channel restrictions and source-test target authorization.
- 2026-11-07: Installed an isolated Rust validation toolchain under F:/tmp. GNU-linked full executables failed before application main; direct LLVM lld linking resolved the import relocation problem. No toolchain paths were added to product configuration.
- 2026-11-07: Desktop/mobile builds, ten Node behavioral tests, five-language dictionary checks and actionlint passed. Browser smoke passed eight scenarios. Official Mihomo v1.19.32 passed local HTTP subscription, proxy forwarding and reference lifecycle tests after archive/binary SHA256 verification.
- 2026-11-07: Final Rust suite passed all 307 tests after repairing obsolete fixture contracts and an existing clock-boundary race in the gate-expiry test. Final-server HTTP, all eight browser scenarios and real Mihomo subscription forwarding passed. All six installation guides include the manual model migration and restored proxy/mobile capabilities. Docker engine/build/publication remains untested locally; see 2026-11-07-integration-report.md for evidence and boundaries.
