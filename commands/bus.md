---
description: View V4 message bus status, history, and topic registry
argument-hint: Optional subcommand — history | topics | drain | stats
---

# AgentForge Bus

Inspect and manage the V4MessageBus — the typed pub/sub event backbone for all agent communication.

## Subcommands

- `history` — Show recent bus messages (default: last 50). Use `--topic <prefix>` to filter by topic.
- `topics` — List all registered topics with subscriber counts
- `drain` — Flush the priority queue (deliver all pending normal/low-priority messages)
- `stats` — Show message throughput, queue depth, and delivery latency

## What to Do

1. Import `V4MessageBus` and `registerStandardTopics` from `src/communication/v4-message-bus.ts`
2. For `history`: call `bus.getHistory()`, format as a table with columns: timestamp, from, to, topic, priority, category
3. For `topics`: list all 18 standard topics registered by `registerStandardTopics()` plus any custom topics
4. For `drain`: call `bus.drain()` to deliver queued messages, report how many were flushed
5. For `stats`: show total published, total delivered, queue depth, wildcard subscriber count

## Architecture Context

The V4MessageBus replaces file-system polling. All review lifecycle events, meeting coordination, and channel messages flow through the bus. Priority levels:
- **urgent** — delivered synchronously on publish
- **high/normal** — queued and delivered on drain
- **low** — queued, may be batched

Standard topic prefixes: `review.lifecycle.*`, `meeting.coordination.*`, `delegation.*`, `memory.*`, `session.*`, `flywheel.*`
