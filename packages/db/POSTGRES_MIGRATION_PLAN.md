# PostgreSQL Migration Plan — `@agentforge/db`

**Status:** DRAFT — Requires human review and sign-off before implementation begins.  
**Risk level:** HIGH — Breaking infrastructure change.  
**Tags:** breaking, infrastructure, database, postgres, P1  
**Author:** Coder agent (autonomous sprint)  
**Date:** 2026-04-08

---

## 1. Motivation

The current `WorkspaceAdapter` and `WorkspaceRegistry` are backed by `better-sqlite3`
(per-workspace SQLite files in `.agentforge/v5/`). PostgreSQL is needed to support:

- **Concurrent write workloads** — SQLite WAL mode still serializes writes; PG handles
  true concurrent transactions.
- **Connection pooling** — Multiple server processes / serverless deployments share a
  single PG instance rather than competing over file locks.
- **Managed hosting** — Cloud PG (Supabase, Neon, RDS) provides backups, HA, and
  point-in-time recovery out of the box.
- **JSONB & full-text search** — Future sprint items (semantic search, scorecard
  dashboards) benefit from PG-native index types.
- **`pgvector`** — The `embeddings` table currently stores `Float32Array` as a raw
  `BLOB`. `pgvector` replaces this with a proper `vector` column type and enables
  approximate nearest-neighbour search.

---

## 2. Scope

### Files that change

| File | Change |
|------|--------|
| `packages/db/src/workspace-adapter.ts` | Rewrite: `better-sqlite3` → `pg` pool; all methods become `async` |
| `packages/db/src/workspace-registry.ts` | Rewrite: same driver swap; all methods become `async` |
| `packages/db/src/schema.ts` | Replace SQLite DDL with PostgreSQL DDL |
| `packages/db/package.json` | Add `pg` + `@types/pg`; remove `better-sqlite3` |

### Files that cascade (callers)

Every consumer of `WorkspaceAdapter` or `WorkspaceRegistry` must `await` the newly
async methods. Known callers:

- `packages/server/src/routes/v5/workspaces.ts`
- `packages/server/src/routes/v5/multi-workspace.ts`
- `packages/cli/src/commands/workspaces.ts`
- `packages/core/src/autonomous/workspace-registry.ts`
- `packages/core/src/multi-workspace/workspace-aggregator.ts`
- `tests/v5/db-workspace.test.ts` — all helper calls become `await`
- `tests/autonomous/integration/workspaces-api.test.ts`
- `tests/autonomous/unit/workspace-registry.test.ts`

---

## 3. Schema translation

### 3.1 Type mapping

| SQLite type | PostgreSQL type | Notes |
|-------------|-----------------|-------|
| `TEXT` | `TEXT` | Compatible |
| `INTEGER` | `INTEGER` | Compatible |
| `REAL` | `DOUBLE PRECISION` | Or `NUMERIC(18,8)` for cost columns |
| `BLOB` | `BYTEA` | Used for raw embedding vectors |
| `datetime('now')` default | `NOW()` | Timestamp default function |
| `ON CONFLICT ... DO UPDATE` | `ON CONFLICT ... DO UPDATE SET` | UPSERT syntax is identical |

**`embeddings.vector` column** — if `pgvector` extension is available, replace `BYTEA`
with `vector(1536)` (or the correct dimension for the embedding model in use). This is
optional for the initial migration; a follow-up can add the index.

### 3.2 PostgreSQL DDL (master schema)

```sql
-- agentforge_master schema

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  owner_id    TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id      TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  key_hash     TEXT UNIQUE NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  label        TEXT,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);
```

### 3.3 PostgreSQL DDL (workspace schema)

**Note:** In PostgreSQL the current per-file SQLite model (`workspace-<slug>.db`) maps
to either (a) separate schemas within one database (`CREATE SCHEMA workspace_<slug>`)
or (b) a single `workspace_id` column discriminator in shared tables. Option (b) is
recommended for operational simplicity and is assumed below.

