# v5 Technical Plan

**Author:** CTO
**Date:** 2026-03-27
**Status:** Finalized
**Prerequisites:** v4.9 deliverables (all complete)

---

## 1. Tech Stack Decisions

| Layer | v4 (Current) | v5 (Target) | Rationale |
|-------|-------------|-------------|-----------|
| **Runtime** | Node.js + TypeScript | Node.js 22 + TypeScript 5.6 | Stability. Node 22 LTS. No runtime change needed. |
| **Build** | tsc | Turborepo + tsc + Vite | Monorepo requires parallel builds. Turbo caching cuts CI by 60%+. |
| **Package Manager** | npm | pnpm | Strict hoisting. Faster installs. Workspace protocol. |
| **Server** | Express | Fastify | 2-3x throughput. Schema-based validation. Plugin system. TypeScript-first. |
| **Frontend** | Vanilla JS SPA | SvelteKit (Svelte 5) | See v49-2 eval. Compile-time reactivity. 60% smaller bundles. SSR. |
| **Database** | SQLite (single file) | SQLite per workspace + PostgreSQL option | Multi-workspace isolation. Same schema, adapter pattern. |
| **Real-time** | SSE | WebSocket (ws) | Bidirectional. Multiplexed channels. Better reconnect. |
| **Search** | None | @xenova/transformers + all-MiniLM-L6-v2 | Local-first embedding search. No API dependency. |
| **Icons** | Custom SVG | lucide-icons | 1400+ icons. Tree-shakeable. MIT. |
| **Testing** | Vitest | Vitest + Playwright | Add E2E testing for dashboard. |
| **Deployment** | npm start | Binary (pkg) + Docker + Helm | Multiple deployment targets for different user segments. |

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          AgentForge v5                               │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   CLI        │  │  Dashboard   │  │  REST API    │  │  WebSocket │ │
│  │  (@af/cli)   │  │  (SvelteKit) │  │  (Fastify)   │  │  (ws)      │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │                │        │
│  ───────┴─────────────────┴─────────────────┴────────────────┴─────  │
│                          API Gateway / Router                        │
│                    (auth, rate limit, workspace context)              │
│  ────────────────────────────────────────────────────────────────── │
│         │                 │                 │                │        │
│  ┌──────▼───────┐  ┌─────▼──────┐  ┌──────▼───────┐  ┌─────▼──────┐│
│  │  Agent Core   │  │  Message    │  │  Plugin      │  │  Embedding ││
│  │  (@af/core)   │  │  Bus        │  │  Runtime     │  │  Engine    ││
│  │               │  │             │  │              │  │            ││
│  │  - Protocol   │  │  - Pub/Sub  │  │  - Sandbox   │  │  - Index   ││
│  │  - Lifecycle  │  │  - Persist  │  │  - IPC       │  │  - Search  ││
│  │  - Routing    │  │  - Replay   │  │  - Manifest  │  │  - Model   ││
│  │  - Confidence │  │             │  │              │  │            ││
│  └──────┬───────┘  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘│
│         │                 │                 │                │        │
│  ───────┴─────────────────┴─────────────────┴────────────────┴─────  │
│                        Database Adapter (@af/db)                     │
│                  (SqliteAdapter | PostgresAdapter)                    │
│  ────────────────────────────────────────────────────────────────── │
│         │                                   │                        │
│  ┌──────▼───────┐                    ┌──────▼───────┐               │
│  │  Master DB    │                    │ Workspace DBs │               │
│  │  (auth,       │                    │ (one per      │               │
│  │   workspaces) │                    │  workspace)   │               │
│  └──────────────┘                    └──────────────┘               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Plugin Processes (sandboxed child_process.fork)               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │  │
│  │  │ Plugin A  │  │ Plugin B  │  │ Plugin C  │  │  ...     │      │  │
│  │  │ (IPC)     │  │ (IPC)     │  │ (IPC)     │  │          │      │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Build Sequence

The build sequence is ordered by dependency. Each phase has clear exit criteria before the next begins.

### Phase 1: Foundation (v5.0 sprint weeks 1-2)

**What:** The skeleton that everything else plugs into.

| Order | Item | Depends On | Exit Criteria |
|-------|------|------------|---------------|
| 1 | Monorepo scaffold | Nothing | All packages build. Turbo pipeline works. CI green. |
| 2 | Shared types | Monorepo | All TypeScript interfaces for agents, sessions, messages, events exported from @af/shared. |
| 3 | Database adapter | Shared types | SqliteAdapter passes all CRUD tests. Migration runner works. |
| 4 | Multi-workspace runtime | Database adapter | Create/switch/delete workspaces via code. Workspace-scoped queries work. |

**Why this order:** Everything depends on the monorepo. Types come before implementation. The database comes before anything that stores data.

### Phase 2: Core Infrastructure (v5.0 weeks 2-4)

