# Model selection correction implementation plan

> User authorized direct implementation. Apply dispatching-parallel-agents to independent backend/catalog/channel work; root owns shared model and Key UI, translations and integration.

**Goal:** Match AxonHub's contextual side panels and useful, deduplicated model choices.
**Architecture:** Centered channel dialogs with contextual side panels; developer-filtered public directory; account-aware backend choices and merged frontend candidates.
**Tech Stack:** Rust/Axum, React/TypeScript, Base UI.
**Spec:** ../specs/2026-11-08-model-selection-correction-design.md

## Constraints and review focus

- Preserve local beta and version 3.4.2; no push/tag/release or user-data reset.
- Do not lose hidden saved Key restrictions or silently widen permissions.
- Key discovery results stay scoped to the chosen credential; opening/canceling a panel does not select all fetched models.
- Preserve case and slashes in actual IDs; deduplicate reseller entries without dropping custom upstream models.
- Test disabled/missing accounts, disabled channels/groups/public models, nested modal focus, cancellation, refresh failures and narrow/mobile layouts.

## Tasks

- [x] Availability: adjust core/managed_models.rs choices and api/keys_api.rs providers, add integration assertions for account/group/channel availability and preserved Key restrictions in scripts/test-managed-channels.mjs. Observe assertions failing on the previous binary, then pass on final binary.
- [x] Developer catalog: port the relevant AxonHub catalog_filter.go behavior into the Rust public catalog normalization, test developer filtering, reseller deduplication, fallback families and cache compatibility. Keep fixed-source downloading and failure fallback.
- [x] Channel panels: restore centered form in add-account-modal.tsx and channel-key-groups.tsx, replace channel-drawer shell with contextual panel support; show per-group Key inspection and model search/selection/confirmation. Update scripts/test-channel-drawer.mjs for actual layout and state behavior; observe old layout fail, then pass rebuilt UI.
- [x] Model/Key UI: shared selector combines deduplicated developer, available upstream and existing custom candidates; desktop/mobile editor integration. Key candidates hide unavailable items while separate retained restrictions preserve their values. Add Node tests and browser coverage, observe failures before implementation.
- [x] Integration: translations, six install documents, desktop/mobile build, Node/Rust/HTTP/browser verification, independent review, restart existing service, local commit and report.