```sql
-- All workspace tables gain a workspace_id discriminator column.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  parent_session_id TEXT REFERENCES sessions(id),
  task              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'running',
  model             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  delegation_depth  INTEGER NOT NULL DEFAULT 0,
  autonomy_tier     INTEGER NOT NULL DEFAULT 1,
  resume_count      INTEGER NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS costs (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,
  agent_id     TEXT NOT NULL,
  model        TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,
  agent_id     TEXT NOT NULL,
  category     TEXT NOT NULL,
  message      TEXT NOT NULL,
  sentiment    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id             TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  previous_tier  INTEGER NOT NULL,
  new_tier       INTEGER NOT NULL,
  promoted       INTEGER NOT NULL DEFAULT 0,
  demoted        INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS agent_scorecards (
  id                 TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  total_sessions     INTEGER NOT NULL DEFAULT 0,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  failed_sessions    INTEGER NOT NULL DEFAULT 0,
  total_cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_latency_ms   BIGINT NOT NULL DEFAULT 0,
  last_updated       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, workspace_id),
  UNIQUE (workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS kv_store (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  content      TEXT NOT NULL,
  vector       BYTEA NOT NULL,          -- upgrade to vector(N) with pgvector
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, workspace_id),
  UNIQUE (workspace_id, source_type, source_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_agent  ON sessions(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_status ON sessions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_started          ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_costs_workspace_agent     ON costs(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_costs_created             ON costs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_workspace_agent  ON feedback(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_scorecards_workspace_agent ON agent_scorecards(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_source         ON embeddings(workspace_id, source_type, source_id);
```

---

## 4. API / driver change

### 4.1 Driver selection

Recommended: **`postgres`** (a.k.a. `postgres.js`) — zero-dependency, tagged-template
SQL, TypeScript-native. Alternative: **`pg`** + `pg-pool` (battle-tested, more options).

```jsonc
// packages/db/package.json (after migration)
{
  "dependencies": {
    "@agentforge/shared": "workspace:*",
    "postgres": "^3.4.5"        // replaces better-sqlite3
  }
}
```

### 4.2 Synchronous → async API impact

Every `WorkspaceAdapter` method changes signature:

```ts
// BEFORE (synchronous)
createSession(data: {...}): SessionRow

// AFTER (async)
createSession(data: {...}): Promise<SessionRow>
```

This cascades to every caller. The `async` keyword must be threaded upward through
route handlers, CLI commands, and aggregator methods. Callers using the adapter in
`beforeEach` test hooks must become async too.

### 4.3 Parameterised queries

`better-sqlite3` uses positional `?` placeholders.  
`postgres.js` uses tagged templates; `pg` uses `$1 $2 ...` positional params.

All SQL strings in `workspace-adapter.ts` must be rewritten for the chosen driver.

### 4.4 Connection management

The current SQLite adapter owns a single database connection per instance. PostgreSQL
requires a connection pool:

```ts
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, {
  max: 10,               // pool size
  idle_timeout: 30,      // seconds
  connect_timeout: 10,
});
```

The pool should be created once at application startup and injected into `WorkspaceAdapter`
rather than constructed internally. This avoids pool exhaustion when many adapter
instances are created.

### 4.5 Transaction semantics

`better-sqlite3` supports synchronous transactions via `db.transaction(fn)()`. PostgreSQL
transactions are async:

```ts
await sql.begin(async (tx) => {
  await tx`INSERT INTO ...`;
  await tx`UPDATE ...`;
});
```

Any method that currently relies on SQLite's synchronous transaction API must be
rewritten with an async transaction block.

---

## 5. Data migration strategy

### 5.1 Recommended approach: Dual-write with backfill

1. **Phase 1 — Deploy new schema to PostgreSQL.** No traffic change.
2. **Phase 2 — Enable dual-write.** All writes go to both SQLite and PG. Reads still
   come from SQLite.
3. **Phase 3 — Backfill.** Export existing SQLite data and import to PG.
4. **Phase 4 — Switch reads to PG.** Monitor for query plan issues / missing indexes.
5. **Phase 5 — Remove dual-write.** SQLite files become read-only archives.
6. **Phase 6 — Remove SQLite dependency** (`better-sqlite3`) from package.

### 5.2 One-shot migration script (simpler, higher risk)

For lower-traffic deployments, a simpler approach:

1. Take the server offline (maintenance window).
2. Run the export script: dump all SQLite tables to JSON.
3. Run the import script: insert JSON into PostgreSQL with the new schema.
4. Restart server pointing at PostgreSQL.
5. Verify with smoke tests.
6. Keep SQLite files as backup for 30 days.

### 5.3 Migration script skeleton

A migration script should be created at `scripts/migrate-sqlite-to-pg.ts`:

```ts
// Pseudocode — not yet implemented
import Database from 'better-sqlite3';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

for (const workspaceSlug of listWorkspaceSlugs()) {
  const sqlite = new Database(`.agentforge/v5/workspace-${workspaceSlug}.db`);

  // Export sessions
  const sessions = sqlite.prepare('SELECT * FROM sessions').all();
  for (const s of sessions) {
    await sql`INSERT INTO sessions ${sql({ ...s, workspace_id: workspaceSlug })}
              ON CONFLICT DO NOTHING`;
  }

  // Repeat for costs, promotions, scorecards, kv_store, embeddings ...
  sqlite.close();
}

await sql.end();
```

