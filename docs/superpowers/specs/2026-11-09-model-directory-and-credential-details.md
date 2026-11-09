# Restore upstream model management and account credential details

The user explicitly chose to restore the provider/upstream-model management page shown in their screenshot, including discovery, selection and testing. Public model IDs continue to be created and published by routing groups. Do not reinstate the independent public-model catalog or per-model routing workflow.

Restore desktop navigation and mobile model access using the existing model-directory UI where feasible. Model changes must apply to upstream selection and Key-group constraints; no raw source becomes public just because it was fetched or enabled. Existing account-page discovery remains available.

Account editing must let the administrator inspect stored credentials. Keep normal account/session responses redacted. Fetch details only after an explicit reveal action through an authenticated management endpoint, with no-store response headers. Support saved custom API Keys and credential fields on existing provider accounts. Keep the reveal separate from replacement inputs, allow copy/hide, clear values when hidden or the dialog closes, and never print real credentials during development or tests.

Ruling: preserve the existing beta working tree and version 3.4.2, with no commit/push/tag. The user authorized direct implementation and restoring the local service. Tests use disposable homes and fixture credentials only.
