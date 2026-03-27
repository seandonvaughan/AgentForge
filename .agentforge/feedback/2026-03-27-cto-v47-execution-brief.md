# CTO Execution Brief — AgentForge v4.7

**Date:** 2026-03-27
**Sprint:** v4.7 — Audit-Driven Dashboard: Data First, UI Second
**Budget:** $900 | **Team:** ~40 agents (3 new hires)

---

## Executive Summary

v4.7 is a data-first sprint. The investor directive is unambiguous: build the persistent audit log backend before touching any dashboard UI. We are restructuring the entire data layer from scattered JSON/Markdown files to a unified SQLite database, standing up a real HTTP API, and only then rebuilding the dashboard as a proper SPA with real data.

Everything that currently shows hardcoded or stale data gets either fixed with real data or removed entirely. No middle ground.

---

## Team Assignments and Sequencing

### Phase 1 — Data Foundation (MUST complete before any UI work)

| Item | Owner | Co-Owner | Depends On |
|------|-------|----------|------------|
| P0-1: Unified SQLite schema | dba | architect | — |
| P0-2: SqliteAdapter | coder | — | P0-1 |
| P0-3: EventCollector middleware | architect | coder | P0-2 |
| P0-4: Fastify server scaffold | api-gateway-engineer | — | — |
| P0-5: REST API endpoints | api-gateway-engineer | coder | P0-2 |
| P0-6: SSE endpoint | api-gateway-engineer | — | P0-3 |
| P0-7: Delegation chain model | architect | — | P0-1 |
| P0-8: Autonomy tier persistence | coder | — | P0-1 |

**Critical path:** P0-1 -> P0-2 -> P0-3 -> P0-6
**Parallel track:** P0-4 starts immediately (no dependencies), P0-7 and P0-8 start after P0-1.

The api-gateway-engineer can scaffold the server (P0-4) immediately while dba + architect design the schema. Once the adapter lands, API endpoints wire up to real data.

### Phase 2 — Audit Log + Core UI (starts ONLY after Phase 1 gate passes)

| Item | Owner | Co-Owner |
|------|-------|----------|
| P1-1: Audit Log page /runs | ui-engineer | dashboard-architect |
| P1-2: Session Detail /runs/:id | ui-engineer | — |
| P1-3: SPA routing | ui-engineer | — |
| P1-4: SSE client integration | ui-engineer | frontend-dev |
| P1-5: Empty states + skeletons | ui-engineer | — |
| P1-6: Cost anomaly detection | observability-engineer | — |

The ui-engineer is the linchpin of Phase 2. dashboard-architect provides specs, frontend-dev assists on SSE client work. observability-engineer works independently on anomaly detection.

### Phase 3 — Profiles + Intelligence

| Item | Owner | Co-Owner |
|------|-------|----------|
| P2-1: Agent Profile /agents/:id | ui-engineer | — |
| P2-2: Command Center / | ui-engineer | dashboard-architect |
| P2-3: Cost Analytics /cost | ui-engineer | — |
| P2-4: Data Analyst first queries | data-analyst | — |
| P2-5: npm start script | coder | — |
| P2-6: JSON->SQLite migration | dba | — |
| P2-7: Version bump | project-manager | — |

---

## Phase Gate: What Must Pass Before Phase 2 Starts

Phase 2 is BLOCKED until ALL of the following are true:

1. SQLite database operational with unified schema (sessions, feedback, task_outcomes, promotions, agent_costs, agent_autonomy tables)
2. SqliteAdapter passes all interface tests that the existing file adapters pass
3. EventCollector is writing real-time events to SQLite (verified by running 3+ agent sessions and checking rows exist)
4. REST API returns real session data at /api/v1/sessions and /api/v1/sessions/:id
5. SSE endpoint /api/v1/stream broadcasts at least session-started and session-completed events
6. Minimum 100 new tests passing for the data layer (schema, adapter, collector, API, SSE)

**Gate owner:** architect (reviews technical quality), project-manager (tracks completion)

---

## The 3 New Hires and Why

### 1. data-analyst (Sonnet) — reports to CFO
**Why:** We are building a serious audit database but have no agent that can query it. Leadership asks questions like "what did we spend last week" or "which agents fail the most" and today the answer requires manual investigation. The data-analyst provides self-service analytics over the new SQLite layer. Read-only, safety-first.

### 2. api-gateway-engineer (Sonnet) — reports to engineering-manager-backend
**Why:** v4.7 introduces a real HTTP API for the first time. Fastify routing, SSE channel management, API versioning, request validation, and CORS are a full-time concern. Overloading the general coder with API surface ownership leads to inconsistent contracts and broken frontend integrations. This agent owns the API as a product.

