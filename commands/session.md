---
description: Manage V4 agent sessions — create, persist, resume, expire, and thread context
argument-hint: Subcommand — list | status <sessionId> | persist <sessionId> | resume <sessionId> | cleanup
---

# AgentForge Session

Manage V4 session lifecycle and cross-session context threading.

## Subcommands

- `list` — List all sessions (filterable: `--active`, `--persisted`, `--completed`, `--expired`)
- `status <sessionId>` — Show session details including context chain
- `persist <sessionId>` — Persist an active session for later resumption
- `resume <sessionId>` — Resume a persisted session
- `cleanup` — Remove expired/completed sessions older than 24h
- `context <sessionId>` — Show the cross-session context chain

## What to Do

1. Import `V4SessionManager` from `src/session/v4-session-manager.ts`
2. For `list`: call `mgr.list()` or `mgr.listActive()`, display as table with sessionId, agent, status, task description
3. For `status`: call `mgr.get()`, show full session details including contextChain entries
4. For `persist`: call `mgr.persist()` — transitions active → persisted for crash recovery
5. For `resume`: call `mgr.resume()` — transitions persisted → active, increments resumeCount
6. For `cleanup`: call `mgr.cleanup(86400000)` — removes terminal sessions older than 24h
7. For `context`: call `mgr.getContextChain()` — shows linked sessions and threaded learnings

## Session Lifecycle

```
create → active ↔ persisted → completed
                             → expired
```

## Timeout Policies by Autonomy Tier

| Tier | Name | Timeout |
|------|------|---------|
| 1 | Supervised | 15 min |
| 2 | Assisted | 30 min |
| 3 | Autonomous | 60 min |
| 4 | Strategic | 120 min |

## Serialization

Sessions survive process restarts via `mgr.toJSON()` / `V4SessionManager.fromJSON()`. Persisted sessions can be resumed across conversations.
