# WASM Tools Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user has already authorized direct implementation, beta push and deployment.

**Goal:** Restore usable tools for the two verified Raccoon models and connect the official ChatGLM tool-emulation contract.

**Architecture:** Correct verified native model metadata in the leased RpcAdapter without changing raw cache or user overrides. Adapt the fixed upstream web_tools request/parser/stream modules, keeping original host output observation before the emulation wrapper.

**Tech Stack:** Rust, Tokio, Wasmtime, SQLite, serde_json, offline jsonschema 0.61.2.

**Spec:** `docs/superpowers/specs/2026-11-25-wasm-tools-compatibility.md`

## Global Constraints

- Base `132e7d099a204b60513a807b9054372558e5f2c9`; upstream `33f5e797836ac91d958022e9f4ca53c30d0432ec`; product `3.5.1`.
- Work in the existing detached managed worktree. Only push `origin/beta`; no main, tag or Release.
- Never modify live account/Key scope or enable excluded route members to obtain a passing test.
- Keep all original cancellation, usage, lease, proxy and replay boundaries.

## Review Focus

- A stale catalog must not reauthorize emulation after the current guest drops its contract.
- A late guest failure after a complete-looking SSE prefix must not release executable tools.
- A user override of false must still exclude the corrected native model from tool routing.
- Tool-result error markers must survive until the actual request bridge consumes them.
- Invalid tool responses must not cause a second committed upstream request.

### Task 1: Native Raccoon compatibility and signed-guest regressions

**Files:**
- Create: `desktop-tauri/src-tauri/server/src/server/core/plugin_host/wasm/tool_tests.rs`
- Modify: `desktop-tauri/src-tauri/server/src/server/core/plugin_host/wasm/test_support.rs`, `wasm/mod.rs`, `rpc.rs`
- Create: `desktop-tauri/src-tauri/server/src/server/core/plugin_host/rpc_model_compat.rs`

**Interfaces:**
- Consumes original signed package fixtures, real `UpstreamService::forward` and `routing_groups::project`.
- Produces a per-host immutable native model compatibility rule and `official_raccoon_tools_route_and_roundtrip` regression.

- [x] Write Raccoon and ChatGLM signed-guest tests. Assert normal route membership, complete tool arguments, public alias, tool-result roundtrip and original credentials.
- [x] Run each with `cargo test --locked -p agent2api-server <case> -- --ignored --exact --test-threads=1`; require the old code to fail at normal tool route projection, not fixture initialization.
- [x] Bind the native correction to a fresh official signature, WASM Raccoon and version 0.1.1. Apply only the two verified IDs; leave raw cache untouched and mark gateway source.
- [x] Run the Raccoon regression GREEN; exercise unrelated model, unsigned/current-version guard and explicit user override false.

### Task 2: Declared web tools, complete verification and deployment

**Files:**
- Create: `core/upstream/web_tools/{mod,request,parser,stream,tests}.rs` under the server source.
- Create: `server/config/web_tools.rs`, `server/api/web_tools.rs` under the server source.
- Create: `scripts/test-web-tool-emulation.mjs` for real management authentication and restart persistence.
- Modify: module declarations, `plugin_host/rpc.rs`, `providers/catalog.rs`, `providers/catalog/snapshot.rs`, `models/shape.rs`, `upstream/provider_loop.rs`, `server/http.rs`, server `Cargo.toml` and workspace lock.
- Update: `docs/upstream-sync.md`.

**Interfaces:**
- Consumes the fixed upstream `Profile`, `prepare`, `Context` and `wrap` contracts.
- Produces advertised effective capability, a real management switch and validated standard Chat SSE tools after guest EOF.

- [x] Adapt fixed upstream modules and pin offline jsonschema 0.61.2. Preserve tool-result internal error markers until prepare strips them from the actual outgoing body.
- [x] Connect the current handshake contract, reject stale cache reauthorization, and invalidate catalog snapshots when the setting changes. Preserve user overrides.
- [x] Run the ChatGLM signed-guest regression GREEN for stream and aggregate calls and results; verify declared native paths remain unchanged.
- [x] Add and run meaningful invalid nonce/schema/history, incomplete terminal/EOF, late error, cancellation, no-replay and toggle/downgrade regressions.
- [x] Run normal Cargo library suite, workspace check, server and timing-example build, and affected routing/protocol/Key/proxy HTTP regressions. Expected: zero failures and command exit 0.
- [x] Record actual source and evidence, and request a fresh independent whole-change review. Address Critical/Important findings with failing tests first.
- [ ] Commit verified changes, push beta, verify build revision/digests, back up current production data, deploy the fixed digest and verify existing public models, pinned accounts and both native tool roundtrips.

Review follow-up: trusted errors now pass through the real ForwardStream and model-alias rewrite to hold/aggregate as typed GatewayError. Only final public delivery emits SSE error/DONE; no private retry fields are serialized. The original non-strict RpcStream gives actual Done(Err) priority over preliminary public errors. Three routing/output regressions and a real RpcStream event-sequence regression were first observed RED and then GREEN. Final Cargo executed 516 ordinary tests and nine separate signed fixtures; all 13 Cargo commands and 10 HTTP groups exited 0. Publication evidence is recorded separately after the frozen review gate.