### 3. ui-engineer (Sonnet) — reports to engineering-manager-frontend
**Why:** BLOCKING for all frontend work. The existing frontend-dev handles general markup and content updates but is not equipped for a component-system-level SPA buildout with client-side routing, SSE integration, SVG data visualization, and a formal CSS architecture. The ui-engineer is the implementation engine for all 5 dashboard pages.

---

## Top Risks with Mitigations

### 1. SQLite Concurrent Write Contention
**Risk:** 20+ parallel agents writing audit events simultaneously could cause SQLITE_BUSY errors.
**Mitigation:** Enable WAL (Write-Ahead Logging) mode from day 1. Implement connection pooling in SqliteAdapter. Load test with 20 concurrent writers during Phase 1 before the gate review.
**Owner:** dba

### 2. SSE Backpressure Under High Event Volume
**Risk:** If the dashboard client cannot consume events fast enough, the server-side buffer grows unbounded and eventually crashes.
**Mitigation:** Cap client buffer at 100 events, drop oldest when exceeded. Implement heartbeat-based health checking. Load test with 20 concurrent agent sessions before Phase 2 gate.
**Owner:** api-gateway-engineer

### 3. Data Migration Integrity
**Risk:** Existing session JSON files may have inconsistent schemas across sprint versions. The migration script could silently lose data.
**Mitigation:** Dry-run mode that reports what would be migrated without writing. Skip malformed entries with warnings (never fail silently). Idempotent — safe to re-run. Manual review of migration report before marking complete.
**Owner:** dba

### 4. SPA Routing vs. Static File Serving
**Risk:** Client-side routes like /runs/abc123 will 404 if Fastify tries to serve them as static files.
**Mitigation:** Catch-all route in Fastify returns index.html for any non-/api/ path. Test deep links (direct URL load) early in Phase 2.
**Owner:** api-gateway-engineer

### 5. Scope Creep from Deferred Pages
**Risk:** Stakeholders may push to include Sprint Tracker, Org Graph, or other deferred pages once the SPA framework is in place.
**Mitigation:** Explicitly deferred list is in the sprint JSON. Any additions require CTO approval and budget reallocation. The 5-page scope is final for v4.7.
**Owner:** cto

---

## v4.6 Retrospective — CTO Lens

### What the tech strategy missed in v4.6:

1. **Data layer was an afterthought.** We expanded the org chart to 55 agents and built management layers, but never unified the data model. Sessions are JSON files, feedback is Markdown, flywheel scores are in-memory. The dashboard had no reliable data source, so it showed hardcoded values. v4.7 corrects this by making the audit database the foundation, not an add-on.

2. **No HTTP API existed.** The dashboard was a static HTML file reading JSON files directly. There was no server, no API, no real-time data flow. This made it impossible to build any interactive feature (filtering, pagination, drill-down). v4.7 introduces a proper Fastify backend.

3. **Frontend agent gap.** We had frontend-dev and dashboard-architect but no dedicated UI implementation specialist. The dashboard-architect designed pages but had to also build them, leading to specs that outpaced implementation capacity. The ui-engineer hire fills this gap.

4. **Polling instead of events.** The dashboard used setInterval polling with "Refreshing in 5s" messages. This is fundamentally wrong for an event-driven system that already has an EventBus. v4.7 uses SSE end-to-end.

5. **Stale sprint data across versions.** Dashboard sections referenced different sprint versions with hardcoded items. There was no single source of truth. The unified audit database and the decision to remove all fake data (defer 9 pages to v4.8) solves this permanently.

6. **R&D recommendations were correct but unbounded.** Embedding search and vector databases are valuable but premature. We do not yet have the audit data to embed. v4.7 defers the BM25 vs. embedding experiment to v4.8, after the SQLite foundation exists.

### What v4.6 got right:

- The organizational expansion (management layer, engineering sub-teams) gave us the structure to execute a sprint this complex. We have the managers to coordinate Phase 1/2/3 sequencing.
- The feedback protocol creates the raw data that the new audit database will ingest.
- Model routing awareness (Opus for strategy, Sonnet for implementation) is well-established and the 3 new hires correctly use Sonnet.

---

## Deferred to v4.8

The following are explicitly OUT OF SCOPE for v4.7. They will be addressed once the 5-page SPA with real data is stable:

- Sprint Tracker page
- Review Pipeline page
- Meeting Schedule page
- Autonomy Tiers page
- Capability Matrix page
- Flywheel gauges
- Bus Monitor page
- Org Graph page
- Session Timeline page
- BM25 vs. embedding retrieval experiment
- Vector database evaluation

---

## Sign-Off

This brief authorizes the engineering team to begin v4.7 execution. Phase 1 starts immediately. No UI work until the Phase 1 gate passes.

**CTO — AgentForge v4.7**
