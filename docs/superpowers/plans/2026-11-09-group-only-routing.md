# Group-only routing implementation plan

> Use subagent-driven-development for independent implementation tasks and a fresh final review. Preserve existing beta workspace and follow the user's direct-implementation preference.

**Goal:** One routing-group workflow for public IDs, upstream associations and chat/image routing.

**Architecture:** Migrate legacy configuration into routingProfiles.groups, retire the two former write surfaces, and use group projection for all public catalogs and forwarding. Desktop/mobile expose the same unified flow.

**Tech Stack:** Rust/Axum/SQLite, React/TypeScript/Vite, Node HTTP and Playwright regressions.

**Spec:** docs/superpowers/specs/2026-11-09-group-only-routing-design.md

## Constraints and ownership

- Preserve credentials, current public IDs and Key restrictions; no live data mutation during tests.
- Version 3.4.2; no push, tag or Release in this implementation task.
- Run on the current beta checkout with scoped file ownership; repository policy and existing direct-work preference override new-worktree prompts.
- Root owns migration, managed catalog retirement, HTTP routes, public-catalog adapter rewiring and integration tests/docs.
- Engine worker owns config/routing_groups.rs, core/routing_groups.rs, core/providers/images.rs, image API/forwarding and pipeline group-kind checks. Coordinates any additional shared edits first.
- UI worker owns desktop/mobile route UI and navigation, shared route types, translations and UI regression script. Root runs final artifact builds.

## Review focus

- Never widen Key or account scopes during migration or image fallback.
- Source names can equal group public IDs without recursive alias resolution.
- Disabled groups and accounts stay unavailable while their configuration remains editable.
- Case-preserving legacy public IDs and nested group type checks.
- One public catalog after restart, no implicit raw-model publication.

### Task 1: Group engine and image parity

- [x] Add focused failing regression for same-name public ID and image groups.
- [x] Add kind chat/image (default chat), validate homogeneous nested members, and permit raw source ID reuse.
- [x] Extend source choices and group projection to images; operation support checked per selected candidate and preserve candidate upstream ID.
- [x] Route image generations/edits through groups with Key checks and existing retries. Test cross-kind rejection and channel/account restrictions.

### Task 2: Unified frontend

- [x] Add failing browser assertions for removed Model Management and independent route creation.
- [x] Remove two menu/workflow surfaces, redirect old model navigation to routes, retain global protection and replay access.
- [x] Create and edit chat/image groups via provider-scoped candidates; only group public IDs reserve names.
- [x] Update mobile and translations; run typechecks and report browser verification requirements.

### Task 3: Legacy migration and single catalog

- [x] Add isolated legacy upgrade fixture and observe baseline failing.
- [x] Convert managed models plus profiles atomically with backup marker; retain disabled, unavailable, scoped and case-sensitive IDs. Profiles without published aliases become disabled drafts.
- [x] Retire old model/profile writes and make public catalog, Key choices, default-model resolution and classifier paths follow groups.
- [x] Verify migration restart idempotence, legacy caller IDs, current API key retention and raw-name collision.

### Task 4: Integration and review

- [x] Build final server and desktop/mobile artifacts; run focused HTTP/browser regressions and relevant existing routing cases.
- [x] Update migration guidance in six install documents and implementation ledger.
- [x] Fresh whole-change review, fix important findings, rerun affected checks.
- [x] Validate the updated service in isolated temporary homes. No production container or existing local data was changed; the user’s active deployment is on Docker.

## Ledger

- Initial state: beta e7e0afc9, working tree clean. Published image remains unchanged.
- User confirmed preserving both chat and image functionality.
- Pre-flight: root migration serializes kind for engine; UI uses optional kind default chat. Engine owns shared Rust group structures. Root public catalogs consume engine projections. No simultaneous edits to those files.

## Verification — November 9, 2026

- Server `cargo check --lib` and final `cargo rustc --bin agent2api-server`: passed (existing deprecation/dead-code warnings). Desktop and mobile TypeScript/builds and i18n build: passed. Translation check reports no missing keys; existing empty translations remain.
- Legacy upgrade HTTP regression: passed, including chat/image forwarding, exact public IDs and account scopes, unchanged gateway Keys, retired write endpoints, restart idempotence, source/public ID reuse, and atomic refusal of corrupt/conflicting legacy input. Latest artifacts: `C:/Users/shifuf/AppData/Local/Temp/agent2api-group-upgrade-rOwAQX`.
- Plugin migration now reads persisted catalogs before classifying unavailable sources and defers when an enabled installed plugin has not registered. Plugin bootstrap retries migration after loading catalogs.
- Engine HTTP regression: all 10 scenarios passed image generation/editing, selected accounts, provider/model Key permissions, operation capabilities, nested rotation, priority order, case preservation, opposite-kind and disabled-state rejection. Latest artifacts: `C:/Users/shifuf/AppData/Local/Temp/agent2api-group-engine-fGOFaY`.
- Final Key-choice regression reproduced the incorrect inclusion of an image group under a provider whose candidate supports neither generation nor editing. Filtering now checks each candidate; the new regression and managed-channel suite both passed after rebuilding the server. Independent review of the full change and this final correction found no blocking issues.
- Magpie HTTP regression: 22 passed. Added evidence that HTTP 200 without content stays on the first member when `firstToken=0`, while a deadline advances through two stalled members to a third successful member. The user’s Docker screenshot uses order/auto/firstToken=0/patience=0; explained changing first-content timeout to 20 seconds and optionally disabling stickiness. No server settings were changed.
- Managed channel HTTP regression and 18 Grok schema forwarding cases: passed. Group helper tests: 9 passed.
- Browser regressions: group workflow 6, Magpie workflow 8, channel integration 8, channel drawer 15, gateway Key 6 passed. Desktop/mobile screenshots inspected; no browser errors or horizontal mobile overflow. Old channel tests now exercise the replacement group workflow. Fixture startup waits for plugin readiness.
- Six installation documents describe group-only configuration, migration/rollback, and the difference between ordered fallback, rotation, first-content timeout and retry patience.
- Version stays 3.4.2. No commit, push, tag, release or Docker build/push in this change. Existing published images do not contain these uncommitted changes.

## Follow-up — account model discovery

- Restored upstream discovery on the account toolbar and each provider group. Built-in sources reuse the refresh dialog with an explicit provider scope and an enabled credentialed account selector; custom sources reuse the existing Key-group editor and require model selection before saving.
- Discovery no longer depends on the retired model-management page being mounted. The public-model workflow remains routing groups only.
- Added browser regressions for provider/account scope, remembered selection, custom Key-group confirmation and freshly fetched models in an already visited routing page. Observed the missing-button failure before implementation; all 9 combined routing/discovery scenarios then passed with no browser errors. Artifacts: `C:/Users/shifuf/AppData/Local/Temp/agent2api-group-only-ui/2026-11-09T10-37-56-255Z`.
- Desktop TypeScript/build and translation build/check passed (no missing translation keys). Local service at `127.0.0.1:3065` remains running and serves the current UI bundle, verified by SHA-256 comparison. No real upstream refresh or production configuration change was performed during verification.
- Independent read-only review of the restored discovery entry points found no blocking issues; provider scope, account eligibility and explicit custom Key-group selection were checked.
