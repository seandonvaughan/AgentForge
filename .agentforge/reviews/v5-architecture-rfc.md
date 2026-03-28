# RFC: AgentForge v5 Platform Architecture

**RFC ID:** v5-arch-001
**Author:** CTO (enterprise-architect)
**Status:** Accepted
**Created:** 2026-03-27
**Sprint:** v4.9

---

## Summary

AgentForge v5 is a ground-up platform evolution from a single-user CLI tool to a multi-workspace, plugin-extensible agent orchestration platform. This RFC defines the system architecture, runtime boundaries, data model, deployment topology, and migration path from v4.

The core thesis: v5 treats agent teams as first-class infrastructure. Workspaces isolate projects. Plugins extend capabilities. The protocol enables autonomous agent behavior at scale.

---

## Motivation

v4.x proved the concept: 129 agents, 6 teams, 2372 tests, a data-driven dashboard, and real autonomous delegation. But v4 has structural limits:

1. **Single workspace.** One SQLite DB, one project context. Users with multiple repos must run separate instances.
2. **No plugin system.** Every agent, dashboard section, and integration is hardcoded. Third-party extensibility is impossible.
3. **Monolithic frontend.** The vanilla JS SPA works but cannot scale to enterprise UI requirements (WCAG, i18n, theming, component reuse).
4. **No RBAC.** Anyone with server access is admin. Enterprise customers need role-based access, audit trails, and SSO.
5. **Agent protocol is implicit.** Agent communication happens through delegation YAML and session context. There is no typed, versioned message protocol.

v5 addresses all five constraints while preserving the core philosophy: agents are employees, not tools.

---

## Design

### 1. Repository Structure: Monorepo with Packages

```
agentforge/
├── packages/
│   ├── core/              # Agent runtime, message bus, protocol
│   ├── server/            # REST + WebSocket API server
│   ├── dashboard/         # SvelteKit frontend
│   ├── cli/               # CLI interface (@agentforge/cli)
│   ├── db/                # Database adapters (SQLite, PostgreSQL)
│   ├── plugins-sdk/       # Plugin development SDK
│   ├── embeddings/        # Embedding search engine
│   └── shared/            # Shared types, utils, constants
├── plugins/               # First-party plugins
│   ├── plugin-github/
│   ├── plugin-slack/
│   └── plugin-analytics/
├── .agentforge/           # Runtime data (agent YAMLs, sessions, sprints)
├── migrations/            # Database migration scripts
├── turbo.json             # Turborepo config
└── package.json           # Root workspace
```

**Why monorepo:** Shared TypeScript types across all packages. Atomic version bumps. Single CI pipeline. Turborepo for parallel builds with caching.

**Package manager:** pnpm workspaces. Strict hoisting. Lockfile integrity.

### 2. Multi-Workspace Architecture

Every project gets its own workspace. A workspace is an isolated execution context:

```
Master DB (agentforge-master.db)
├── workspaces table: id, name, slug, created_at, owner_id, settings_json
├── users table: id, email, role, created_at
├── user_workspaces table: user_id, workspace_id, role
└── api_keys table: id, user_id, key_hash, scopes, created_at

Workspace DB (workspace-{slug}.db)  — one per workspace
├── agents table: id, name, model, team, yaml_hash, created_at
├── sessions table: id, agent_id, parent_session_id, status, cost, created_at
├── messages table: id, session_id, role, content, token_count, created_at
├── delegations table: id, from_agent_id, to_agent_id, session_id, created_at
├── sprints table: id, version, title, phase, created_at
├── sprint_items table: id, sprint_id, title, priority, assignee, status
├── feedback table: id, session_id, agent_id, type, content, created_at
├── memory table: id, agent_id, key, value, created_at
├── embeddings table: id, source_type, source_id, vector BLOB, content_hash
├── events table: id, type, payload_json, created_at
├── audit_log table: id, user_id, action, resource, details_json, created_at
└── plugins table: id, name, version, enabled, config_json, installed_at
```

**Isolation model:** Workspace DBs are completely independent files. No cross-workspace joins. The master DB only stores workspace metadata and auth. This means:
- Backup = copy the .db file
- Clone workspace = copy file + update master registry
- Delete workspace = delete file + remove from registry
- No data leakage between workspaces by construction

### 3. Plugin System

Plugins are the primary extensibility mechanism. A plugin is a directory with a `plugin-manifest.json` that declares what it provides and what it needs.

**Capabilities a plugin can provide:**
- Custom agents (YAML definitions bundled with the plugin)
- Dashboard sections (Svelte components rendered in the dashboard)
- Webhook handlers (react to agent events)
- CLI commands (add `/slash-commands` to the CLI)
- API routes (mounted under `/api/v5/plugins/:pluginId/`)
- Message bus subscribers (react to typed agent messages)

