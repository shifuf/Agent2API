# Task 1: Channels and grouped credentials

Implemented in the shared local beta checkout. No push, tag, release or version change.

## Behavior

- API-template channel creation now supports multiple named Key groups, multiple keys per group, a group enable switch, model discovery using a selected key, explicit model checkboxes and manual model IDs.
- Adding credentials to an existing channel uses the same group editor. Account settings and the existing-channel form expose a group management dialog; saved keys can move between groups using account IDs without revealing their values.
- Every upstream key remains an ordinary encrypted account row. Group edits preserve retained account IDs, proxy settings, cooldowns, priority and individual enable state.
- New grouped credentials only allow explicitly selected upstream models. Empty model lists and disabled groups deny all models. Existing accounts without group metadata, including legacy no-auth accounts, remain compatible.
- Model discovery is a temporary candidate list. Channel model metadata is updated only when the user saves the selected groups. The parent task must apply the separate public-model allowlist over these source models.
- Group replacements use one SQLite transaction. Invalid references, duplicate cross-group credentials and unreadable account rows abort before account mutation. Failed account saves attempt to restore the previous channel configuration without overwriting a later configuration edit.
- Public account/group responses only contain group policy, account IDs and existing key tails. New credentials never enter the custom-provider configuration or public group metadata.

## Integration contract

- `POST /api/custom-providers`: optional `keyGroups` array creates all keys with the channel.
- `POST /api/custom-providers/update`: optional `keyGroups` replaces the complete set of channel groups. Each group accepts `{id,name,enabled,apiKeys,accountIds,models}`. `accountIds` retain saved rows; `apiKeys` add keys. Omitted rows are removed only after all input validates.
- `GET /api/custom-providers`: each provider includes masked `keyGroups`. Returned groups contain `accountIds` and `keys: [{accountId,name,tail}]`, never raw keys.
- `POST /api/custom-providers/fetch-models`: existing `{providerId}` remains available; draft probing accepts `{protocol,baseUrl,apiKey}` and saved-key probing accepts `{providerId,accountId}` with optional endpoint/protocol fields.
- Routing policy is in `account_store::custom_accounts::key_groups::allows_request(account, requested, selected_upstream)`.
- `upstream/rotate.rs::scoped_accounts` filters the pool before any fallback selection. `providers/custom/forward.rs` checks again before obtaining/sending the credential.
- Important existing convention: `forward`'s `route_model` is the client/public name. For routing-group requests, `body.model` and the candidate's `routingModel` already name the upstream model and must not pass through alias mapping again. Ordinary requests still use `wire_model_for`.

## Verification

Executed successfully after the final frontend change:

- `npm.cmd run typecheck --prefix desktop-tauri/ui-islands` (exit 0).
- From `desktop-tauri/ui-islands`, `node node_modules/vite/bin/vite.js build --outDir F:/tmp/agent2api-channel-build` (exit 0; 1,417 modules transformed). Temporary output leaves the parent's tracked bundle integration untouched.
- `git diff --check` (exit 0).

Added nine Rust behavioral tests covering explicit model selection, duplicate group membership, disabled/empty policy, disjoint model sets, public-alias versus selected-upstream handling, corrupt-row reads, masked public metadata, invalid retained-account rollback and routing-snapshot policy retention.

Attempted `cargo test --manifest-path desktop-tauri/src-tauri/server/Cargo.toml key_groups --lib`; PowerShell reports `cargo` is not recognized. Rust code and these tests are therefore **not compile/test verified** in this environment. The parent must run Rust check/tests after obtaining a toolchain and must regenerate final frontend assets/i18n translations during integration. `ui-islands` and `ui-kit` dependencies are installed and ready for that work.
