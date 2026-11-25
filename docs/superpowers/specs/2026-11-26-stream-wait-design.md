# Streaming while routing waits

The production domain uses Tencent EdgeOne. An isolated POST probe with a 20-second delay before response headers succeeds through origin Nginx but receives EdgeOne HTTP 524 at 15.1 seconds. The same probe with immediate SSE comments completes through both paths. Production Harness requests correspond to origin `499 0` and gateway disconnect finalization at 14,992–14,999 ms. Nginx buffering is disabled and its read timeout is 600 seconds.

Preserve the existing route hold and failover rules. For streaming HTTP chat, Responses and Anthropic requests, allow 500 ms for forwarding to finish normally; otherwise hand the still-owned forwarding future to the response body. Emit SSE comments immediately and every five seconds at the HTTP boundary, outside protocol conversion and usage accounting. A dropped body drops the pending future; do not spawn detached inference tasks. Fast errors retain their HTTP status. Errors after headers become protocol error events and retain error telemetry. Non-streaming JSON and internal/model-test requests keep their existing behavior.

Alternatives: increasing CDN origin timeout would require external configuration access and would leave other intermediary timeouts exposed; forwarding the first upstream role/control frame would accidentally disable first-content failover. HTTP comments provide keepalive without committing model output, credentials, a selected account or usage.

The selected production route explicitly sets firstToken=0. Do not silently change that stored preference. User approved deployment with a 180-second per-candidate deadline so unresponsive candidates can fail over while the downstream remains connected. Existing actual upstream errors already follow the ordered candidate/freeze policy; the reported single-attempt records were disconnected requests, not missed failure retries.

Version stays 3.5.1. No commit/push until the user has reviewed the new release log. Only the 175 deployment is in scope; no schema change or multi-GB data copy.