**Sandboxing model:**
- Plugins run in a forked child process (Node.js `child_process.fork`)
- Communication via structured IPC messages (JSON-RPC 2.0)
- Plugins cannot access the host filesystem directly; they get a scoped virtual FS
- Plugin process has a memory limit (256MB default, configurable)
- Plugin process has a timeout (30s per operation, configurable)
- Plugin permissions are declared in manifest and approved at install time

**Plugin lifecycle:**
1. `agentforge plugin install ./path-or-npm-name` — validates manifest, copies to plugins dir, registers in workspace DB
2. On server start, enabled plugins are forked as child processes
3. Plugin receives `INIT` message with its config and workspace context
4. Plugin registers its routes, commands, event handlers via IPC
5. On shutdown, plugin receives `SHUTDOWN` message, has 5s to clean up
6. On crash, plugin is restarted up to 3 times, then disabled with error logged

### 4. Agent Protocol v2 (Message Bus)

All agent communication flows through a typed message bus. Every message has:

```typescript
interface AgentMessage {
  id: string;                    // UUID v7 (time-sortable)
  type: MessageType;             // Enum: see v49-6 for full taxonomy
  from: AgentId;                 // Sender agent ID
  to: AgentId | TeamId | 'bus'; // Recipient (agent, team, or broadcast)
  workspaceId: string;           // Workspace scope
  sessionId?: string;            // Optional session context
  payload: Record<string, unknown>; // Type-specific payload
  timestamp: string;             // ISO 8601
  version: '2.0';                // Protocol version
}
```

**Message delivery:** In-process pub/sub for local deployment. Redis Streams for multi-node cloud deployment. Messages are persisted to the `events` table for replay and audit.

**Key difference from v4:** In v4, delegation is a function call. In v5, delegation is a message. This means agents can communicate asynchronously, messages can be queued, and the entire communication history is auditable.

### 5. Storage Layer

**Primary:** SQLite via `better-sqlite3`. One file per workspace. WAL mode for concurrent reads. Synchronous writes for data integrity.

**Cloud option:** PostgreSQL via the same query interface. The `@agentforge/db` package exports a `DatabaseAdapter` interface. SQLite and PostgreSQL adapters implement it identically. Schema is 1:1 — same tables, same columns, same indexes. Workspace isolation in PostgreSQL uses schema-per-workspace (`CREATE SCHEMA workspace_abc123`).

**Migration system:** Versioned SQL migration files in `migrations/`. Each migration has `up.sql` and `down.sql`. Migrations run automatically on server start. Migration state tracked in a `_migrations` table in each DB.

### 6. Deployment Models

**Self-hosted (single binary):**
- `npx agentforge` or downloadable binary via `pkg`
- Bundles server, dashboard, CLI
- SQLite storage, no external dependencies
- Target audience: individual developers, small teams

**Docker:**
- `docker run -p 3000:3000 -v ./data:/data agentforge/agentforge:5.0`
- Same as self-hosted but containerized
- Docker Compose template with optional PostgreSQL, Redis
- Target audience: teams with container infrastructure

**Kubernetes operator:**
- `AgentForge` CRD that defines a workspace cluster
- Operator manages PostgreSQL connections, Redis for message bus, horizontal scaling
- Helm chart for easy deployment
- Target audience: enterprise platform teams

**Cloud-managed SaaS:**
- Multi-tenant hosted version at app.agentforge.dev
- Workspace isolation via PostgreSQL schemas
- Managed auth (Clerk or Auth.js), managed billing
- Target audience: teams that want zero-ops

### 7. API Layer

**REST API:** Versioned under `/api/v5/`. JSON request/response. Standard envelope:
```json
{
  "data": { ... },
  "meta": { "total": 100, "page": 1, "pageSize": 20 },
  "error": null
}
```

**WebSocket:** Replaces SSE from v4. Single connection per client at `ws://host/api/v5/ws`. Multiplexed channels:
- `workspace:{id}:events` — all workspace events
- `session:{id}:messages` — live session output
- `agent:{id}:status` — agent state changes

**Authentication:** Bearer token (API key) for programmatic access. Session cookie for dashboard. JWT with short expiry (15m) + refresh token.

**Rate limiting:** Per-API-key, per-workspace. Default: 1000 req/min for REST, 100 msg/sec for WebSocket.

### 8. Frontend: SvelteKit

**Decision:** SvelteKit with server-side rendering. See v49-2 for full evaluation. Key reasons:
- Smallest bundle size (40% smaller than React equivalent)
- Fine-grained reactivity without VDOM overhead
- Built-in SSR with streaming
- TypeScript-first with excellent DX
- Runes (Svelte 5) provide React-like explicitness without React's complexity

