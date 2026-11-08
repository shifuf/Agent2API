# Model editor UI implementation plan

> **For agentic workers:** Use the executing-plans workflow to implement the task inline. The user has authorized direct implementation in the current workspace.

**Goal:** Simplify the model editor using Magpie's compact styling and colored brand icons, and select association models by account provider.

**Architecture:** Update the shared React editor and association dialog consumed by desktop and mobile. Reuse local provider assets and Base UI controls; keep the existing model payload and hidden metadata intact.

**Tech Stack:** React, TypeScript, shared UI kit, CSS, Playwright.

**Spec:** User's November 9 clarification: remove the entire model card and display name/icon/family/type inputs. Keep developer, model ID and remark; select account provider before its upstream model.

## Global constraints

- Preserve current uncommitted routing work, version 3.4.2, user data and credentials.
- Reference F:/magpie-main/magpie-main read-only; reuse existing local brand assets.
- No commits, pushes, release actions or backend changes required.
- Unknown brands get a colored fallback; mobile layouts must not overflow.

## Review focus

- Existing hidden metadata and unavailable associations survive edits.
- Only providers with accounts appear; switching providers preserves selections.
- Direct manufacturer-to-model selection and custom model IDs continue to work.
- Long provider/model names fit the mobile dialog and its menus.
- Local brand asset URLs resolve on desktop and mobile.

## Task 1: Shared editor and association UI

**Files:** models-editor.tsx, models-id-picker.tsx, models-association.tsx, models-workspace.tsx, models-workspace.css and new model-brand.tsx in desktop-tauri/ui-shared; scripts/test-model-workspace-ui.mjs; model translations and installation guide translations as needed.

- [x] Update the existing browser regression to assert removed fields/card, preserved metadata, provider-scoped association selection and mobile behavior. Observe an expected failure before editing product code.
- [x] Build a local colored brand component; render icons in manufacturer/model menus and model rows. Simplify the editor to a compact single column.
- [x] Add a provider dropdown filtered by accountCount, scoped upstream options and removable selected associations that persist across provider changes.
- [x] Sync user-facing translations and any affected interaction instructions.
- [x] Build desktop/mobile; run relevant shared unit tests and the full existing model workspace browser regression. Inspect desktop/mobile screenshots and confirm the local service serves the new assets.
- [x] Review the scoped diff and record validation below.

## Validation

- Desktop and mobile production builds passed (TypeScript plus Vite).
- Shared unit suite: 12/12 passed; existing Node MODULE_TYPELESS_PACKAGE_JSON advisory remains.
- Model workspace browser regression: 9/9 passed, no unexpected browser errors. Evidence: F:/tmp/agent2api-model-ui-refresh/2026-11-08T16-34-05-369Z/results.json
- Desktop/mobile screenshots inspected, including colored brand menus, compact editor, provider-scoped selections, and long upstream names wrapping inside the list.
- Translation check passed with no missing keys. All five target dictionaries and six installation-guide variants updated.
- Local service health returned 200; served desktop/mobile JS and CSS hashes match the freshly built files.
- Scoped code review found long upstream display-name overflow and two regional asset lookup misses; both fixed and covered by browser assertions. Reviewer reproduced overflow with actual CSS before the fix; regional icon assertion was observed failing before the fix.
- Review scope excludes prior routing/backend work. No migration, version change, commit, push, or service restart required.
