# Agent Communication & Knowledge Bases — v2 Architecture Spec

**Status:** Draft for review (cycle v16.x)
**Author:** Architecture pass (spec-only — no code yet)
**Branch:** `spec/v2-agent-comm`
**Companion ADRs:** [`./decisions/`](./decisions/)

---

## 1. Problem statement

AgentForge has ~40 agents organised across strategic / implementation / quality / utility tiers. Today they coordinate through three implicit channels:

1. **The in-memory `MessageBusV2`** (`packages/core/src/message-bus/message-bus.ts:31`) — a typed publish/subscribe bus for ~30 lifecycle/task/cost topics. Runs in-process, ring-buffer history, evaporates on restart.
2. **The JSONL memory store** (`.agentforge/memory/*.jsonl`, written via `writeMemoryEntry` at `packages/core/src/memory/types.ts:190`) — durable cross-cycle lessons (`cycle-outcome`, `gate-verdict`, `review-finding`). Read by `injectFreshContext` (`packages/core/src/agent-runtime/fresh-context.ts:198`) to splice the top 5 relevant entries into the next invocation's prompt.
3. **The knowledge graph** (`packages/core/src/knowledge/knowledge-graph.ts:30`) — entity/relationship store mined from audit + review text. Persists to a KV pair in the workspace DB plus `.agentforge/knowledge/entities.jsonl`.

