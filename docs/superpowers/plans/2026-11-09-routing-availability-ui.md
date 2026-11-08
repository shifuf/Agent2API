# Routing availability and UI implementation plan

**Goal:** Offer only configured models backed by enabled, credentialed accounts in new routing configuration; refresh the routing workspace to match the local Magpie reference, and document a data-preserving Docker migration.

**Architecture:** Filter routing catalog choices at the server using existing provider/account/Key-group predicates. The shared desktop/mobile picker groups these choices by account provider and retains selected and saved members. Keep manual public model publication unchanged.

**Scope:** User requested direct implementation. Preserve built-in providers, existing route configuration and user data. No version changes, commits, pushes, tags or deployment.

- [x] Reproduce account-free catalogs in isolated HTTP regression. Cover missing credentials, disabled accounts/providers/Key groups, empty catalogs, per-model account counts, saved unavailable routes and public aliases.
- [x] Filter server choices with available accounts per model; preserve saved members and public model overrides.
- [x] Refresh main routing dashboard and create dialog using Magpie styling, colored brand icons, provider dropdown and model search. Preserve advanced controls and mobile layout.
- [x] Verify new picker behavior and existing routing operations through browser and HTTP tests; build desktop/mobile/server and sync translations.
- [x] Audit local and remote Docker workflow status; document full-directory backup, explicit fork image replacement, self-update disablement and restoration of the old container plus old data in six installation guides.
- [x] Restart the local service with existing data after checks and record verification results.

## Review focus

- Accounts without credentials must not populate selectable catalogs.
- A Key group permits only its own selected models; counts must be per model.
- Disabled or removed accounts hide new choices without deleting saved configuration.
- Public custom aliases remain selectable even when their ID differs from the upstream model.
- Docker rollback needs the pre-upgrade database and encryption keys, including when the old container has self-updated.

## Deployment facts

The user's server uses `docker run`, container `agent2api`, image `aimodcc/agent2api:latest`, port `3065:3065`, and host `/www/server/panel/data` mounted at `/data`. The old container enables self-update. The fork workflow is committed locally but absent from the inspected remote main commit; no remote beta branch was found. Publishing remains a separate authorized action.

The migration guide uses a separate data copy under `/opt/agent2api/migrations/<timestamp>/data`. The original host directory is never moved, cleared or upgraded by the new image, so rollback can restart the preserved old container with its unchanged database and keys.

## Verification ledger

- Old binary reproduced invalid provider choices in HTTP and browser fixtures. The account-aware catalog fix passed the complete 20-scenario routing HTTP regression, including per-Key counts, saved unavailable members, public alias provider membership and forwarding policies. Final evidence: `C:/Users/shifuf/AppData/Local/Temp/agent2api-magpie-routing-TtL25J/results.json`.
- Independent review found alias sources inferred from raw IDs and stale overview catalog refresh. Both were reproduced and fixed. Workspace now provides `modelsByProvider` from actual enabled bindings; creation uses the freshest workspace for source membership, reserved IDs and accounts. Overview/page refresh preserves drafts and updates catalog revisions.
- Final routing browser: 9/9 passed, zero page errors. Provider switching, selection retention, disabled-provider refresh, public aliases under their bound provider, discovery, advanced settings, preview, templates and mobile were verified. Screenshots inspected at desktop and 390px mobile. Evidence: `F:/tmp/agent2api-routing-ui-final/2026-11-08T17-33-36-007Z/results.json`.
- Model editor regression after extracting shared brand styles: 9/9 passed, including mobile and unavailable saved associations. Used the previous unchanged model backend and rebuilt UI. Evidence: `F:/tmp/agent2api-model-ui-routing-style-check/2026-11-08T17-26-37-883Z/results.json`.
- Managed-channel lifecycle HTTP regression passed against the final server; routing/catalog unit tests: 14 passed, 0 failed.
- Final server build succeeded with the existing local LLVM linker workaround. Desktop/mobile production builds and TypeScript checks passed. Five translation catalogs have zero missing keys; existing empty translations remain unchanged. `git diff --check` passed.
- Six install guides contain matching migration/rollback commands. Their 18 Bash blocks passed syntax validation; no Docker image was built locally, no image published, and no remote migration executed.
- Local service restarted with existing `F:/Agent2API/data`, binary `.verify/local-runtime/routing-available.exe`, PID 29288, managed PTY session 93614. Health, login, desktop and mobile JS/CSS all returned 200 at `127.0.0.1:3065`.
- Version remains 3.4.2 on beta. No commit, push, tag or release.
