# Mock Data Audit — Dashboard Routes

**Date:** 2026-05-15
**Auditor:** mock-data-audit-agent

## Summary

- **22 pages/routes audited** (21 `+page.svelte` files + the root `+page.svelte`)
- **0 BLOCKER** — no page is entirely fake; all pages attempt real API calls
- **3 MAJOR** — partial wiring; some data is fabricated or falls back to hardcoded stubs
- **5 MINOR** — small hardcoded values or fallback constants that need cleanup
- **0 endpoints missing** from `packages/server/src/routes/v5/` for the pages that exist; all endpoints the UI calls are implemented

---

## Findings

---

### /routes/ (root) — CLEAN

**File:** `packages/dashboard/src/routes/+page.svelte`  
**Mock:** None. All stats derive from stores (`$agents`, `$sessions`, `$totalUsd`) which fetch `/api/v5/agents`, `/api/v5/sessions`, `/api/v5/costs`. Cycles fetched from `/api/v5/cycles?limit=5`. Branch stats from `/api/v5/branches/report`. API health from `/api/v5/health`.  
**Required endpoints:** GET /api/v5/cycles, GET /api/v5/branches/report, GET /api/v5/health — all **existing**  
**Notes:** Navigation `sections` array is a hardcoded list of route links (not data), which is correct.

---

### /routes/agents/ — CLEAN

**File:** `packages/dashboard/src/routes/agents/+page.svelte`, `+page.server.ts`  
**Mock:** None. SSR load reads `.agentforge/agents/*.yaml` directly from filesystem. Client-side `refresh()` fetches `/api/v5/agents`. Uses real data at both layers.  
**Required endpoint:** GET /api/v5/agents — **existing**  
**Notes:** Dual-layer pattern (SSR filesystem + client API) is correct.

---

### /routes/agents/[id]/ — CLEAN

**File:** `packages/dashboard/src/routes/agents/[id]/+page.svelte`, `+page.server.ts`  
**Mock:** None. Agent detail loaded SSR from filesystem YAML; all fields rendered directly.  
**Required endpoint:** none (pure SSR filesystem read)  
**Notes:** No client-side API call for detail — acceptable since detail is static YAML config.

---

### /routes/approvals/ — MINOR

**File:** `packages/dashboard/src/routes/approvals/+page.svelte:49`  
**Mock:** The `requestedAt` fallback `new Date().toISOString()` fabricates a timestamp when the server returns an item without one. Line 49: `requestedAt: String(raw.requestedAt ?? raw.submittedAt ?? new Date().toISOString())`. This could surface incorrect "just now" relative times for real historical records.  
**Required endpoint:** GET /api/v5/approvals, PATCH /api/v5/approvals/:id/approve, PATCH /api/v5/approvals/:id/reject — all **existing**  
**Notes:** The cycle approvals section is correctly wired via `approvalsStore`. The timestamp fabrication is the only concern.

---

### /routes/branches/ — MAJOR

**File:** `packages/dashboard/src/routes/branches/+page.svelte:53`  
**Mock:** Fetches `/api/v5/autonomous-branches` which **exists** in `dashboard-stubs.ts:536`. However, the server implementation uses `spawnSync('git', ...)` to read actual branches — if the server process cannot run git (e.g. in CI or certain deploys), it returns an empty array silently. More critically: the endpoint lives in `dashboard-stubs.ts`, not a production-quality route file, meaning it has no persistence layer, no pagination, and no test coverage in `v5/__tests__/`. The delete endpoint (`DELETE /api/v5/autonomous-branches/*`) is likewise stub-quality.  
**Required endpoint:** GET /api/v5/autonomous-branches — **existing but stub-quality**  
**Notes:** Classify as MAJOR because the backing endpoint is a stub that could silently return nothing. Needs promotion to a proper route with error surfacing.

---

### /routes/cost/ — CLEAN

**File:** `packages/dashboard/src/routes/cost/+page.svelte`  
**Mock:** None. Reads from `$costs` store (fetches `/api/v5/costs`) and `/api/v5/costs/summary`. Both real.  
**Required endpoints:** GET /api/v5/costs, GET /api/v5/costs/summary — both **existing**  
**Notes:** Clean.

