# Task 2 — Restore proxy subscriptions

Restored the proxy subscription implementation from `v3.3.0-beta.5` onto the current `3.4.2` checkout. The beta.5 and beta.5.1 proxy files were identical. No version, tag, release, or remote ref was changed.

## Restored functionality

- Subscription CRUD for HTTP/HTTPS URLs and local Clash YAML files, QR image decoding, enabled/disabled state, refresh, node counts, and orphan cleanup.
- Mihomo download/import with pinned platform checksums, versioned installation, start/stop/restart/remove, status and progress, loopback controller, process cleanup, and headless/desktop shutdown hooks.
- Proxy-pool subscription nodes, lazy dedicated listeners for account/service references, shared serialized test listener, enable/disable reconciliation, stable node identities, and original account/gateway proxy selection.
- Desktop subscription management, kernel dialogs and import; mobile kernel import, download and start/stop while retaining current manual proxy CRUD/search/filter/settings and server-identity guards. Removed obsolete retirement UI.
- Bootstrap, account create/update/batch/delete, update-route selection and backup-restore lifecycle integration. Standard-account normalization can temporarily use the protected shared test listener before the account's dedicated listener exists.
- Restored proxy vocabulary in five locale sources; final i18n generation and generated UI bundles are owned by the root integration task.

## Current behavior retained / compatibility fixes

- Unsupported proxy sources fail explicitly and do not become manual/direct routes; legacy manual/custom sources remain supported. Current `sourceEnabled`, IPv6 address formatting and lazy page mount are retained.
- Strict proxy settings object/string/HTTP URL validation retained. Listener range endpoints are validated together so the range can move above/below its old values in one save.
- Subscription URL validation rejects missing hosts, whitespace and overlong values instead of truncating them; local YAML requires nonempty, unique node names.
- Kernel uninstall removes only known installation files, preserving unrelated files in user-selected directories and subscription runtime state. Cleanup checks resolved paths remain below the selected kernel root.
- Bootstrap autostart runs after the account store is installed. Backup restore stops the old process before reloading configuration and preserves the manual-stop decision.

## Verification

- PASS: `node --experimental-strip-types --test desktop-tauri/ui-shared/proxy-usage.test.mjs` — 2/2 behavioral tests. The kernel service usage label test was observed failing before restoration and passing afterward.
- PASS: `npm --prefix desktop-tauri/ui-islands run typecheck`.
- PASS: `npm ci --prefix desktop-tauri/mobile --no-audit --no-fund` and `npm --prefix desktop-tauri/mobile run typecheck` (including the root task's managed-model UI).
- PASS: `git diff --check` at preparation time.
- Added fourteen Rust tests covering subscription URL/YAML validation, supported sources, disabled/invalid subscription ports, settings validation and range movement, safe uninstall, and generated kernel listener configuration. The root/toolchain task owns cargo check/test and Cargo.lock. The test binary compiled, but Windows runtime initialization exited with `0xc0000005` before running tests; the toolchain worker is investigating linker/import relocation. Do not treat these Rust tests as executed until the integration result is recorded.
- A real Mihomo binary and a live upstream subscription have not been used for end-to-end traffic validation in this task.

## Maintenance entry points

- `desktop-tauri/src-tauri/server/src/server/core/subscriptions.rs`: storage and import validation.
- `desktop-tauri/src-tauri/server/src/server/core/sub_kernel/`: lifecycle/config generation, download/import, installation and archive handling.
- `sub_kernel/mod.rs` pins Mihomo `v1.19.32`; update `assets.rs` platform archive and binary SHA256 values together when changing the pin.
- `desktop-tauri/src-tauri/server/src/server/api/subscriptions.rs`: management contract.
- `desktop-tauri/ui-islands/src/islands/proxies-sub-*` and `proxies-kernel-*`: desktop controls.

## Independent review follow-up

The channel worker reviewed the restoration and identified three beta.5 defects, now fixed:

- Pausing/re-enabling a subscription keeps its pool IDs and account/service references. Temporarily missing nodes are disabled and lose stale ports; explicit subscription deletion removes mirrors. Resume allocation accepts the stale disabled mirror immediately, while regular reconciliation skips missing nodes to avoid repeated restarts.
- Runtime compares the complete provider node catalog and definitions, rather than only allocated listeners. A second configuration pass stops its current child before allocating again, allowing registered ports to be reused.
- Manual refresh snapshots before the controller request and rebuilds inline proxy definitions even when names remain unchanged but server/password parameters changed.

Five additional Rust behavioral tests cover pause/resume identity, stale-port removal, first-pass resume listener allocation, full-catalog comparisons and same-name parameter changes (fourteen proxy/subscription tests total). Rust execution remains owned by the integration/toolchain task.
