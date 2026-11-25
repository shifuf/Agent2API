# Streaming Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep streaming clients connected while the existing routing future waits for first content and retries candidates.

**Architecture:** A shared HTTP-only helper owns the pending forward future inside the response body after a 500 ms grace period. The final SSE response adds immediate/five-second comments outside transformation and accounting.

**Tech Stack:** Rust, Tokio, futures, Axum; Node HTTP integration fixtures.

**Spec:** ../specs/2026-11-26-stream-wait-design.md

## Global Constraints

- Preserve cancellation, replay guards, content-commit boundaries and key scope.
- Keep non-streaming and internal forwarding behavior; version 3.5.1, beta only, no tags.
- Do not commit until the user confirms the new log; production configuration firstToken=0 stays explicit.

## Review Focus

- Responses/Anthropic transformations discard comments: add keepalive after conversion.
- Dropping the response must release pending inference and slots without detached work.
- Fast authentication/validation errors retain status; slow final failures use protocol error frames.
- Heartbeats must not fabricate first-content timing, usage, completed replies or affinity.
- A slow first candidate may time out and switch while heartbeats continue; a partial reply must not switch.

### Task 1: Keepalive during HTTP routing waits

**Files:** create `server/src/server/api/stream_wait.rs`; modify API module, chat/protocol forwarding call sites and pipeline SSE construction; extend `scripts/test-sticky-failover.mjs`.

**Interfaces:** `stream_wait::forward(UpstreamService, ForwardRequest) -> Result<ForwardOutcome, GatewayError>`; `stream_wait::keepalive(ByteStream) -> ByteStream`.

- [x] Add HTTP regressions: all three protocols expose bytes within 1.5 seconds despite four-second upstream headers; firstToken timeout traverses accounts while comments continue; canceled wait never sends the next account; fast errors preserve status; slow final errors retain telemetry and protocol termination; JSON remains JSON.
- [x] Run regressions against current binary and observe missing early bytes.
- [x] Implement deferred forwarding after 500 ms and keepalive outside transformation/accounting.
- [x] Run regressions, existing sticky/runtime/prepare coverage and Rust library suite. Final HTTP39/39, runtime6/6, prepare3/3; lib serial537/537 plus21 ignored. Default parallel has an existing shared-session capture fixture failure; see validation record.
- [x] Review the completed diff independently; prepare the precise release log for user confirmation.

## Evidence

- EdgeOne late probe: 524 at 15,109 ms; origin late probe: 200 at 20,027 ms.
- EdgeOne early comments: first byte 154 ms, completed 20,172 ms; origin first byte 7 ms, completed 20,024 ms.
- Probe location and original Nginx file restored after verification.
