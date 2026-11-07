# AxonHub management workflow implementation plan

User approved direct implementation and clarified that advanced routing/Key profiles/quotas/IP controls are outside this request. Use parallel independent channel, Key and model-backend tasks; root owns shared model UI, translations and integration.

## Shared contracts

- Keep model identity `id`, `name`, `enabled`, `bindings: {provider, model}[]`. Add optional `developer`, `type`, `icon`, `group`, `remark`, `modelCard`, `archived`, `createdAt`, `updatedAt`; missing fields preserve legacy behavior. Empty bindings are valid and never routable.
- `POST /api/models/catalog` keeps `{previousId,model,revision}`. Add atomic `{action,ids?,models?,revision}`, where action is `create`, `enable`, `disable`, `archive`, `restore` or `delete`; return the same catalog payload. Catalog model metadata is descriptive and does not override upstream runtime capabilities.
- Keep `/api/keys` storage/permission contracts and usable-choice filtering. UI-only selection changes must not broaden saved allowlists.
- Existing built-in provider registry and login bridge contracts remain intact. Custom creation with empty group models succeeds and remains non-routable.

## Review focus

- Legacy models and Key restrictions survive edits, refreshes and absent candidates.
- Standalone model creation, empty-model channel creation and built-in provider login work with no existing accounts.
- Batch duplicates/conflicts fail atomically; stale revision cannot overwrite concurrent changes.
- Catalog autofill does not silently change saved associations or publish candidates; current custom models open for editing.
- Panel selection drafts, endpoint/key changes, delayed requests, Escape/focus and mobile overflow retain the preceding regression protections.

## Tasks

- [x] Model backend: extend `server/core/managed_models.rs`, `server/api/managed_models.rs` and `core/public_model_catalog.rs`. Add tests for metadata round-trip, legacy defaults, empty bindings, archive availability and atomic batches. Observe new assertions fail, implement, then run focused tests. Root coordinates the single final Cargo build.
- [x] Custom channels: update `accounts-page.tsx`, account bridge/types, `add-account-modal.tsx`, `add-custom-provider.tsx`, `channel-key-groups.tsx` and channel layout. Add provider selection, separate Key/model sections and group discovery overview while preserving built-ins. Update channel browser tests including no-model creation and late responses; do not edit translations/generated assets.
- [x] Gateway Keys: update `keys-page.tsx` and focused components/tests to align the list and create/view/model-channel selection workflow. Preserve existing APIs, administrator behavior and hidden restrictions. Add interaction coverage for selection and credential viewing; do not introduce advanced controls or modify model/channel files.
- [x] Shared model UI: extend `ui-shared/managed-models.ts` and catalog helpers; create shared model workspace/editor/association components; use them from desktop and mobile pages. Add developer grouping, metadata autofill, standalone and batch creation, independent associations and lifecycle actions. Verify helpers before compiling and browser-test the final flow.
- [x] Integration: synchronize five translations and six install documents, build UI/i18n/mobile, run Rust/Node/HTTP/browser tests and independent review, restart local service preserving data, inspect the final diff and make a local commit.


## Verification — 2026-11-08

- Desktop and mobile TypeScript/build checks passed; i18n build and scan check passed. All 97 added source strings have five translations (485 total), with matching placeholders and all pre-existing translations preserved.
- Server binary and test harness built offline with the local LLVM linker; six pre-existing warnings remain. Full Rust harness: 328 passed, 0 failed. Shared/island Node tests: 20 passed, 0 failed.
- HTTP integration: managed channels, new model lifecycle/atomic batches/metadata, and public catalog/cache tests passed. Live fixed-source catalog: 20 developers, 412 rows, 410 distinct IDs.
- Browser checks: model workspace 8/8, channel dialogs 15/15, original channel/model/proxy/mobile integration 11/11, Key selection 6/6. No unexpected console, page, request or HTTP errors. The model conflict test intentionally receives one HTTP 400, then refreshes without losing the draft and saves successfully.
- Independent review found four issues, all repaired and rechecked: batch manufacturer filtering after deduplication, selecting the current model overwriting metadata, comma-separated modality input, and revision conflict recovery preserving drafts.
- Browser tests also caught redundant accessible names in labeled checkboxes; source labels were fixed. Test waits now follow asynchronous server-backed switch changes and channel loading instead of reading before results arrive.
- Desktop and mobile screenshots inspected. Final service runs target/debug/agent2api-server.exe at http://127.0.0.1:3065 with the existing data directory; /health and /login return HTTP 200. Version stays 3.4.2. This is a local implementation commit, with no release or remote push.
