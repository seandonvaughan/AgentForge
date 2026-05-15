# ADR 0003 — One notification surface, three badges

**Status:** Accepted
**Date:** 2026-05-15

## Context

DMs, inbox, and KB updates all produce events the user (and other agents) want to see. We can either build three independent SSE streams + three bell icons, or share one notification surface.

## Decision drivers

- Visual noise: three bells is a UX failure.
- Implementation cost: one bridge is cheaper than three.
- Existing infrastructure: `globalStream` (`packages/server/src/routes/v5/stream.ts`) already aggregates runtime events into SSE — proven path.
- Filterability: users still need to act on the categories separately.

## Decision

**One SSE stream. Three badges. One bell.**

All three subsystems publish on `MessageBusV2` with new topics:

- `agent.dm.sent`, `agent.dm.read`
- `inbox.message.created`, `inbox.message.read`, `inbox.message.archived`
- `kb.document.created`, `kb.document.updated`

The existing `globalStream` already subscribes to `MessageBusV2` for runtime events (`bridgeRuntimeEventToGlobalStream` in `packages/server/src/routes/v5/index.ts:263`). Extend it to forward the new topics.

The dashboard topbar bell renders **three badge dots** (DM, inbox, KB) sourced from one SSE connection. Each badge has its own count + own filter on the `/inbox` page.

## Consequences

- `MessageBusV2`'s `MessageTopic` union (`packages/core/src/message-bus/types.ts:37`) gets ~7 new entries.
- `globalStream.emit({type, ...})` gets new `type` values: `dm_event`, `inbox_event`, `kb_event`. Existing types (`workflow_event`, `cost_event`, `agent_activity`) unchanged.
- Dashboard adds one Svelte store `notificationsStore` that fan-outs to three computed counts.
- A single connection = simpler reconnect logic, lower per-client overhead in production.

## Trade-off accepted

If KB updates become very chatty (auto-generated lessons-learned docs on every cycle), the same stream serves the noisy and the urgent. Mitigation: each event has a `priority` field; client-side filtering can demote low-priority events to a "silent" channel that doesn't increment the bell but is still visible on `/inbox`.

## Reference

- Existing stream: `packages/server/src/routes/v5/stream.ts`
- Bridge example: `packages/server/src/routes/v5/index.ts:263` (`bridgeRuntimeEventToGlobalStream`)
- Bus topics: `packages/core/src/message-bus/types.ts:37`