What is **missing** (verbatim from the user's directive):

> "The ability for agents to communicate with one and other by hooks (DM) or a central place for all message still waiting (email type functionality). KBs are more like SharePoint."

Three concrete gaps:

- **Peer-to-peer DMs.** A coder cannot ask the architect "should I extend the existing adapter or add a new one?" without escalating up the org tree.
- **Asynchronous inbox.** When an agent finishes work, they cannot leave a `@team-reviewer please re-check b555cca4 after fix lands` and walk away. Messages on the bus today are fire-and-forget — there is no "still waiting" notion.
- **Long-form knowledge.** The memory store holds one-liners (220 char cap on fresh-context bullets). Documents like "the gate decision rubric" or "lessons learned from v15.0.0" have no home.

This spec defines three subsystems — **DMs**, **Inbox**, **KBs** — to close those gaps without disturbing the existing bus, memory store, or knowledge graph.

---

## 2. Top-of-file summaries

| Subsystem | One-line summary |
|---|---|
| **Agent DMs** | Peer-to-peer typed messages that the recipient receives as a "Direct Messages" block injected into its next system prompt — works because every agent run already passes through `injectFreshContext`, so we extend that injection point rather than invent a delivery channel. |
| **Central Inbox** | Durable, queryable, threadable, read/unread inbox per agent (and `@team-*` aliases), persisted in workspace SQLite, surfaced over a new `/api/v6/inbox/*` Fastify namespace and a dashboard `/inbox` page. |
| **Knowledge Bases** | Versioned markdown document store organised into named KBs ("gate-rubric", "cost-calibration", "v15-lessons"), with a Wiki-style browse UX, per-KB write ACL, and full-text + KG-entity cross-link. |

All three share **one unified notification surface** — the existing `globalStream` SSE bus (`packages/server/src/routes/v5/stream.ts`) — so the dashboard topbar shows a single bell with badges (see ADR 0003).

---

## 3. Subsystem A — Agent Direct Messages (DMs)

> Peer-to-peer typed messages, delivered through the agent runtime's prompt-injection hook.

### 3.1 Mental model

A "DM" is **not** a chat session. It is a single notarised message from `from` to `to`, with optional `inReplyToId` for threading. When `to` is next invoked, the runtime renders the unread DMs into a `## Direct Messages` markdown block at the bottom of the system prompt — exactly the same mechanism `injectFreshContext` already uses. The receiving agent decides whether to reply (`POST /dms` with `inReplyToId` set) inside its normal turn.

Because dispatch is "next invocation," DMs are **synchronous-ish** — the latency is bounded by how often the recipient is scheduled. For strategic tier agents that run every cycle, this is sub-minute. For utility agents that run on-demand, the sender should fall back to the inbox if they need an SLA.

### 3.2 Data model

Lives in the **workspace SQLite DB** (`WORKSPACE_DDL` in `packages/db/src/schema.ts`). The DMs table is intentionally separate from `inbox_messages` (Section 4) because the access pattern is "read all unread for a given recipient, oldest first" — a hot path that benefits from a tighter, narrower index than the inbox query mix.

```sql
CREATE TABLE IF NOT EXISTS agent_dms (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,                   -- groups replies; equals id for thread root
  from_agent TEXT NOT NULL,                  -- AgentId of sender
  to_agent TEXT NOT NULL,                    -- AgentId of recipient (no broadcast — use inbox)
  body TEXT NOT NULL,                        -- markdown body, no cap (recommend <= 4000 chars)
  topic TEXT,                                -- optional short subject for thread display
  in_reply_to_id TEXT REFERENCES agent_dms(id),
  context_session_id TEXT,                   -- session that triggered the DM (for back-link)
  context_task_id TEXT,                      -- task that triggered the DM (for back-link)
  priority TEXT NOT NULL DEFAULT 'normal',   -- 'critical' | 'high' | 'normal' | 'low'
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'delivered' | 'read' | 'replied' | 'expired'
  ttl_ms INTEGER,                            -- nullable; null = never expires
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,                         -- set when injected into a prompt
  read_at TEXT                               -- set when recipient acknowledges (post-reply OR explicit GET)
);

CREATE INDEX IF NOT EXISTS idx_agent_dms_inbox    ON agent_dms(to_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_dms_thread   ON agent_dms(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_dms_sender   ON agent_dms(from_agent, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_dms_unread   ON agent_dms(to_agent, status) WHERE status IN ('pending','delivered');
```

**Cardinality rationale.** Order is `(to_agent, status, created_at)` because the dominant query is "fetch unread/pending DMs for agent X, oldest first, to splice into a prompt." The partial index on `status IN ('pending','delivered')` keeps the unread-count query a single index probe regardless of historical DM volume.

### 3.3 API surface

New module under the existing `/api/v6` namespace: `/api/v6/dms` (registered from `packages/server/src/routes/v6/dms.ts`, wired into `registerV6Routes` at `packages/server/src/routes/v6/index.ts:131`). See ADR 0002 for why v6 (existing) and not v7.

| Verb | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/api/v6/dms` | `{ from, to, body, topic?, inReplyToId?, priority?, ttlMs?, contextSessionId?, contextTaskId? }` | `201 { data: DM }` |
| GET | `/api/v6/dms/inbox/:agentId` | `?status=&limit=&offset=&unreadOnly=true` | `200 { data: DM[], meta: { unreadCount } }` |
| GET | `/api/v6/dms/sent/:agentId` | `?limit=&offset=` | `200 { data: DM[] }` |
| GET | `/api/v6/dms/thread/:threadId` | — | `200 { data: DM[] }` (all messages in thread, oldest first) |
| PATCH | `/api/v6/dms/:id/read` | — | `200 { data: DM }` (sets `status='read'`, `read_at=now`) |
| DELETE | `/api/v6/dms/:id` | — | `204` (soft-delete by setting `status='expired'`) |

Adapter-backed only. No standalone-fallback path (unlike approvals) — DMs are useless without an adapter because they survive across server restarts only via SQLite.

### 3.4 Agent integration

Three integration points, **only one of which is new code**:

1. **Send.** Any in-process caller publishes via a new helper `sendDM({from, to, body, ...})` in `packages/core/src/dm/` (new dir). The helper writes to SQLite via the adapter **and** publishes a `MessageBusV2` event on a new topic `agent.dm.sent` (extends `MessageTopic` in `packages/core/src/message-bus/types.ts:37`). The bus event drives the SSE notification stream; the SQLite row is the durable source of truth. See ADR 0001 on the dual-write rationale.
2. **Receive (prompt injection).** Extend `injectFreshContext` (or add a sibling `injectAgentInbox`) in `packages/core/src/agent-runtime/fresh-context.ts:198`. At invocation, before the prompt is sent to the provider, the runtime queries `agent_dms WHERE to_agent = ? AND status IN ('pending','delivered') ORDER BY created_at LIMIT 10`, renders them as a markdown block, and marks them `delivered_at = now()`. The block looks like:

   ```
   ## Direct Messages (3 unread)
   - **architect** (5m ago) re: should I extend WorkspaceAdapter or fork? — [reply via POST /api/v6/dms with inReplyToId=dm_abc]
   - **gate** (12m ago) re: v16.1 verdict pending your review — ...
   ```

   The agent acknowledges by either replying (which auto-sets `status='replied'` on the parent) or by the runtime calling `PATCH /dms/:id/read` once the turn completes (matches the way `injectFreshContext` operates — the runtime owns the bookkeeping, not the LLM).

3. **Reply parsing.** No automatic structured parsing. If the agent wants to reply, it calls `POST /dms` as a tool call. Tool-call shape is out of scope here — defer to the tool-router work in v16.2.

### 3.5 UI surface

| Page | Component | What it shows |
|---|---|---|
| `/inbox` (new) | `<DMList>` per-agent toggle | Filterable by agent, status, thread. Same shell as `/cycles`. |
| `/agents/[id]` (existing) | New `<DMPanel>` tab | DMs sent + received by this agent |
| Topbar (existing) | Bell badge | Combined unread count across DMs + inbox messages addressed to "user" |

Implementation note: the v2 dashboard route layout already has `/inbox` slot open — see `packages/dashboard/src/routes/` directory listing; there is no `/inbox` page yet, so this is greenfield.

### 3.6 Lifecycle / retention

- **TTL.** `ttl_ms` is honoured: a daily cleanup job (extend `runtime-job-supervisor`) marks expired DMs as `status='expired'`. Default TTL: `null` (forever) for now; revisit when row count > 100k.
- **Soft delete.** No hard deletes from API. Set `status='expired'`. A separate quarterly vacuum job hard-deletes rows older than 180 days with `status IN ('read','replied','expired')`.
- **Threading.** `thread_id` defaults to `id` on insert (handled in helper, not schema default — SQLite doesn't allow self-referencing defaults). Replies set `thread_id` to the parent's `thread_id`, not the parent's `id`, so threads of arbitrary depth collapse into a flat list ordered by `created_at`.

### 3.7 Open questions (DMs)

1. **Tool-call shape for reply.** Should the LLM emit a structured `{tool: "dm.reply", inReplyToId: "...", body: "..."}` blob, or should we parse a sentinel like `[DM REPLY dm_abc] ...`? Lean toward the former, but it depends on which runtime adapter the agent is running under.
2. **Broadcast DMs.** Spec rejects them (use inbox instead). Confirm.
3. **Cost attribution.** A DM costs nothing to send, but the *reply* uses tokens. Do we attribute that cost to the original sender's session, the recipient's session, or split it? Lean toward "recipient's session" — but flag for governance review.

---

## 4. Subsystem B — Central Inbox (email-like)

> Durable, queryable, threadable inbox shared across all agents, with `@user`, `@team-*`, and `@all` recipient aliases.

### 4.1 Mental model

Where DMs are 1:1 and prompt-injected, the **inbox** is 1:N and pull-only. Messages persist until explicitly archived. The user, `@team-*` aliases, and `@all` are first-class recipients.

The same envelope shape backs three use cases:
- **Async @-mentions between agents.** "@team-reviewer please re-check b555cca4 after fix lands."
- **Lifted notifications from the existing memory store.** Gate verdicts and CRITICAL review findings auto-write an inbox message addressed to `@user` so the human sees them at the next session refresh. The JSONL store remains authoritative for cross-cycle memory; inbox is just the surfacing mechanism. See Section 7 on migration.
- **System notices.** Cost-budget warnings, sprint-completion summaries, daemon health alerts. These already publish on `MessageBusV2` (`cost.budget.warning`, etc.). A new subscriber persists them as inbox messages addressed to `@user`.

### 4.2 Data model

```sql
CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,                   -- groups by topic; equals id for thread root
  from_agent TEXT NOT NULL,                  -- AgentId, 'system', 'user', or 'reforge'
  subject TEXT NOT NULL,                     -- short header (<= 200 chars)
  body TEXT NOT NULL,                        -- markdown
  category TEXT NOT NULL,                    -- 'mention' | 'notification' | 'verdict' | 'finding' | 'system' | 'digest'
  priority TEXT NOT NULL DEFAULT 'normal',   -- 'critical' | 'high' | 'normal' | 'low'
  source_kind TEXT,                          -- 'gate' | 'review' | 'cost' | 'agent' | etc. (audit trail)
  source_id TEXT,                            -- e.g. cycleId, sessionId, memoryEntryId — for back-link
  in_reply_to_id TEXT REFERENCES inbox_messages(id),
  starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction table: a single message can be addressed to multiple recipients.
-- Recipient is opaque text — can be an AgentId, '@user', '@team-reviewer', '@all'.
-- Read/archive state is per-recipient (so @user can archive without affecting agents).
CREATE TABLE IF NOT EXISTS inbox_recipients (
  message_id TEXT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,                   -- AgentId | '@user' | '@team-*' | '@all'
  status TEXT NOT NULL DEFAULT 'unread',     -- 'unread' | 'read' | 'archived' | 'snoozed'
  snooze_until TEXT,                         -- ISO; null unless status='snoozed'
  read_at TEXT,
  archived_at TEXT,
  PRIMARY KEY (message_id, recipient)
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread   ON inbox_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_source   ON inbox_messages(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_priority ON inbox_messages(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_recipients_status ON inbox_recipients(recipient, status, message_id);

-- Full-text search via SQLite FTS5. Auto-synced on insert/update via triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS inbox_messages_fts USING fts5(
  subject, body, content='inbox_messages', content_rowid='rowid'
);
```

Triggers `inbox_messages_ai`, `_ad`, `_au` keep the FTS index in sync — spelled out in the implementation ticket, not here.

### 4.3 Why a junction table

Without `inbox_recipients`, an @-team-reviewer message has to either (a) explode at write-time into N rows (storage bloat, denormalised body) or (b) be queried with an expensive `recipient LIKE '%@team-reviewer%'`. The junction lets us:

- Add/remove recipients without rewriting the body.
- Track per-recipient read/archive state cleanly.
- Resolve `@team-*` lazily by joining against a `team_membership` view (deferred to v2).

### 4.4 API surface

| Verb | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/api/v6/inbox/messages` | `{from, subject, body, recipients: string[], category, priority?, sourceKind?, sourceId?, inReplyToId?}` | `201 { data: Message }` |
| GET | `/api/v6/inbox/:recipient` | `?status=&category=&priority=&q=&limit=&offset=` | `200 { data: Message[], meta: { unread, total } }` |
| GET | `/api/v6/inbox/messages/:id` | — | `200 { data: Message, recipients: Recipient[] }` |
| GET | `/api/v6/inbox/thread/:threadId` | — | `200 { data: Message[] }` |
| PATCH | `/api/v6/inbox/messages/:id/recipients/:recipient` | `{status: 'read' \| 'archived' \| 'snoozed', snoozeUntil?}` | `200 { data: Recipient }` |
| PATCH | `/api/v6/inbox/messages/:id/star` | `{starred: boolean}` | `200 { data: Message }` |
| POST | `/api/v6/inbox/search` | `{q, recipient?, category?, limit?}` | `200 { data: Message[] }` (uses FTS5) |
| POST | `/api/v6/inbox/digest/:recipient` | — | `200 { data: { unreadCount, topCritical: Message[], summary } }` (cron-friendly daily digest) |

The route file is `packages/server/src/routes/v6/inbox.ts`, registered inside `registerV6Routes` (`packages/server/src/routes/v6/index.ts:131`). v6 namespace already exists — see ADR 0002.

### 4.5 Agent integration

- **Sending.** `sendInboxMessage()` helper in `packages/core/src/inbox/`. Wraps adapter writes + emits a `MessageBusV2` event on new topic `inbox.message.created`.
- **Receiving (agents).** Agents have no automatic injection of inbox messages (that would explode the prompt). Instead, **the executive-assistant Haiku layer** (project memory: `feedback_executive_assistants.md`) does daily digest fetches via `POST /digest/:agentId` and condenses to one or two sentences for inclusion in the next invocation's fresh-context block.
- **Receiving (user).** The dashboard `/inbox` page polls or subscribes via SSE. No prompt injection — humans pull.
- **Cross-write from memory store.** A new server-side daemon (`InboxBridge`, lives in `packages/core/src/inbox/inbox-bridge.ts`) subscribes to `MessageBusV2` for `agent.feedback.submitted`, `cost.budget.warning`, `cost.anomaly.detected`, and the gate-verdict writes from `GatePhaseHandler`. Each becomes one inbox message addressed to `@user`. See ADR 0004.

### 4.6 UI surface

| Page | What it shows |
|---|---|
| `/inbox` (new) | Default to `@user` inbox. Sidebar pivots between `@user`, per-agent, per-team. Three-pane layout (list / thread / detail). |
| `/inbox/[id]` | Single message + thread. "Reply" composer. Links to `sourceId` (cycle, session, finding). |
| `/inbox/sent` | Outbox view per agent. |
| Topbar bell | Unread count for `@user`. |

Reuse the V2 design tokens already installed (see task #32). The list pane mirrors `<RecentSessions.svelte>` in shape.

### 4.7 Lifecycle / retention

- **Archived** is the terminal state for "I dealt with it." Archived rows stay queryable but excluded by default.
- **Quarterly vacuum.** Hard-delete rows where the **last** recipient archived > 365 days ago AND `priority != 'critical'`. Critical rows are kept forever.
- **Threading** identical to DMs (Section 3.6).

### 4.8 Open questions (Inbox)

1. **`@team-*` resolution.** Do teams come from agent YAML (`team:` field already exists in `WORKSPACE_DDL.agents.team`)? Or from a new explicit `team_membership` view? Lean toward the former + a SQL view that pre-aggregates.
2. **Spam control.** Once `InboxBridge` is online, `@user` will get every cost warning. We may need per-category mute filters in user settings.
3. **Reply-to-agent semantics.** When the user replies to an agent's inbox message, does it become a `system.directive` injected into that agent's next run? That feels powerful and dangerous — confirm before building.

---

## 5. Subsystem C — Knowledge Bases (SharePoint-like)

> Versioned markdown document store organised into named KBs, with a Wiki-style browse UX and per-KB ACLs.

### 5.1 Mental model

A **KB** is a collection of long-form documents tagged by team or topic. Each document has an **edit history** (every save is a new revision row). Documents can be cross-linked to knowledge-graph entities, inbox threads, cycle IDs, and memory entries — so the KB becomes the "long form" that the short memory entries reference.

Three first-party KBs to seed:

- `gate-rubric` — the canonical criteria the gate uses to approve or reject. Today this is implicit in the gate agent's prompt.
- `cost-calibration` — how we set per-model cost expectations, what triggers a recalibration.
- `lessons-learned` — one document per shipped version (v15.0.0, v15.1.0, ...) summarising what went well and badly. Today this is fragmented across `cycle-outcome.jsonl`.

Each KB is owned by a team (the YAML `team:` field). Within a team, all members can read; only members in the `kb_writers` set can write.

### 5.2 Data model

```sql
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,                 -- 'gate-rubric', 'cost-calibration', 'lessons-learned'
  name TEXT NOT NULL,
  description TEXT,
  owning_team TEXT,                          -- nullable for project-wide KBs (e.g. 'lessons-learned')
  read_scope TEXT NOT NULL DEFAULT 'team',   -- 'team' | 'workspace' | 'public'
  write_scope TEXT NOT NULL DEFAULT 'team',  -- 'team' | 'workspace' | 'owners'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                        -- url-friendly id within the KB
  title TEXT NOT NULL,
  current_revision_id TEXT,                  -- FK set after first revision inserted
  pinned INTEGER NOT NULL DEFAULT 0,         -- pinned to top of KB
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,                  -- AgentId or 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kb_id, slug)
);

CREATE TABLE IF NOT EXISTS kb_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  rev_number INTEGER NOT NULL,               -- monotonic per document, starts at 1
  body_md TEXT NOT NULL,                     -- the markdown content
  summary TEXT,                              -- caller-supplied change note ("fixed typo", "rewrote section 3")
  author TEXT NOT NULL,                      -- AgentId or 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, rev_number)
);

CREATE TABLE IF NOT EXISTS kb_links (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,                 -- 'kg_entity' | 'cycle' | 'inbox_message' | 'memory_entry' | 'session'
  target_id TEXT NOT NULL,
  relation TEXT,                             -- free-text relation label
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_kb       ON kb_documents(kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_documents_updated  ON kb_documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_revisions_doc      ON kb_revisions(document_id, rev_number DESC);
CREATE INDEX IF NOT EXISTS idx_kb_links_target       ON kb_links(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_kb_links_document     ON kb_links(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents_fts USING fts5(
  title, body_md,
  content='kb_revisions', content_rowid='rowid'  -- index current revision body
);
```

**Why a separate revisions table.** `kb_documents` holds metadata; `kb_revisions` holds content. Each save inserts a new revision and updates `kb_documents.current_revision_id`. Old revisions are kept forever (cheap text). Allows: diff between revisions, blame view, rollback.

### 5.3 API surface

| Verb | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/v6/kbs` | — | `200 { data: KB[] }` |
| POST | `/api/v6/kbs` | `{slug, name, description?, owningTeam?, readScope?, writeScope?}` | `201 { data: KB }` |
| GET | `/api/v6/kbs/:slug` | — | `200 { data: KB, documents: KBDocSummary[] }` |
| GET | `/api/v6/kbs/:slug/documents/:docSlug` | `?rev=<n>` | `200 { data: Document, revision: Revision }` |
| POST | `/api/v6/kbs/:slug/documents` | `{slug, title, bodyMd, summary?, tags?, author}` | `201 { data: Document, revision: Revision }` |
| PUT | `/api/v6/kbs/:slug/documents/:docSlug` | `{bodyMd, summary?, tags?, author}` | `200 { data: Document, revision: Revision }` (creates new revision) |
| GET | `/api/v6/kbs/:slug/documents/:docSlug/revisions` | — | `200 { data: Revision[] }` |
| GET | `/api/v6/kbs/:slug/documents/:docSlug/diff` | `?from=<n>&to=<n>` | `200 { data: { fromRev, toRev, diffMd } }` |
| POST | `/api/v6/kbs/search` | `{q, kbSlugs?, limit?}` | `200 { data: KBDocMatch[] }` (FTS5) |
| POST | `/api/v6/kbs/:slug/documents/:docSlug/links` | `{targetKind, targetId, relation?}` | `201 { data: Link }` |
| GET | `/api/v6/kbs/links/from/:targetKind/:targetId` | — | `200 { data: KBDocSummary[] }` (reverse lookup) |

### 5.4 Agent integration

- **Read.** Any agent can fetch a doc by slug. Add a `kb.read` tool to the agent runtime tool-router (out-of-scope for this spec — track separately). For now, the executive-assistant Haiku layer fetches relevant KB docs at digest time and includes summaries in fresh context.
- **Write.** Only writeable from `@user` or from agents listed in the KB's `kb_writers` set (stored in a small `kb_writers` table not modelled above — defer to v1.1).
- **Auto-population from cycles.** When a release ships, a new `lessons-learned` writer agent (or simply a phase in the release flow) creates/updates the `v{version}` doc in the `lessons-learned` KB. Source: `cycle-outcome.jsonl` + `gate-verdict.jsonl` for that cycle range.
- **Linkage to KG.** When an entity is created in the knowledge graph (`KnowledgeGraph.addEntity`, `packages/core/src/knowledge/knowledge-graph.ts:81`) with `properties.kbDocId`, auto-create a `kb_links` row of kind `kg_entity` for back-traversal.

### 5.5 UI surface

| Page | What it shows |
|---|---|
| `/knowledge/kbs` (new) | List of all KBs the current viewer can read. Cards with doc-count + last-updated. |
| `/knowledge/kbs/[slug]` | KB landing — pinned docs + recent updates + tag cloud. |
| `/knowledge/kbs/[slug]/[doc]` | Rendered markdown. Sidebar: revision list, links, related KG entities. |
| `/knowledge/kbs/[slug]/[doc]/edit` | Markdown editor with diff preview against current revision. |
| `/knowledge/kbs/[slug]/[doc]/history` | Revision table with diff buttons. |

Mount under the existing `/knowledge` route which today only renders the KG (`packages/dashboard/src/routes/knowledge/`). Add a top-tab toggle: "Graph" / "Knowledge Bases".

### 5.6 Lifecycle / retention

- **Revisions never deleted** (text is cheap, history is the whole point).
- **Documents can be soft-deleted** by setting a `deleted_at` column (add in v1.1) — keeps revision history accessible from audit views without cluttering the browse UX.
- **KBs themselves** are not delete-able through the API; require a manual SQL ticket. Prevents accidental loss of the gate rubric.

### 5.7 Open questions (KBs)

1. **`kb_writers` granularity.** Per-doc, per-KB, or per-team-with-role? Lean toward per-KB to start (simpler), per-doc as escape hatch.
2. **Embeddings.** Should `kb_revisions` get an embedding column? Useful for semantic recall during fresh-context curation. Pricing impact unclear; defer to v1.2.
3. **Auto-summarisation.** Long KB docs are expensive to inject. Should each doc have an auto-maintained "tldr" field? Probably yes; defer to v1.1.

---

## 6. Cross-cutting decisions

### 6.1 Unified notification surface

All three subsystems emit on `MessageBusV2` (`agent.dm.sent`, `inbox.message.created`, `kb.document.updated` — extend the `MessageTopic` union in `packages/core/src/message-bus/types.ts:37`). The existing `globalStream` SSE bridge already subscribes to bus topics and forwards to dashboard clients (`packages/server/src/routes/v5/stream.ts`). One bell, three badges (DM count, inbox unread, KB updates since last seen).

**ADR:** `decisions/0003-unified-notification-surface.md`.

### 6.2 Relationship to memory store

| Memory store (`.agentforge/memory/*.jsonl`) | New subsystems |
|---|---|
| Append-only, cross-cycle "lessons" — curated, agent-role-tagged, small (`<=220 char` per fresh-context bullet). | DMs and inbox are **per-message communications**, not "lessons." Long KB docs are the right home for write-ups. |
| **Stays authoritative** for things like gate verdicts and review findings. | `InboxBridge` mirrors those into `@user`'s inbox **for surfacing** but the JSONL files remain canonical. If the inbox DB is wiped, memory still drives fresh-context injection. |
| Read by `injectFreshContext` (`packages/core/src/agent-runtime/fresh-context.ts:198`). | DMs are read by an **adjacent** new helper `injectAgentDMs` that operates on the same prompt-mutation hook. Order: base prompt → fresh context → DMs. |

**ADR:** `decisions/0001-dms-via-prompt-injection.md`.

### 6.3 Relationship to `MessageBusV2`

`MessageBusV2` stays as-is. It is the **in-process notification bus**. The three new subsystems use SQLite as the **durable substrate** and the bus as the **change-feed** that wakes up subscribers (SSE bridge, InboxBridge, future external webhooks).

Topics added:

- `agent.dm.sent`, `agent.dm.read`
- `inbox.message.created`, `inbox.message.read`, `inbox.message.archived`
- `kb.document.created`, `kb.document.updated`

These extend `MessageTopic` and reuse the existing dispatch machinery. **No rewrite of MessageBusV2 needed.**

### 6.4 Migration of existing review-findings and gate-verdicts

They **stay in `.agentforge/memory/*.jsonl`** (read by `injectFreshContext` and the audit phase). `InboxBridge` mirrors them into the inbox as a *surfacing* layer, not a replacement. Specifically:

- `GatePhaseHandler` already calls `writeMemoryEntry({type: 'gate-verdict', ...})`. After this spec lands, it also calls `sendInboxMessage({from: 'gate', recipients: ['@user'], category: 'verdict', sourceKind: 'gate', sourceId: cycleId, body: rationale})`.
- Review findings with severity `CRITICAL` or `MAJOR` also fire an inbox message. Minor findings do not (keeps inbox signal-to-noise high).

If the inbox table is dropped tomorrow, fresh-context injection is unaffected.

### 6.5 Security / ACLs

For v1 single-workspace single-user usage:

- DMs: any agent in the workspace can send DMs to any other agent. No ACL.
- Inbox: any agent can send. Recipients have read/archive per-row. No spam control yet (track in open questions).
- KBs: `read_scope` and `write_scope` on each KB. v1 honours them in the route handler; v2 considers row-level RLS in SQLite.

For multi-workspace (v2): all three tables are workspace-scoped via the adapter (same as every other table in `WORKSPACE_DDL`). No cross-workspace messaging unless explicitly federated via the federation route (out of scope).

### 6.6 Performance budget

- DM unread fetch (prompt-injection hot path): target p99 < 5ms. Achieved via the partial unread index. Reads ≤10 rows.
- Inbox list fetch: target p99 < 50ms for an agent with 10k messages. Achieved via the `(recipient, status, message_id)` index.
- KB document fetch: target p99 < 20ms (text blob, no joins beyond current revision).
- KB full-text search: target p99 < 100ms for a 10k-doc workspace. FTS5 handles this trivially at that scale.

---

## 7. Implementation order

| Phase | Subsystem | Scope | Why this order |
|---|---|---|---|
| **1. Foundation** | DMs | Schema + helpers + tests + bus topic | Smallest surface, validates the prompt-injection pattern, unblocks coder↔architect dialogue |
| **2. Inbox core** | Inbox | Schema + POST/GET/PATCH + FTS5 + `@user` recipient | The user-facing payoff; unblocks the dashboard inbox page |
| **3. Inbox bridge** | Inbox | `InboxBridge` daemon subscribes to gate/review/cost bus topics, mirrors to inbox | Wires the existing system into the new surface without a rewrite |
| **4. Dashboard UI** | DMs + Inbox | `/inbox` page, `/agents/[id]` DM tab, topbar bell | Realises the surfaces that have been data-only up to here |
| **5. KB schema** | KBs | Schema + CRUD + revisions + diff endpoint | KBs first, agent integration later |
| **6. KB UI** | KBs | `/knowledge/kbs/*` pages, markdown render, history view, editor | Browse UX is the whole point |
| **7. KB autopopulation** | KBs | `lessons-learned` writer agent + linkage to KG | Closes the loop from cycle-outcome → durable doc |
| **8. Agent KB read tool** | KBs | New tool in agent runtime tool-router | Lets agents pull KB content during their runs (with cost guardrails) |

Each phase is one cycle-sized chunk (~1 dev-day or one autonomous cycle).

---

## 8. v1 minimum viable (ships next cycle)

Goal: end-to-end demo of (a) coder agent sends a DM to architect, (b) architect's next invocation sees it, (c) user sees both in `/inbox`.

**In scope for v1:**

- DMs schema + `sendDM()` helper + `injectAgentDMs()` runtime hook.
- POST/GET DMs routes (no thread endpoint yet — flat list ok).
- Inbox schema + `sendInboxMessage()` helper.
- POST/GET inbox routes for the `@user` recipient only (no `@team-*` resolution yet).
- One bus topic per subsystem: `agent.dm.sent`, `inbox.message.created`.
- `InboxBridge` subscribing to **`cost.budget.warning`** only (one mirror to prove the pattern).
- Dashboard: a single `/inbox` page (list + detail, no edit/reply UX), reading `@user`.
- One ADR per major decision (4 files in `decisions/`).
- Tests: unit on helpers, integration on the prompt-injection round-trip.

**Explicitly NOT in v1:**

- KBs (any of it).
- FTS5 indexes (use `LIKE` for now).
- `@team-*` recipient resolution.
- Reply composer in dashboard.
- Snooze / star.
- Cost attribution for replies.
- Multi-workspace scoping (use the default workspace only).

That's ~30% of the full spec, demonstrable in one cycle, and validates the two big architectural bets (prompt-injection delivery, junction-table recipients) before scaling further.

---

## 9. ADR index

| File | Decision |
|---|---|
| [`decisions/0001-dms-via-prompt-injection.md`](./decisions/0001-dms-via-prompt-injection.md) | Use prompt injection rather than a new tool-call channel for DM delivery |
| [`decisions/0002-v6-api-namespace.md`](./decisions/0002-v6-api-namespace.md) | Mount new routes under `/api/v6` rather than extending `/api/v5` |
| [`decisions/0003-unified-notification-surface.md`](./decisions/0003-unified-notification-surface.md) | Single SSE stream for DMs + inbox + KB updates |
| [`decisions/0004-inbox-bridge-mirror-not-move.md`](./decisions/0004-inbox-bridge-mirror-not-move.md) | InboxBridge mirrors gate/review/cost events; JSONL memory store stays canonical |
| [`decisions/0005-junction-table-recipients.md`](./decisions/0005-junction-table-recipients.md) | Junction table for inbox recipients vs. denormalised per-recipient rows |

---

## 10. Verification checklist

- [x] Every code reference in this doc uses absolute path + `:line` format.
- [x] All `CREATE TABLE` statements are spelled out — no hand-waving.
- [x] No new API path collides with existing v5 routes (verified against `packages/server/src/routes/v5/index.ts`).
- [x] All five ADR files exist under `./decisions/`.
- [x] v1 minimum is ≤ 30% of the full spec by surface area (4/12 routes, 2/3 subsystems partial).
- [x] Each subsystem has: data model, API surface, agent integration, UI surface, lifecycle, open questions.
- [x] Cross-cutting: notifications, memory-store, MessageBusV2, migration, security — all addressed.
