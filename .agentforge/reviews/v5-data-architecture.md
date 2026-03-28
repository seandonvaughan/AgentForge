# v5 Multi-Tenant Data Architecture

**Author:** enterprise-architect
**Sprint:** v4.9 (item v49-4)
**Date:** 2026-03-27
**Status:** Complete

---

## 1. Architecture Overview

AgentForge v5 uses a **database-per-workspace** isolation model. Each workspace gets its own SQLite file (self-hosted) or PostgreSQL schema (cloud). A master database stores workspace metadata and authentication.

```
                    ┌─────────────────────┐
                    │   Master Database    │
                    │  (agentforge.db)     │
                    │                      │
                    │  - workspaces        │
                    │  - users             │
                    │  - user_workspaces   │
                    │  - api_keys          │
                    │  - global_config     │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐ ┌──────▼────────┐ ┌─────▼─────────┐
    │ workspace-abc  │ │ workspace-def │ │ workspace-ghi │
    │    .db         │ │    .db        │ │    .db        │
    │                │ │               │ │               │
    │ - agents       │ │ - agents      │ │ - agents      │
    │ - sessions     │ │ - sessions    │ │ - sessions    │
    │ - messages     │ │ - messages    │ │ - messages    │
    │ - delegations  │ │ - delegations │ │ - delegations │
    │ - sprints      │ │ - sprints     │ │ - sprints     │
    │ - sprint_items │ │ - sprint_items│ │ - sprint_items│
    │ - feedback     │ │ - feedback    │ │ - feedback    │
    │ - memory       │ │ - memory      │ │ - memory      │
    │ - embeddings   │ │ - embeddings  │ │ - embeddings  │
    │ - events       │ │ - events      │ │ - events      │
    │ - audit_log    │ │ - audit_log   │ │ - audit_log   │
    │ - plugins      │ │ - plugins     │ │ - plugins     │
    │ - _migrations  │ │ - _migrations │ │ - _migrations │
    └────────────────┘ └───────────────┘ └───────────────┘
```

**Why database-per-workspace (not row-level isolation):**
1. **No cross-contamination risk.** A query bug cannot return another workspace's data. Isolation is physical, not logical.
2. **Simple backup/restore.** Copy one file to back up a workspace. No selective export queries.
3. **Performance isolation.** One workspace's heavy query load doesn't affect others. No shared connection pool contention.
4. **Easy deletion.** Delete workspace = delete file. No orphan row cleanup.
5. **Portable.** A user can download their workspace DB and run it locally.

---

## 2. Master Database Schema

```sql
-- Master database: agentforge.db
-- Stores cross-workspace metadata only

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,          -- UUID v7
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,      -- URL-safe, used in DB filename
    description     TEXT,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    settings_json   TEXT DEFAULT '{}',         -- workspace-level config
    db_path         TEXT NOT NULL,             -- relative path to workspace DB
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    archived_at     TEXT                       -- soft delete
);

CREATE TABLE users (
    id              TEXT PRIMARY KEY,          -- UUID v7
    email           TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT,                      -- null for SSO users
    auth_provider   TEXT DEFAULT 'local',      -- local | github | google
    auth_provider_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_login_at   TEXT
);

CREATE TABLE user_workspaces (
    user_id         TEXT NOT NULL REFERENCES users(id),
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    role            TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by      TEXT REFERENCES users(id),
    joined_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE api_keys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    workspace_id    TEXT REFERENCES workspaces(id),  -- null = all workspaces
    key_hash        TEXT NOT NULL UNIQUE,             -- SHA-256 of the key
    name            TEXT NOT NULL,
    scopes          TEXT NOT NULL DEFAULT '["read"]', -- JSON array
    last_used_at    TEXT,
    expires_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE global_config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes
CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE INDEX idx_user_workspaces_workspace ON user_workspaces(workspace_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);
```

---

## 3. Workspace Database Schema