---

## 6. Environment configuration

A new environment variable is required:

```
DATABASE_URL=postgresql://user:password@host:5432/agentforge
```

The application startup code must validate this variable before accepting traffic.
`packages/db/src/workspace-adapter.ts` should throw a clear error if `DATABASE_URL` is
not set when the adapter is constructed in PG mode.

---

## 7. Test strategy

### 7.1 Unit tests

- All existing tests in `tests/v5/db-workspace.test.ts` must pass with PG driver.
- Use `testcontainers` (or a `pg` connection to a local test DB) instead of `:memory:`.
- An in-memory equivalent does not exist for PostgreSQL; tests must use a real (or
  Docker-based) PG instance.
- Add `DATABASE_URL` to CI environment (GitHub Actions service container).

### 7.2 CI changes

`.github/workflows/` will need a PostgreSQL service container:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_DB: agentforge_test
      POSTGRES_USER: agentforge
      POSTGRES_PASSWORD: test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

### 7.3 Regression checklist

- [ ] Session CRUD round-trips
- [ ] Cost recording and aggregation
- [ ] Promotion recording with promoted/demoted flags
- [ ] KV store upsert (idempotency)
- [ ] Embedding store/retrieve with BYTEA round-trip
- [ ] Agent scorecard accumulation
- [ ] Workspace registry CRUD
- [ ] Connection pool exhaustion under load
- [ ] Graceful shutdown (pool `end()` called)

---

## 8. Rollback plan

- Keep `better-sqlite3` in the dependency tree until Phase 5 is complete.
- Use a feature flag (`WORKSPACE_BACKEND=sqlite|postgres`) to toggle the active
  driver at runtime. This allows instant rollback without redeployment.
- SQLite `.db` files must not be deleted until 30 days post-cutover and after a
  successful backup has been verified.

---

## 9. Open questions (require human decision)

1. **Schema design**: Single shared-table model with `workspace_id` column, or
   per-workspace PostgreSQL schemas (`CREATE SCHEMA workspace_<slug>`)?  
   _Trade-off: shared tables are operationally simpler; per-schema isolation maps
   more directly to the current SQLite model and enables row-level security._

2. **Driver**: `postgres.js` vs `pg`?  
   _`postgres.js` has a cleaner API but less ecosystem tooling; `pg` has broader
   adoption and better Knex/Prisma compatibility if an ORM is considered later._

3. **pgvector**: Should the `embeddings.vector` column be migrated to `vector(N)` in
   this sprint, or deferred?  
   _Doing it now avoids a second migration, but requires knowing the embedding
   dimension used by the model._

4. **Migration window**: Is a maintenance window acceptable, or is zero-downtime
   (dual-write) required?

5. **CI database**: Should tests run against a real PostgreSQL Docker container, or
   should `pg-mem` (in-memory PG emulator) be used for speed?  
   _`pg-mem` does not support all PG features (e.g., `BYTEA` aggregates, some window
   functions); it may need patching._

---

## 10. Acceptance criteria (for the implementation sprint)

- [ ] `WorkspaceAdapter` and `WorkspaceRegistry` use `postgres.js` (or `pg`), no
  `better-sqlite3` import.
- [ ] All methods are `async`; TypeScript compiles cleanly.
- [ ] All existing tests pass against a real PostgreSQL instance.
- [ ] CI GitHub Actions workflow includes a PG service container.
- [ ] `DATABASE_URL` is documented in `README` / deployment docs.
- [ ] A data migration script exists at `scripts/migrate-sqlite-to-pg.ts`.
- [ ] The feature flag `WORKSPACE_BACKEND` allows fallback to SQLite during
  the transition window.
- [ ] This document is updated to "Status: IMPLEMENTED" and the open questions
  are resolved.

---

## 11. Estimated effort

| Task | Estimate |
|------|----------|
| Schema DDL translation | 2 h |
| `WorkspaceAdapter` rewrite (async + PG) | 4 h |
| `WorkspaceRegistry` rewrite | 2 h |
| Caller async cascade (server + CLI + core) | 4 h |
| Test suite update (async, PG container) | 3 h |
| CI workflow update | 1 h |
| Data migration script | 3 h |
| QA / smoke testing | 2 h |
| **Total** | **~21 h** |

---

_This document must be reviewed and all Open Questions (§9) answered before
implementation begins. Do not merge or deploy any code from this migration without
explicit approval._
