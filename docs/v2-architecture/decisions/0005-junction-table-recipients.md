# ADR 0005 — Junction table for inbox recipients

**Status:** Accepted
**Date:** 2026-05-15

## Context

Inbox messages can be addressed to multiple recipients (`@team-reviewer`, `@user`, individual agents). Read/archive state must be tracked **per recipient** — `@user` archiving a message must not flip its state for an agent that hasn't seen it yet.

Three storage shapes were considered.

## Options considered

### Option A — Comma-separated recipient string

`inbox_messages.recipients = '@user,coder,architect'`, no per-recipient state.

- Pro: simplest schema.
- Con: cannot track per-recipient read state at all.
- Con: any query against recipient requires `LIKE '%...%'` — no index help.
- **Rejected** outright.

### Option B — One row per (message, recipient)

Denormalise the body — copy the full message into N rows, one per recipient.

- Pro: trivial queries — `WHERE recipient = 'coder'`.
- Con: storage bloat for `@all` (N=40) or `@team-*` (N=5–10).
- Con: edits to the body require N row updates.
- Con: threading becomes harder — `thread_id` semantics get fuzzy with body copies.

### Option C — Junction table `inbox_recipients`

`inbox_messages` holds body + thread metadata (one row per logical message). `inbox_recipients(message_id, recipient, status, ...)` holds per-recipient delivery state.

- Pro: body lives once. Edits are single-row updates.
- Pro: per-recipient state is naturally modelled.
- Pro: full-text search indexes the body once (FTS5 over `inbox_messages`).
- Pro: adding a recipient post-hoc (e.g. CC after the fact) is `INSERT INTO inbox_recipients`.
- Con: most queries need a join — but the indexes make this cheap.

## Decision

**Option C.** Junction table.

Indexes: `(recipient, status, message_id)` is the dominant lookup ("show me coder's unread messages") and benefits from being a covering index for the join. `(message_id)` is automatic via the PK.

## Consequences

- `GET /api/v6/inbox/:recipient` is a `JOIN inbox_recipients ON ... WHERE recipient = ?` — one index probe.
- `@team-*` resolution lives in the route handler (or a SQL view) — at query time, expand `@team-reviewer` to the set of agent IDs in that team and `WHERE recipient IN (...)`.
- Cascade delete on `inbox_messages` cleans up the junction rows automatically (`ON DELETE CASCADE` on `inbox_recipients.message_id`).
- Per-recipient snooze (`snooze_until`) and starring (`starred`) live on the junction — but starring is whole-message in this spec, so it's on `inbox_messages` instead. If we later want per-user stars, move it to the junction.

## Trade-offs accepted

- Slightly more code in the route handler for the join + expansion of team aliases. Worth it for the storage and editability wins.
- An `@all` message still creates 40 rows in `inbox_recipients` — but they're tiny (4 short text fields + 2 timestamps). Tractable.

## Reference

- Schema: `agent-comm-and-kb-spec.md` §4.2
- Existing reference for many-to-many: `user_workspaces` in `packages/db/src/schema.ts:21`