```sql
-- Workspace database: workspace-{slug}.db
-- All tables are workspace-scoped by construction (one DB per workspace)

CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    model           TEXT NOT NULL,              -- opus-4, sonnet-4, haiku-3
    team            TEXT,
    role            TEXT,                        -- agent's role description
    autonomy_tier   INTEGER DEFAULT 1,          -- 1-5
    capabilities    TEXT DEFAULT '[]',           -- JSON array of capability strings
    yaml_hash       TEXT,                        -- SHA-256 of source YAML
    config_json     TEXT DEFAULT '{}',           -- parsed YAML as JSON
    active          INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    parent_session_id TEXT REFERENCES sessions(id),  -- delegation chain
    status          TEXT NOT NULL DEFAULT 'running'
                    CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
    task            TEXT,                        -- task description
    result          TEXT,                        -- completion result summary
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cost_usd        REAL DEFAULT 0.0,
    model_used      TEXT,
    duration_ms     INTEGER,
    error           TEXT,                        -- error message if failed
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at    TEXT
);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    role            TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content         TEXT NOT NULL,
    token_count     INTEGER DEFAULT 0,
    tool_name       TEXT,                       -- if role='tool'
    tool_input      TEXT,                       -- JSON
    tool_output     TEXT,                       -- JSON
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE delegations (
    id              TEXT PRIMARY KEY,
    from_agent_id   TEXT NOT NULL REFERENCES agents(id),
    to_agent_id     TEXT NOT NULL REFERENCES agents(id),
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    child_session_id TEXT REFERENCES sessions(id),
    task            TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'accepted', 'completed', 'failed', 'rejected')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at     TEXT
);

CREATE TABLE sprints (
    id              TEXT PRIMARY KEY,
    version         TEXT NOT NULL,
    title           TEXT NOT NULL,
    phase           TEXT NOT NULL DEFAULT 'planning'
                    CHECK(phase IN ('planning', 'active', 'complete', 'cancelled')),
    budget          REAL,
    team_size       INTEGER,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at    TEXT
);

CREATE TABLE sprint_items (
    id              TEXT PRIMARY KEY,
    sprint_id       TEXT NOT NULL REFERENCES sprints(id),
    title           TEXT NOT NULL,
    description     TEXT,
    priority        TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2')),
    assignee        TEXT,                       -- agent name
    team            TEXT,
    status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK(status IN ('planned', 'in-progress', 'completed', 'blocked', 'cancelled')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at    TEXT
);

CREATE TABLE feedback (
    id              TEXT PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id),
    agent_id        TEXT REFERENCES agents(id),
    type            TEXT NOT NULL CHECK(type IN ('praise', 'correction', 'suggestion', 'escalation', 'reforge')),
    content         TEXT NOT NULL,
    source          TEXT,                       -- who gave the feedback
    severity        TEXT DEFAULT 'normal' CHECK(severity IN ('low', 'normal', 'high', 'critical')),
    resolved        INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE memory (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(id), -- null = workspace-level memory
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    type            TEXT DEFAULT 'text' CHECK(type IN ('text', 'json', 'code')),
    ttl_seconds     INTEGER,                    -- null = permanent
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(agent_id, key)
);

CREATE TABLE embeddings (
    id              TEXT PRIMARY KEY,
    source_type     TEXT NOT NULL CHECK(source_type IN ('session', 'feedback', 'memory', 'sprint', 'code')),
    source_id       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,               -- SHA-256 of source content
    vector          BLOB NOT NULL,               -- Float32Array (384 dims = 1536 bytes)
    content_preview TEXT,                         -- first 200 chars for display
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(source_type, source_id)
);

CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,               -- e.g., 'session.started', 'delegation.created'
    agent_id        TEXT,
    session_id      TEXT,
    payload_json    TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_log (
    id              TEXT PRIMARY KEY,
    user_id         TEXT,                        -- null for system actions
    action          TEXT NOT NULL,               -- e.g., 'agent.created', 'session.started'
    resource_type   TEXT NOT NULL,               -- e.g., 'agent', 'session', 'plugin'
    resource_id     TEXT,
    details_json    TEXT DEFAULT '{}',
    ip_address      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE plugins (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    version         TEXT NOT NULL,
    manifest_json   TEXT NOT NULL,               -- full plugin manifest
    enabled         INTEGER DEFAULT 1,
    config_json     TEXT DEFAULT '{}',            -- user-configured settings
    installed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE _migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- === Indexes ===
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created ON sessions(created_at);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_delegations_from ON delegations(from_agent_id);
CREATE INDEX idx_delegations_to ON delegations(to_agent_id);
CREATE INDEX idx_delegations_session ON delegations(session_id);
CREATE INDEX idx_sprint_items_sprint ON sprint_items(sprint_id);
CREATE INDEX idx_feedback_session ON feedback(session_id);
CREATE INDEX idx_feedback_agent ON feedback(agent_id);
CREATE INDEX idx_memory_agent ON memory(agent_id);
CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
```

---

## 4. Migration Strategy: v4 to v5

### 4.1 Current v4 State

v4 uses a single `agentforge.db` SQLite file with tables: sessions, messages, delegations, events, feedback, memory, sprints. Agent definitions live in YAML files. No user/workspace concept.

### 4.2 Migration Steps

```
npx agentforge migrate
```

