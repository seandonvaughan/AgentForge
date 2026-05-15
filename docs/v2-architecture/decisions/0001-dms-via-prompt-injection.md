# ADR 0001 — DMs delivered via system-prompt injection

**Status:** Accepted (spec-only — no implementation yet)
**Date:** 2026-05-15
**Context cycle:** v16.x architecture planning

## Context

We need a delivery mechanism for direct messages between agents. Three candidates were considered.

## Decision drivers

- Latency: DMs should arrive within one invocation of the recipient.
- Reliability: messages must survive process restart.
- Existing surface: minimise new code paths into the agent runtime.
- Cost: zero token overhead for the *sender*; per-recipient token cost must be bounded.

## Options considered

### Option A — Synchronous tool call

The recipient agent would expose a `receive_dm` tool that the runtime hot-loads. Sender invokes via tool-call directly.

- Pro: real-time.
- Con: requires the recipient to be **running right now**. Forty-agent fleet, ~3 agents active concurrently — most DMs would fail with "recipient not running."
- Con: synchronous semantics are a poor fit for the cycle-based scheduler.

### Option B — New websocket "DM channel"

Open a websocket per agent, fan-out via subscription.

- Pro: real-time, scales.
- Con: agents are not long-running processes in AgentForge — they're one-shot invocations. There's no "agent process" to hold a socket open.
- Con: large new code surface (connection management, reconnect, replay).

### Option C — Prompt injection on next invocation

When a DM is sent, write it to SQLite. When the recipient is next invoked, the runtime queries unread DMs and splices them into the system prompt as a markdown block — exact same pattern as `injectFreshContext` at `packages/core/src/agent-runtime/fresh-context.ts:198`.

- Pro: **the mechanism already exists**. We're extending one function, not inventing a delivery layer.
- Pro: durable — DMs persist in SQLite regardless of who's running.
- Pro: zero token overhead for the sender. Recipient sees ≤10 DMs (bounded by route), each ≤4000 chars (recommendation).
- Con: latency is bounded by the recipient's invocation cadence. For idle utility agents this can be hours.
- Con: the LLM has to opt into replying — no forced delivery semantics.

## Decision

**Option C.** Prompt injection.

The latency drawback is acceptable because:
1. Strategic-tier agents (CEO, gate, architect) run every cycle — sub-minute latency in practice.
2. For lower-tier agents, the inbox (Subsystem B) is the SLA channel. DMs are explicitly "best effort, next invocation."
3. Users who need hard SLAs can `POST /api/v6/dms` with `priority='critical'` and the runtime can boost scheduling priority for the recipient (deferred to v1.1).

## Consequences

- Recipient runtime owns the read-acknowledgement bookkeeping — the LLM does not need to call a `mark_read` tool. The runtime sets `delivered_at` at injection time and `read_at` on turn completion.
- The DM prompt block is appended **after** fresh-context (which is appended after the baked system prompt). Order matters: lessons first, then "what just happened in your inbox."
- The same injection pattern is reusable for KB doc tldrs and inbox digests, keeping the prompt-mutation surface unified.

## Reference

- Existing injector: `packages/core/src/agent-runtime/fresh-context.ts:198`
- Memory store contract: `packages/core/src/memory/types.ts:190`
