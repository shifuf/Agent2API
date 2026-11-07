# Task 3: Fork Docker publication

Implemented locally on beta; no remote push, tag, Release or package publication was performed.

## Changes

- Added `.github/workflows/docker.yml`: pushes to main/beta and manual runs build this repository into its own lowercase GHCR namespace with GITHUB_TOKEN. main publishes latest, beta publishes beta, other manually selected refs publish dev; every build includes `sha-<full commit SHA>`. amd64 and arm64 are built together. Permissions are contents:read/packages:write, and OCI source/revision/license metadata are attached. Buildx GHA cache and per-ref cancellation are enabled.
- Dockerfile now builds desktop/login/mobile/i18n assets from current sources in a native Node 22 stage, using four npm lockfiles. It copies the built UI into compilation, bundle, and runtime stages. Native mobile build/signing files are not copied. Existing Rust cross-compilation, volume, healthcheck and runtime layout remain. Rust compilation now uses `--locked`.
- Dockerfile and compose default `AGENT2API_SELF_UPDATE` to 0 so fork features are not overwritten with upstream release binaries.
- Compose defaults to `ghcr.io/shifuf/agent2api:latest`, with configurable `AGENT2API_IMAGE` and `AGENT2API_VERSION`. It retains local build support and `./data:/data`.
- All six install documents describe GHCR publishing, trigger/tag semantics, package visibility, pull/local-build commands and the new self-update default.

## Verification

- `actionlint` v1.7.12: `.github/workflows/docker.yml` passed (exit 0).
- Parsed workflow and compose using PyYAML; checked trigger branches, permissions, architecture list, image variables, data volume and self-update default.
- Executed the workflow's actual Bash tag-generation script for refs/heads/main, refs/heads/beta and refs/heads/feature using mixed-case repository input; each produced the expected lowercase image, immutable full-SHA tag and exactly the intended rolling tag.
- Checked Dockerfile COPY input paths and stage references; built UI is wired into all three consumers.
- Confirmed six install translations contain the same image-selection variables and self-update default; no upstream Docker image references remain in those six files.
- `git diff --check` passed for the changed tracked files (only existing Git LF/CRLF normalization warnings).
- Verified action versions via the official repositories' releases and action.yml on November 7, 2026: checkout v7.0.1, setup-qemu v4.4.0, setup-buildx v4.4.1, login v4.8.0, build-push v7.4.0; selected major refs all use Node 24.
- Checked official GitHub publishing-Docker-images documentation for GHCR registry/GITHUB_TOKEN/packages:write usage. The web tool returned no extractable content, so the official pages were fetched through PowerShell for verification.

## Limitations and integration notes

- This machine has no Docker executable/engine; no actual image build, pull, startup or dual-architecture runtime test was performed. Final desktop/mobile TypeScript and frontend builds, i18n generation and dictionary checks passed during integration.
- Subscription dependencies are recorded in Cargo.lock; the final server and test harness compiled successfully using `--locked --offline`.
- All six README quick-start Docker image references now point to the fork image. All six install documents also explain the explicit public-model setup required after upgrading.
- First publication can create a private GHCR package. Change package visibility to Public if anonymous pulls are required; documented in all six install files.
