# Model selection and channel panel verification

This correction supersedes the fullscreen channel drawer and unfiltered provider directory described in the preceding public-catalog report.

## Implemented behavior

- Channel creation remains centered. Viewing group Keys or fetching/selecting group models expands an adjacent panel inside the same dialog. Narrow layouts stack the panel below the form.
- Each credential has its own fetched candidates. Fetching does not select models automatically; confirmation applies the selection. Cancel, search, select all, clear, custom IDs and draft recovery work independently for each group.
- Stale fetches cannot replace another group, erase its tentative selections or reopen a dismissed panel. Endpoint, protocol and credential changes prevent applying an obsolete selection. Escape closes the panel first and returns focus to its trigger.
- PublicProviderConf normalization follows AxonHub's developer and family filters. Legacy caches are normalized on read. IDs retain exact case and slashes; each developer retains its own associations, while the combined UI shows one row per exact ID.
- Desktop and mobile model selectors combine the developer directory, available account upstreams and saved custom models. Selecting an upstream fills its ID for customization. Selecting an existing public ID opens that model for editing, including after filtering by source or manufacturer. Search covers all associated names and provider IDs.
- Upstream choices require an enabled channel and credentialed, enabled accounts with matching Key-group permissions. Gateway Key options show usable channels and published models. Hidden saved restrictions remain intact until explicitly removed.
- Five translation catalogs, six installation documents and generated desktop/mobile assets are updated.

## Verification

- Full Rust server suite: **320 passed, 0 failed**, with isolated data. Both server and test harness builds passed using the existing local Windows toolchain with direct LLVM lld linking. Six existing compiler warnings remain.
- Frontend Node tests: **16 passed, 0 failed**, including observed failures before the source/availability fixes and before the two review-driven picker fixes.
- Desktop and mobile TypeScript checks and production builds passed. Translation scan reports no missing keys. `git diff --check` passed.
- `test-managed-channels.mjs` passed against the rebuilt server: account/credential/group/channel availability, preserved unavailable restrictions, explicit publication, aliases, actual forwarding/scopes, disabled groups and models, stale edits and unavailable proxy rejection.
- `test-public-model-catalog.mjs --live` passed: legacy-cache developer normalization, failed-refresh fallback, unchanged successful disk cache, restart recovery, no automatic publication and real fixed-source download/cache reuse. The live sample returned **20 developers, 412 provider/model rows and 410 unique IDs**.
- `test-channel-ui.mjs`: **11/11 browser cases passed**. Covers directory deduplication, upstream-to-custom creation, existing custom editing, per-Key discovery, hidden disabled model restrictions, subscriptions and mobile saving.
- `test-channel-drawer.mjs`: **12/12 browser cases passed**. Covers centered layout, drafts, focus, explicit selection/cancellation, delayed responses, per-credential caches, failed refresh, endpoint changes, custom IDs, nested dialogs and narrow layout.
- Both browser reports have zero console errors, page errors, failed requests or HTTP errors. Desktop, mobile and channel-panel screenshots were inspected.
- Independent review identified picker association/search and panel race issues; all were corrected and reviewed again with no remaining blockers.

## Local integration

The local service is running from `F:/Agent2API/target/debug/agent2api-server.exe` at `http://127.0.0.1:3065`, serving the rebuilt UI and using the existing `F:/Agent2API/data`. The listener executable was verified; `/health` and `/login` both returned HTTP 200. Existing administrator credentials and user data were preserved.

The implementation stays on local `beta` at version 3.4.2. There is no remote push, tag or Release in this correction.

## Evidence

- Rust: `F:/tmp/agent2api-selection-rust-tests.log`
- Node: `F:/tmp/agent2api-selection-node-tests.log`
- HTTP: `F:/tmp/agent2api-selection-managed-http.log`, `F:/tmp/agent2api-selection-catalog-http.log`
- Model/Key browser report: `F:/tmp/agent2api-selection-ui-final/2026-11-07T17-50-32-595Z/results.json`
- Channel panel browser report: `F:/tmp/agent2api-channel-panel-verified/2026-11-07T17-50-35-615Z/results.json`
