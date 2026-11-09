# Model directory and credential details implementation plan

> Use scoped parallel implementation for the independent UI restoration and credential flow; root integrates and verifies.

**Goal:** Restore upstream model management and allow account credential inspection without reviving duplicate public IDs.

**Architecture:** Reuse the source-directory UI, keeping routing groups as the only public catalog. Add a dedicated authenticated credential detail read and a reveal-only account editor section.

**Tech Stack:** Rust/Axum, React/TypeScript, Node HTTP and Playwright tests.

**Spec:** `docs/superpowers/specs/2026-11-09-model-directory-and-credential-details.md`.

## Constraints and ownership

- Existing beta checkout, version 3.4.2; no commit, push, tag or publishing.
- UI worker owns model pages, navigation and source-specific endpoints if required; no account settings or credential files.
- Root owns account credential backend/UI, translations, final builds, integration tests and local service restart.
- Coordinate shared test-file edits. Use isolated test data; never log live credentials.

## Review focus

- The model page cannot revive independent public IDs or bypass routing-group publication.
- Fetching and selecting models preserve per-Key group scope and disabled sources.
- Credential details require management auth; ordinary gateway Keys and anonymous requests are rejected.
- Revealed values never enter replacement fields, persistent browser storage, logs or ordinary account snapshots.
- Missing accounts, no-auth sources, absent credentials, failures and late reveal responses have clear behavior.

## Task 1: Restore upstream model page

- [x] Add/update a browser regression that fails on the missing model page.
- [x] Restore model navigation and provider directory, discovery, upstream selection and model testing.
- [x] Hide or replace obsolete public-alias controls with routing-group navigation.
- [x] Verify source changes do not implicitly publish public IDs, and preserve Key-group restrictions.

## Task 2: Credential inspection

- [x] Add failing HTTP tests for explicit credential reads, auth rejection and normal snapshot redaction.
- [x] Implement a dedicated no-store credential read for a single existing account.
- [x] Add reveal/copy/hide details to account editing without changing replacement behavior.
- [x] Verify browser reveal/hide/reopen, cancellation and failure behavior using fixture credentials.

## Task 3: Integrate and run locally

- [x] Review both changes, run affected tests and build frontend/server artifacts.
- [x] Synchronize translations and relevant installation documentation.
- [x] Restart the local service, verify health and current assets, and report the available flows.

## Ledger

- User clarified that only upstream model management returns; routing groups still own public IDs.
- Existing working tree includes prior unified routing and restored account discovery changes. Preserve them.

## Completion evidence — 2026-11-09

- Server test suite: 398 passed, 0 failed (`.verify/model-directory-rust-tests.log`). Desktop, mobile and server builds completed; translation checking reported no missing keys.
- Credential HTTP/browser regression: `node scripts/test-account-credentials.mjs --balance` passed, including management-session authorization, gateway-Key rejection, explicit reveal/copy/hide, cancellation, nested balance credentials and clearing stale details. Fixture artifacts: `C:/Users/shifuf/AppData/Local/Temp/agent2api-credentials-NsX0Zd`.
- Model/routing browser regression: all 9 steps passed with no runtime errors. Evidence: `C:/Users/shifuf/AppData/Local/Temp/agent2api-group-only-ui/2026-11-09T12-23-29-142Z/results.json`. Covers scoped-Key testing, custom-source re-enabling, legacy alias conflicts, Key-group preservation and mobile layout.
- Routing engine regression: 11 checks passed. Upgrade/migration regression passed. Routing/Key Node tests: 18 passed.
- Independent reviews completed with no remaining blocking findings. Desktop retains model testing/capability editing; mobile supports source discovery, selection and enablement.
- Local service restarted at `http://127.0.0.1:3065`, PID 19492. Health and homepage returned 200; served desktop/mobile bundles matched the final files by SHA256. Health and listener rechecked at handoff.
- Changes remain local and uncommitted; no push, version change or Docker release was performed.