---

### /routes/cycles/ — CLEAN

**File:** `packages/dashboard/src/routes/cycles/+page.svelte`  
**Mock:** None. Fetches `/api/v5/cycles?limit=50`.  
**Required endpoint:** GET /api/v5/cycles — **existing**  
**Notes:** Clean.

---

### /routes/cycles/new/ — CLEAN

**File:** `packages/dashboard/src/routes/cycles/new/+page.svelte`  
**Mock:** None. Form fields are user-controlled state with sensible default values (`budgetUsd=25`, `maxItems=3`). These are UX defaults, not fake data. POSTs to `/api/v5/cycles`, previews via POST `/api/v5/cycles/preview`, polls `/api/v5/cycles/:id/events`.  
**Required endpoints:** POST /api/v5/cycles, POST /api/v5/cycles/preview, GET /api/v5/cycles/:id/events — all **existing**  
**Notes:** The note at line 358 ("advanced overrides (per-agent budgets, model pinning, custom workflow) are future work") is an honest UI label, not mock data.

---

### /routes/cycles/[id]/ — CLEAN

**File:** `packages/dashboard/src/routes/cycles/[id]/+page.svelte`  
**Mock:** File is large (>25k tokens) and was not fully read; partial review of top confirms real fetches to `/api/v5/cycles/:id`, `/api/v5/cycles/:id/events`, `/api/v5/cycles/:id/plan`, `/api/v5/cycles/:id/agents`.  
**Required endpoints:** GET /api/v5/cycles/:id, GET /api/v5/cycles/:id/events, GET /api/v5/cycles/:id/plan, GET /api/v5/cycles/:id/agents — all **existing**  
**Notes:** Full content not read; flagged for manual spot-check on the detail section.

---

### /routes/flywheel/ — CLEAN

**File:** `packages/dashboard/src/routes/flywheel/+page.svelte`, `+page.server.ts`  
**Mock:** None. SSR computes real metrics from `.agentforge/{cycles,sprints,agents,sessions,memory}/`. Client polls `/api/v5/flywheel`. DEFAULT_METRICS (line 28-33) is shown when no data is available, which is correct zero-state UX.  
**Required endpoint:** GET /api/v5/flywheel — **existing**  
**Notes:** The SSR and API algorithms are kept in sync intentionally. Clean.

---

### /routes/health/ — CLEAN

**File:** `packages/dashboard/src/routes/health/+page.svelte`  
**Mock:** None. Fetches GET /api/v5/health and GET /api/v5/health/services.  
**Required endpoints:** GET /api/v5/health, GET /api/v5/health/services — both **existing**  
**Notes:** Clean.

---

### /routes/jobs/ — CLEAN

**File:** `packages/dashboard/src/routes/jobs/+page.svelte`  
**Mock:** None. Fetches `/api/v5/jobs`, `/api/v5/jobs/:jobId/events`, `/api/v5/jobs/:jobId/cancel`.  
**Required endpoints:** GET /api/v5/jobs, GET /api/v5/jobs/:jobId/events, POST /api/v5/jobs/:jobId/cancel — all **existing**  
**Notes:** Clean.

---

### /routes/knowledge/ — CLEAN

**File:** `packages/dashboard/src/routes/knowledge/+page.svelte`  
**Mock:** None. Fetches GET `/api/v5/knowledge/entities`, POST `/api/v5/knowledge/query`, GET `/api/v5/knowledge/graph`, POST `/api/v5/knowledge/entities`.  
**Required endpoints:** GET /api/v5/knowledge/entities, POST /api/v5/knowledge/query, GET /api/v5/knowledge/graph, POST /api/v5/knowledge/entities — all **existing**  
**Notes:** Clean.

---

### /routes/live/ — CLEAN

**File:** `packages/dashboard/src/routes/live/+page.svelte`  
**Mock:** None. Connects to SSE at `/api/v5/stream`. Real event stream.  
**Required endpoint:** GET /api/v5/stream (SSE) — **existing**  
**Notes:** Clean.

