# Public model catalog and channel drawer implementation plan

> Use dispatching-parallel-agents for the disjoint Rust catalog and channel sheet work; root owns the shared model picker, translations and integration. User authorized direct execution.

**Goal:** Select public model IDs by manufacturer from PublicProviderConf and add channels in a left drawer.
**Architecture:** Fixed-source Rust catalog API with bounded fetch and cached fallback; shared React model picker used by desktop/mobile; existing channel form presented in a left sheet.
**Tech Stack:** Rust/Axum/reqwest, React/TypeScript, Base UI.
**Spec:** ../specs/2026-11-07-public-catalog-design.md

## Constraints and review focus

- No version change or remote push. Preserve saved channels, Keys, model bindings and local user data.
- Directory choices never automatically publish or grant access. Public IDs remain exactly those selected, including slashes/case; incompatible or unavailable upstreams are not selected silently.
- Test malformed/oversized catalog data, duplicate IDs, network failure after a success and concurrent refresh. Preserve cached candidates and current draft on failure.
- Test manufacturer changes, search, selection filling ID/name, custom ID editing, and mobile layout.
- Test left drawer positioning, close/reopen draft behavior, creation with groups, and existing provider flows.

## Tasks

- [x] Rust catalog: create core/public_model_catalog.rs and API routes GET/POST /api/models/public-catalog. Response: {providers:[{id,name,models:[{id,name,kind}]}], sourceUrl, fetchedAt, updatedAt, stale, error?}. Write parser/cache behavior tests first; preserve stale disk/memory data on fetch failure, deny malformed empty replacement. Parent runs Cargo.
- [x] Model picker: shared public-model-catalog.ts / public-model-picker.tsx and behavior tests, integrate into desktop/mobile model editors; preload on model-page mount and refresh explicitly. Select candidate fills ID/name only. Keep channel binding and custom editing unchanged.
- [x] Channel drawer: update add-account-modal.tsx and channel-key-groups.tsx only as needed; left sheet for channel creation/editing, clear title/sections, existing per-Key discovery. Verify through browser.
- [x] Integration: rebuild desktop/mobile/i18n, run Rust/Node/HTTP/browser tests, review changes, restart local service with existing data, commit locally and report results.

## Execution record

- Started from clean beta at 0cbf6c68. Existing service runs in terminal session 51168 on 127.0.0.1:3065. PublicProviderConf payload downloaded to F:/tmp/agent2api-public-provider-all.json for schema inspection; references in F:/axonhub remain read-only.
- Completed November 8: 318 Rust tests, 12 Node tests, 9 model/channel browser cases and 6 drawer cases passed. Actual HTTP cache/failure/restart acceptance and live catalog download passed, as did the channel forwarding/permission regression. The rebuilt service is running on 127.0.0.1:3065 using the existing data directory. Full evidence: [verification report](2026-11-08-public-catalog-report.md).