| Order | Item | Depends On | Exit Criteria |
|-------|------|------------|---------------|
| 5 | Message bus | Shared types, DB adapter | Publish/subscribe works. Messages persisted. All 25+ types handled. |
| 6 | Agent protocol v2 | Message bus | Agent lifecycle state machine works. Tasks flow through bus. |
| 7 | REST API v5 | DB adapter, workspace runtime | All CRUD endpoints return real data. OpenAPI spec generated. |
| 8 | WebSocket server | REST API, message bus | Clients connect, subscribe to channels, receive live events. |

**Why this order:** The bus is the nervous system. Protocol rides on the bus. API exposes the data. WebSocket streams the bus events.

### Phase 3: Frontend & Intelligence (v5.0 weeks 3-5)

| Order | Item | Depends On | Exit Criteria |
|-------|------|------------|---------------|
| 9 | SvelteKit scaffold | REST API | App shell renders. Routing works. API client typed. |
| 10 | Design system (batch 1) | SvelteKit scaffold | 10 components in Storybook. Tokens applied. Dark/light mode. |
| 11 | Dashboard pages (batch 1) | Design system, REST API, WebSocket | 5 core pages render real data. Live updates via WebSocket. |
| 12 | Embedding search | DB adapter | Index/search works. <100ms over 10K docs. REST + CLI interface. |

### Phase 4: Extensibility & Autonomy (v5.0 weeks 4-6)

| Order | Item | Depends On | Exit Criteria |
|-------|------|------------|---------------|
| 13 | Plugin runtime | Message bus, REST API | Install/enable/disable plugins. IPC works. Sandbox enforced. |
| 14 | Self-proposal system | Agent protocol v2, message bus | Idle agents propose tasks. Auto-approval works. |
| 15 | Confidence routing | Agent protocol v2, DB adapter | Confidence scores update. Routing considers confidence. |
| 16 | Escalation protocol | Agent protocol v2, message bus | Escalation chain works. Timeout-based auto-escalation. |

### Phase 5: Enterprise & Polish (v5.0 weeks 5-7)

| Order | Item | Depends On | Exit Criteria |
|-------|------|------------|---------------|
| 17 | RBAC | REST API, DB adapter | 4 roles enforced. Permission checks on all endpoints. |
| 18 | Audit trail | DB adapter | All state changes logged. Viewer in dashboard. CSV export. |
| 19 | Design system (batch 2) | Batch 1 | All 20 components complete. |
| 20 | Deployment packaging | Everything | Docker image builds. Helm chart works. Binary runs. |
| 21 | v4 migration script | DB adapter, workspace runtime | Automated migration passes on v4.8 test data. |
| 22 | Test suite | Everything | 3000+ tests. CI passes. |

---

## 4. Team Assignments

| v5 Module | Owning Team | Lead Agent | Support Agents |
|-----------|-------------|------------|----------------|
| Monorepo + CI | DevOps | build-release-lead | ci-automation-engineer |
| Database adapter | Backend | enterprise-architect | backend-qa |
| Multi-workspace | Backend | platform-engineer | enterprise-architect |
| REST API v5 | Backend | api-gateway-engineer | api-specialist |
| WebSocket server | Backend | api-gateway-engineer | backend-qa |
| Message bus | Core | lead-architect | bus-unification-engineer, bus-integration-tester |
| Agent protocol v2 | Core | lead-architect | agent-protocol-researcher |
| Self-proposal | Core | lead-architect | agent-intelligence-lead |
| Confidence routing | Core | agent-intelligence-lead | budget-strategy-researcher |
| Escalation protocol | Core | lead-architect | agent-intelligence-lead |
| Embedding search | Core | rd-lead | benchmark-lead |
| SvelteKit scaffold | Frontend | v5-frontend-architect | ui-engineer |
| Design system | Frontend | experience-design-lead | interaction-designer |
| Dashboard pages | Frontend | v5-frontend-architect | dashboard-architect, data-viz-specialist |
| Plugin runtime | Backend | platform-engineer | plugin system needs new plugin-security-engineer |
| RBAC | Backend | enterprise-architect | api-gateway-engineer |
| Audit trail | Backend | observability-engineer | backend-qa |
| Deployment | DevOps | build-release-lead | ci-automation-engineer |
| Migration script | Backend | platform-engineer | enterprise-architect |
| Documentation | Documentation | v5-tech-writer | backend-tech-writer |
| Test suite | QA | backend-qa | frontend-qa, builder-domain-tester |

---

## 5. Risk Register

