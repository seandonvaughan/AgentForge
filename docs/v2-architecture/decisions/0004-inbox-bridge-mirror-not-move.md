# ADR 0004 — InboxBridge mirrors gate/review/cost events; JSONL memory store stays canonical

**Status:** Accepted
**Date:** 2026-05-15

## Context

Today, gate verdicts and review findings are written to `.agentforge/memory/*.jsonl` by `writeMemoryEntry` (`packages/core/src/memory/types.ts:190`). They are read at the start of every cycle by `injectFreshContext` (`packages/core/src/agent-runtime/fresh-context.ts:198`) and the audit phase.

With the new inbox, the obvious-but-wrong move would be to make the inbox the new home for these events and retire the JSONL files. We rejected that.

## Decision drivers

- Fresh-context injection is on the hot path of every agent invocation. It must not depend on the inbox DB being available.
- The JSONL files are append-only, file-system based, and have survived every refactor since v2. They are a known-good substrate.
- The inbox is **for surfacing to humans**, not for storing structured cross-cycle memory.
- DB corruption or migration failure should not blind the agent runtime to its history.

## Decision

**`InboxBridge` mirrors, it does not move.**

When `GatePhaseHandler` or the review phase emits a gate-verdict or review-finding:

1. **First**, it calls `writeMemoryEntry({type, ...})` — unchanged. The JSONL file is the source of truth.
2. **Second**, it calls `sendInboxMessage({recipients: ['@user'], category: 'verdict' | 'finding', sourceKind: 'gate' | 'review', sourceId: <memoryEntryId>, body: <rationale>})`. The inbox row points back to the memory entry via `sourceId`.

If step 2 fails, step 1 still happened — the agent runtime can still load fresh context. If the inbox DB is dropped, fresh-context injection still works.

For events that have no memory-store counterpart today (cost warnings, daemon health alerts), `InboxBridge` writes only to the inbox. There is no parallel JSONL write because there is no agent that consumes those at fresh-context time.

## Consequences

- Two writes per gate verdict, two per critical/major review finding. Small price.
- The inbox row's `sourceId` provides a stable back-link from the dashboard inbox into the underlying memory entry — clicking a verdict in `/inbox` jumps to the source.
- A future "rebuild inbox from memory" operation is well-defined: scan all JSONL files, re-emit inbox messages addressed to `@user`. No data loss in a recovery scenario.
- `InboxBridge` is a single file (`packages/core/src/inbox/inbox-bridge.ts`) with one `MessageBusV2` subscription per category. Lightweight.

## Rejected alternative

"Make the inbox the new canonical home and read fresh-context from SQLite directly."

Rejected because:
1. It couples the runtime hot-path to a new DB table.
2. It would require migration of existing JSONL data, which is high-risk for low payoff.
3. It conflates two different access patterns: fast curated bullets (memory) vs. browsable threaded messages (inbox).

## Reference

- Memory write: `packages/core/src/memory/types.ts:190`
- Fresh-context reader: `packages/core/src/agent-runtime/fresh-context.ts:77` (`loadEntries`)
- Existing event examples: `cost.budget.warning`, `agent.feedback.submitted` in `packages/core/src/message-bus/types.ts:67`