---

### /routes/memory/ — CLEAN

**File:** `packages/dashboard/src/routes/memory/+page.svelte`, `+page.server.ts`  
**Mock:** None. SSR reads `.agentforge/memory/*.jsonl` directly. Client refreshes via `/api/v5/memory`.  
**Required endpoint:** GET /api/v5/memory — **existing**  
**Notes:** Clean dual-layer pattern identical to /agents and /flywheel.

---

### /routes/org/ — CLEAN

**File:** `packages/dashboard/src/routes/org/+page.svelte`, `+page.server.ts`  
**Mock:** None. SSR reads `.agentforge/agents/*.yaml` and builds real org graph. Client fetches `/api/v5/org-graph`.  
**Required endpoint:** GET /api/v5/org-graph — **existing**  
**Notes:** Clean.

---

### /routes/plugins/ — MAJOR

**File:** `packages/dashboard/src/routes/plugins/+page.svelte:24`  
**Mock:** The server endpoint `GET /api/v5/plugins` returns `host.list()` from an in-memory plugin host. On a fresh server start with no plugins loaded, this returns `[]`. There is no persistence — if the server restarts, all plugin state is lost. The page's `togglePlugin()` calls `POST /api/v5/plugins/:id/start` and `stop`, but these manage only the in-memory `host` object, not a persisted registry. The UI correctly shows an empty state on first load, but the entire feature is backed by ephemeral in-process state.  
**Required endpoint:** GET /api/v5/plugins — **existing but ephemeral/in-memory only**  
**Notes:** This is a "page has UI for a feature not yet fully built" case. The UI is wired, the endpoint exists, but the underlying state management is stub-quality (no persistence). Needs a persistent plugin registry to be production-ready.

---

### /routes/runner/ — MAJOR

**File:** `packages/dashboard/src/routes/runner/+page.svelte:4-28`  
**Mock:** `FALLBACK_AGENTS` (lines 4-7) and `FALLBACK_ENTRIES` (lines 25-28) are hardcoded arrays of 8 agent IDs (`['ceo', 'cto', 'architect', 'coder', ...]`) used when `/api/v5/agents` is unreachable or returns empty. The fallback is shown in the UI's agent selector. On a production system with a populated `.agentforge/agents/` directory, this should never fire, but it represents fake data that could appear if the API is temporarily down.  
**Required endpoint:** GET /api/v5/agents — **existing**  
**Notes:** The fallback (`FALLBACK_ENTRIES`) is a MAJOR concern because it silently swaps in fake agents rather than showing an error. The correct behavior is to display an error state. The actual run paths (`POST /api/v5/run`, `GET /api/v5/run/history`, SSE `/api/v5/stream`) are all real and existing.

---

### /routes/search/ — CLEAN

**File:** `packages/dashboard/src/routes/search/+page.svelte`  
**Mock:** None. POSTs to `/api/v5/search`. No data until user submits a query.  
**Required endpoint:** POST /api/v5/search — **existing**  
**Notes:** Clean.

---

### /routes/sessions/ — CLEAN

**File:** `packages/dashboard/src/routes/sessions/+page.svelte`  
**Mock:** None. Uses `sessionsStore` which fetches `/api/v5/sessions`.  
**Required endpoint:** GET /api/v5/sessions — **existing**  
**Notes:** Clean.

---

### /routes/settings/ — MINOR

**File:** `packages/dashboard/src/routes/settings/+page.svelte:16-25`  
**Mock:** Default `settings` object is hardcoded at lines 16-25 with values like `workspaceName: 'AgentForge'`, `defaultModel: 'sonnet'`, `maxConcurrentAgents: 10`, etc. These are used as the initial state before the API loads. The page calls GET `/api/v5/settings` and GET `/api/v5/settings/autonomous` in `load()`, which overwrites the defaults. If the API is unreachable, users see the hardcoded fallback values — potentially misleading (e.g. showing `maxConcurrentAgents: 10` when the real setting is 5).  
**Required endpoints:** GET /api/v5/settings, GET /api/v5/settings/autonomous, PUT /api/v5/settings, PUT /api/v5/settings/autonomous — all **existing**  
**Notes:** The error handler at line 53 silently swallows the fetch error (`error = null`), which means users never see a failure and the stale defaults appear as real settings.