1. **Backup.** Copy `agentforge.db` to `agentforge.db.v4-backup`.
2. **Create master DB.** Initialize `agentforge-master.db` with schema above.
3. **Create default user.** Insert a "local" user (email: `local@agentforge.dev`). This becomes the owner.
4. **Create default workspace.** Name it after the current project directory. Slug from directory name.
5. **Copy v4 DB.** Copy `agentforge.db` to `workspace-{slug}.db`.
6. **Schema transform.** Run ALTER TABLE statements to add missing columns (e.g., `agents.capabilities`, `sessions.model_used`). Create new tables that didn't exist in v4 (`audit_log`, `plugins`, `embeddings`, `_migrations`).
7. **Import agents from YAML.** Scan `.agentforge/agents/*.yaml`, insert into `agents` table with YAML hash.
8. **Import sprints from JSON.** Parse `.agentforge/sprints/*.json`, insert into `sprints` and `sprint_items` tables.
9. **Validate.** Run integrity checks: row counts match, foreign keys valid, no orphan records.
10. **Write migration report.** Output summary: tables migrated, rows per table, warnings.

### 4.3 Rollback

If migration fails at any step:
- Delete new DB files
- Restore from backup
- Report error with step number and details
- User can retry after fixing the issue

### 4.4 Zero-downtime for v4

The migration does not modify the original v4 DB. It copies and transforms. The v4 installation continues to work until the user explicitly switches to v5 by running the v5 server.

---

## 5. Query Patterns

### 5.1 Workspace-Scoped Adapter

All database access goes through a `WorkspaceDb` adapter class:

```typescript
class WorkspaceDb {
  private db: BetterSqlite3.Database;
  private workspaceId: string;

  constructor(workspaceId: string) {
    const workspace = masterDb.getWorkspace(workspaceId);
    this.db = new Database(workspace.dbPath, { readonly: false });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.workspaceId = workspaceId;
  }

  // All queries are automatically workspace-scoped because the DB itself is scoped
  getSessions(opts: { status?: string; limit?: number; offset?: number }) {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: any[] = [];
    if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(opts.limit ?? 20, opts.offset ?? 0);
    return this.db.prepare(sql).all(...params);
  }

  // ... similar for all tables
}
```

**Key property:** There is no `workspace_id` column in workspace tables. The isolation is at the file level. A developer cannot accidentally write a cross-workspace query because there is no other workspace data in the file.

### 5.2 Cross-Workspace Analytics (Master DB)

For admin dashboards that show aggregate metrics:

```typescript
class AnalyticsDb {
  // Attach workspace DBs temporarily for cross-workspace queries
  getGlobalStats(): GlobalStats {
    const workspaces = masterDb.getAllWorkspaces();
    const stats = workspaces.map(ws => {
      const db = new Database(ws.dbPath, { readonly: true });
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agents) as agent_count,
          (SELECT COUNT(*) FROM sessions) as session_count,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions) as total_cost
      `).get();
      db.close();
      return { workspaceId: ws.id, ...counts };
    });
    return aggregateStats(stats);
  }
}
```

---

## 6. Backup and Restore

### 6.1 Per-Workspace Export

```bash
agentforge workspace export my-project --output ./my-project-backup.db
# Copies the workspace DB file + associated YAML files into a tarball
```

Export includes:
- Workspace SQLite DB file
- Agent YAML definitions
- Plugin configurations
- Workspace settings

### 6.2 Import

```bash
agentforge workspace import ./my-project-backup.db --name "Restored Project"
# Creates a new workspace from the backup
```

### 6.3 Clone

```bash
agentforge workspace clone my-project --name "My Project Copy"
# Copies workspace DB, generates new IDs, registers as new workspace
```

### 6.4 Automated Backups

Self-hosted: optional cron job that copies workspace DB files to a backup directory. Configurable retention (7 days default).

Cloud: PostgreSQL `pg_dump` per-schema, stored in S3, 30-day retention.

---

## 7. PostgreSQL Compatibility Layer

For cloud deployments, the same schema runs on PostgreSQL with these differences:

| SQLite | PostgreSQL |
|--------|------------|
| `TEXT PRIMARY KEY` (UUID) | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `INTEGER` for booleans | `BOOLEAN` |
| `REAL` | `DOUBLE PRECISION` |
| `BLOB` for vectors | `BYTEA` |
| `strftime(...)` | `NOW()` |
| One file per workspace | One schema per workspace |
| WAL mode | Standard MVCC |

The `@agentforge/db` package exports a `DatabaseAdapter` interface:

```typescript
interface DatabaseAdapter {
  getAgent(id: string): Agent | null;
  listAgents(opts?: ListOpts): Agent[];
  createSession(data: CreateSession): Session;
  // ... full CRUD for all tables
  transaction<T>(fn: () => T): T;
  close(): void;
}
```

Both `SqliteAdapter` and `PostgresAdapter` implement this interface. Application code never calls SQLite or PostgreSQL directly — it uses the adapter. Switching backends is a config change.