**Architecture:**
```
dashboard/
├── src/
│   ├── routes/               # SvelteKit file-based routing
│   │   ├── +layout.svelte    # App shell (sidebar, topbar)
│   │   ├── +page.svelte      # Dashboard home
│   │   ├── agents/
│   │   ├── sessions/
│   │   ├── cost/
│   │   ├── sprints/
│   │   ├── org/
│   │   ├── plugins/
│   │   └── settings/
│   ├── lib/
│   │   ├── components/       # Design system components
│   │   ├── stores/           # Svelte stores (reactive state)
│   │   ├── api/              # API client (typed, auto-generated from OpenAPI)
│   │   └── utils/
│   └── app.css               # Design tokens, global styles
├── static/                   # Static assets
└── svelte.config.js
```

### 9. Security Model

**RBAC roles:**
| Role | Scope | Permissions |
|------|-------|-------------|
| owner | workspace | Full control, delete workspace, manage billing |
| admin | workspace | Manage agents, plugins, settings. Cannot delete workspace. |
| member | workspace | Run agents, view dashboard, create sessions |
| viewer | workspace | Read-only dashboard access |
| plugin | sandboxed | Only declared permissions from manifest |

**Agent capability scoping:** Each agent declares its capabilities in YAML. The runtime enforces:
- File access: read/write to workspace directory only
- Network: no outbound requests unless explicitly allowed
- Cost: per-session budget cap, enforced at token counting layer
- Delegation: can only delegate to agents in the same workspace

**Secret management:** Secrets stored encrypted in workspace DB (AES-256-GCM). Decryption key derived from workspace master key. Secrets exposed to agents via `$SECRET_NAME` in YAML templates, resolved at runtime, never logged.

### 10. Migration: v4 to v5

**Automated migration script:** `npx agentforge migrate`

Steps:
1. Detect v4 installation (check for `.agentforge/` directory and `agentforge.db`)
2. Create v5 master DB, create default workspace from v4 data
3. Copy v4 SQLite tables into workspace DB with schema transforms
4. Migrate `.agentforge/agents/*.yaml` into workspace agent registry
5. Migrate `.agentforge/sprints/*.json` into workspace sprint tables
6. Migrate `.agentforge/feedback/` into workspace feedback table
7. Generate v5 config from v4 `models.yaml` and `delegation.yaml`
8. Validate: run integrity checks on migrated data
9. Output migration report with item counts and any warnings

**Breaking changes:**
- Config file format changes (YAML → YAML but restructured)
- API namespace changes (`/api/v1/` → `/api/v5/`)
- SSE replaced by WebSocket
- Dashboard is now SvelteKit (custom vanilla JS sections will not carry over)
- Plugin manifest required for any custom extensions

**Backwards compatibility:** v4 agent YAMLs are forward-compatible. The YAML schema is additive — new fields are optional, old fields still work.

---

## Alternatives Considered

### Alternative A: Incremental v4 Evolution
Keep extending v4 with new features. Rejected because v4's single-workspace model and lack of plugin system are structural limits that cannot be patched incrementally.

### Alternative B: Full Rewrite in Rust
Rewrite the core runtime in Rust for performance. Rejected because the bottleneck is LLM API latency (seconds), not runtime performance (milliseconds). TypeScript's ecosystem, hiring pool, and plugin DX are more valuable.

### Alternative C: Microservices Architecture
Separate services for agents, sessions, plugins, auth. Rejected because it adds deployment complexity without benefit at current scale. The monorepo with packages provides the same code isolation without the operational overhead. Can extract services later if needed.

### Alternative D: React Frontend
React has the largest ecosystem. Rejected because Svelte 5 delivers better performance, smaller bundles, and simpler code for our use case (data dashboards with real-time updates). See v49-2 for full evaluation.

---

## Drawbacks

1. **Migration effort.** v4 → v5 migration must handle every v4 data format. Missed edge cases will cause data loss. Mitigation: comprehensive migration test suite, dry-run mode, backup before migration.

2. **Svelte ecosystem is smaller.** Fewer component libraries than React. Mitigation: build our own design system (v49-3), which we need regardless. Use headless UI patterns.

3. **Plugin sandboxing adds latency.** IPC between host and plugin process adds ~1-5ms per call. Mitigation: batch IPC calls, cache plugin responses, use shared memory for large data.

4. **Multi-workspace adds operational complexity.** More DB files to manage, backup, monitor. Mitigation: workspace management CLI commands, automated backup cron, health checks.

---

## Unresolved Questions

1. **Should plugins be able to define their own DB tables?** Current design says no — plugins use a key-value store. But some plugins may need relational data. Defer to v5.1.

2. **WebSocket scaling.** Single-node WebSocket is simple. Multi-node requires sticky sessions or a pub/sub backend (Redis). Design the abstraction now, implement Redis adapter in v5.1.

3. **Billing model for SaaS.** Per-workspace? Per-agent? Per-session? This is a product decision, not a technical one. The architecture supports any model via the audit_log table.

4. **Agent hot-reload.** Can agent YAMLs be updated without restarting the server? v4 reads YAML on every session start. v5 should cache but support invalidation. Needs design.

5. **Embedding model upgrades.** We start with `all-MiniLM-L6-v2` but better models will come. Need a re-index strategy that doesn't block the server.