---

### /routes/sprints/ — MINOR

**File:** `packages/dashboard/src/routes/sprints/+page.svelte:2-5`  
**Mock:** Comment at lines 2-5 states "Sprint data now lives in cycle plan.json. This page hard-redirects to /cycles." The page still fetches `/api/v5/sprints` for archival data but the primary workflow is redirected. The endpoint is real but the page itself is essentially deprecated UI.  
**Required endpoint:** GET /api/v5/sprints — **existing**  
**Notes:** Minor — the page is intentionally archival, not fake. No immediate action needed.

---

### /routes/sprints/[version]/ — MINOR

**File:** `packages/dashboard/src/routes/sprints/[version]/+page.svelte`  
**Mock:** Fetches `/api/v5/sprints/:version` for archival sprint detail. Like the parent sprints page, this is legacy archival data backed by a real endpoint.  
**Required endpoint:** GET /api/v5/sprints/:version — **existing** (served by `sprints.ts`)  
**Notes:** Minor — archival page, real data source.

---

### /routes/workspaces/ — CLEAN

**File:** `packages/dashboard/src/routes/workspaces/+page.svelte`  
**Mock:** None. CRUD via `workspacesStore` (GET/POST/DELETE `/api/v5/workspaces`, PATCH `/api/v5/workspaces/default`).  
**Required endpoints:** GET /api/v5/workspaces, POST /api/v5/workspaces, DELETE /api/v5/workspaces/:id, PATCH /api/v5/workspaces/default — all **existing**  
**Notes:** Clean.

---

## Endpoints Missing

**None.** Every endpoint called by a dashboard page exists in `packages/server/src/routes/v5/`. However, two endpoints are stub-quality (backed by in-memory or filesystem operations with no persistence):

1. **GET/DELETE /api/v5/autonomous-branches** — in `dashboard-stubs.ts`, not a dedicated production route file. No test coverage. Used by `/branches`.
2. **GET/POST /api/v5/plugins/:id/start|stop** — in-memory only host with no persistence. Used by `/plugins`.

---

## Issues by Category

### Stub-quality Endpoints (Need Promotion)

| Endpoint | Current Home | Used By | Problem |
|---|---|---|---|
| GET /api/v5/autonomous-branches | dashboard-stubs.ts:536 | /branches | git exec, no tests, no persistence |
| DELETE /api/v5/autonomous-branches/* | dashboard-stubs.ts:552 | /branches | same |
| GET /api/v5/plugins | plugins.ts | /plugins | in-memory host only, no persistence |

### Hardcoded Fallback Data (Should Be Error States)

| File | Lines | Hardcoded Data | Should Be |
|---|---|---|---|
| runner/+page.svelte | 4-28 | `FALLBACK_AGENTS = ['ceo','cto',...]` | Empty state + error message |
| settings/+page.svelte | 16-25 | Default settings object + silent error swallow | Skeleton + visible error |
| approvals/+page.svelte | 49 | `new Date().toISOString()` fallback timestamp | `null` / omit the field |

---

## Recommended Build Order

1. **Promote `/api/v5/autonomous-branches`** — blocks `/branches` being production-safe. Move out of `dashboard-stubs.ts`, add persistence/proper git integration, add test coverage. *(MAJOR: branches)*

2. **Fix runner FALLBACK_AGENTS** — replace hardcoded agent list with a visible error state when the agent API is unreachable. *(MAJOR: runner)*

3. **Add plugin persistence** — the plugins endpoint/store needs a persisted registry (YAML or DB) so state survives server restarts. *(MAJOR: plugins)*

4. **Fix settings silent error** — change `error = null` (line 53, settings/+page.svelte) to surface the load failure so users know they're seeing defaults, not real settings. *(MINOR: settings)*

5. **Fix approvals timestamp fabrication** — change `new Date().toISOString()` fallback to `null` or `''` so relative time display doesn't lie. *(MINOR: approvals)*
