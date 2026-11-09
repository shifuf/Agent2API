# Routing model rates and Docker delivery

**Goal:** Show provider-reported model multipliers while choosing and reviewing route members, then push the accumulated approved changes and verify the Docker build.

**Design:** Carry the existing manifest `credits` string through the routing catalog. A shared UI formatter renders valid multiplier text, including zero, without inventing values for missing prices or converting unrelated token prices. Desktop and mobile reuse the model picker and badge. Rates are informational and do not change routing order, weight or billing.

**Scope:** New-route picker, add-member picker, desktop/mobile route members; preserve provider scoping, Key restrictions, chat/image selection and all existing drafts. Keep version 3.4.2. The user explicitly requested push/build; publish the beta branch snapshot to the existing fork GHCR workflow, without a version tag or GitHub Release.

## Implementation and verification

- [x] Extend the existing isolated HTTP/browser regression with paid/free/missing rates and mobile coverage; observe the missing-catalog failure before implementing.
- [x] Forward manifest credits and add a shared rate formatter/badge to the picker and route members.
- [x] Build desktop, mobile and server; run routing/browser, credential and upgrade checks relevant to the accumulated changes. Review the changes before publication.
- [ ] Commit the approved changes to beta and push origin/beta. Follow Docker package until completion and verify both architecture manifests plus the exact commit label and immutable image tag.
- [ ] Restart the local service with the verified build, and provide data-preserving upgrade/rollback commands for the existing Docker deployment.

## Delivery notes

- Origin is `shifuf/Agent2API`; remote beta starts at `e7e0afc9ac2a4e64b46d3ba7f1df7de68d15b27f`.
- The working tree also contains the previously requested unified chat/image route groups, restored upstream model directory and account credential inspection. Include these reviewed changes in delivery; do not discard them.
- The server data mount previously reported by the user is `/www/server/panel/data:/data`. Upgrade instructions must inspect the running container and preserve data, encryption keys and rollback state.

## Verified before push

- The initial browser regression failed on missing `catalog.credits`, as expected.
- Desktop/mobile builds and final server build passed; 18 routing/Key unit checks and translation checking passed.
- Updated browser regression: 9 steps, 0 runtime errors; screenshots of paid rates on desktop/mobile inspected. Evidence: `C:/Users/shifuf/AppData/Local/Temp/agent2api-group-only-ui/2026-11-09T12-38-47-015Z/results.json`.
- Credential HTTP/browser regression with balance fields passed (`agent2api-credentials-NPqovk`). Engine checks: 11 passed (`agent2api-group-engine-fHrRh4`). Legacy upgrade/restart and corrupt/conflicting-input atomicity passed (`agent2api-group-upgrade-K0ewoZ`). All used isolated temporary data.
- Independent rate review reported no actionable blockers, including 17 formatter checks. Credits are display metadata and do not change routing/billing or saved member weights.
- Local service restarted on `127.0.0.1:3065`, PID 25076; health returned 200.
- Upgrade/rollback scripts prepared in ignored `.verify/`; Bash syntax checks passed. The immutable image reference will be filled only after the exact pushed commit builds successfully.