| # | Risk | Impact | Probability | Mitigation |
|---|------|--------|-------------|------------|
| 1 | **Svelte 5 ecosystem gaps.** We hit a component or library need that Svelte doesn't have (e.g., complex data grid, charting). | High — could block dashboard delivery | Medium | Build our own. We're already building a design system. For charting, use D3 (framework-agnostic). For data grids, build a Table component with sort/filter/paginate from scratch — it's 500 lines, not a framework. Fallback: embed React components via iframe or web components. |
| 2 | **Plugin sandboxing performance.** IPC overhead per plugin call makes plugins feel slow. Dashboard sections from plugins have noticeable latency. | Medium — degrades UX | Medium | Batch IPC calls. Cache plugin responses (TTL: 5s for dashboard data). Use SharedArrayBuffer for large data transfer if needed. Benchmark early: build one plugin in week 2 and measure. |
| 3 | **Multi-workspace migration breaks v4 data.** Edge cases in v4 data format (custom YAML fields, non-standard session data) cause migration failures. | High — blocks adoption | Medium | Build a comprehensive migration test suite using v4.3–v4.8 test data. Dry-run mode that reports issues without modifying data. Manual override for individual tables. Keep v4 backup intact — migration never modifies the original. |
| 4 | **Embedding model quality.** all-MiniLM-L6-v2 doesn't produce relevant search results for code patterns or technical agent feedback. | Medium — search feature underperforms | Low | Benchmark with real v4.8 data before committing. If quality is insufficient for code, use a code-specific model (e.g., `Xenova/codebert-base`) for code documents while keeping MiniLM for text. Hybrid BM25 + embedding search as fallback. |
| 5 | **Scope creep on v5.0.** 22 items across 5 phases is aggressive. Teams add features mid-sprint that weren't planned. | High — delays delivery | High | Hard scope lock after planning. P2 items can be deferred to v5.1. Weekly check-ins: if a P0 item is behind, a P2 item gets cut. CTO has authority to descope any P2 item without CEO approval. |

---

## 6. Breaking Changes: v4 to v5

| What Breaks | v4 Behavior | v5 Behavior | Migration |
|-------------|-------------|-------------|-----------|
| API namespace | `/api/v1/*` | `/api/v5/*` | Automated URL rewrite in migration. v4 clients must update. |
| Real-time protocol | SSE (`EventSource`) | WebSocket (`ws`) | Client code must switch from `EventSource` to `WebSocket`. |
| Database structure | Single `agentforge.db` | Master DB + workspace DBs | Automated migration script (`npx agentforge migrate`). |
| Config format | `models.yaml`, `delegation.yaml` separate files | Unified `agentforge.config.yaml` with workspace scope | Migration script merges configs. |
| Dashboard | Vanilla JS served by Express | SvelteKit app served by Fastify | Complete rebuild. No v4 custom JS carries forward. |
| Plugin system | None (hardcoded extensions) | Manifest-based plugin system | Custom extensions must be packaged as plugins. |
| Agent YAML schema | v4 fields | v4 fields + new optional fields (`capabilities`, `confidence`, `proposalRules`) | Forward-compatible. v4 YAMLs work in v5 unchanged. |
| CLI commands | `agentforge sprint`, `agentforge reports` | Namespaced: `agentforge workspace create`, `agentforge plugin install`, etc. | Old commands still work as aliases in v5.0. Deprecated in v5.1. |
| Session data | Flat sessions table | Sessions + messages tables (normalized) | Migration script normalizes. |

**Backwards compatibility commitment:** Agent YAML definitions are forward-compatible. A v4 YAML file will work in v5 without modification. This is non-negotiable — it's the primary interface for agent authors.

---

## 7. Timeline

| Sprint | Duration | Focus | Exit Gate |
|--------|----------|-------|-----------|
| **v5.0-alpha** | 2 weeks | Phase 1 + Phase 2 (foundation + core infra) | Monorepo builds. DB adapter works. Message bus works. API serves data. WebSocket streams events. |
| **v5.0-beta** | 2 weeks | Phase 3 + Phase 4 (frontend + extensibility) | SvelteKit dashboard renders 5 pages with real data. Plugin system installs and runs a plugin. Embedding search works. |
| **v5.0-rc** | 2 weeks | Phase 5 (enterprise + polish) | RBAC enforced. Audit trail works. Migration tested. Docker image builds. 3000+ tests pass. |
| **v5.0** | 1 week | Release prep | Documentation complete. CHANGELOG written. Version bumped to 0.5.0. Tagged and released. |

**Total: 7 weeks from v4.9 completion to v5.0 release.**

Aggressive but achievable because:
1. All architecture decisions are already made (v4.9 deliverables)
2. The team is 65 agents organized into 6 functional teams
3. Phases overlap — frontend starts in week 3 while backend continues
4. P2 items are descope-able without blocking the release

---

## 8. Definition of Done: v5.0

v5.0 ships when ALL of the following are true:

- [ ] Monorepo builds clean with `pnpm build` in <60 seconds (cached)
- [ ] Multi-workspace: create, list, switch, delete workspaces
- [ ] REST API: all v4 endpoints available at `/api/v5/` + workspace/plugin/search endpoints
- [ ] WebSocket: live events for sessions, agents, bus messages
- [ ] SvelteKit dashboard: all v4 sections rebuilt with design system
- [ ] Plugin system: install, enable, disable, uninstall via CLI
- [ ] Agent Protocol v2: all message types flowing through bus
- [ ] Embedding search: <100ms query over 10K documents
- [ ] RBAC: 4 roles enforced on API
- [ ] v4 → v5 migration: automated, lossless, tested against v4.3–v4.8
- [ ] 3000+ tests passing (up from 2372 in v4.8)
- [ ] Docker image builds and serves the full platform
- [ ] Documentation: API reference, plugin SDK guide, migration guide
- [ ] package.json version: 0.5.0
