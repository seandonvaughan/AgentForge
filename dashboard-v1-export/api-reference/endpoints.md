# API Reference — Dashboard Endpoints

All endpoints are on the Fastify API server (port 4750 in development, proxied via `/api/v5/` in the SvelteKit Vite config). The base path is `/api/v5` unless noted.

## Global / Cross-page

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/health` | GET | Home (`/`), Health (`/health`), version store | Server health check; also returns `version` string used in topbar |
| `/api/v5/health/services` | GET | Health (`/health`) | Per-service health breakdown (deeper diagnostics) |
| `/api/v5/stream` | SSE EventSource | Live (`/live`), Cycle detail, Runner, approvals store | Real-time event bus; unnamed events with JSON payload |
| `/api/v5/workspaces` | GET | Workspace store (global) | List workspaces; default workspace ID extracted for `?workspaceId=` param injection |
| `/api/v5/workspaces` | POST | Workspaces (`/workspaces`) | Create workspace |
| `/api/v5/workspaces/{id}` | PATCH | Workspaces (`/workspaces`) | Update workspace name/config |
| `/api/v5/workspaces/default` | POST | Workspaces (`/workspaces`) | Set default workspace |
| `ws://127.0.0.1:4750/api/v5/ws` | WebSocket | ws store (global, topbar indicator) | WebSocket bus — connection status shown in topbar |

## Cycles

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/cycles?limit=50` | GET | Cycles list (`/cycles`), Home | Paginated cycle list; accepts `?workspaceId=` |
| `/api/v5/cycles` | POST | Launch form (`/cycles/new`) | Create + launch a new cycle |
| `/api/v5/cycles/preview` | POST | Launch form (`/cycles/new`) | Dry-run preview before launching |
| `/api/v5/cycles/{id}` | GET | Cycle detail (`/cycles/[id]`), Launch form | Single cycle record (status, stage, cost, version, etc.) |
| `/api/v5/cycles/{id}/sprint` | GET | Cycle detail — Items tab | Sprint item list for the cycle (planned/in-progress/completed/failed) |
| `/api/v5/cycles/{id}/agents` | GET | Cycle detail — Agents tab | All agent invocations within the cycle |
| `/api/v5/cycles/{id}/scoring` | GET | Cycle detail — Scoring tab | Scoring metrics (quality, velocity, cost-efficiency, etc.) |
| `/api/v5/cycles/{id}/events?since={seq}` | GET | Cycle detail — Events tab, Launch form | Historical event list since a sequence number |
| `/api/v5/cycles/{id}/phases/{phase}` | GET | Cycle detail — Phases tab | Phase detail data (expanded on demand per-phase) |
| `/api/v5/cycles/{id}/files/{name}` | GET | Cycle detail — Files tab | Raw file content by filename |
| `/api/v5/cycles/{id}/logs/{name}` | GET | Cycle detail — Logs tab | Log file content (structured batch) |
| `/api/v5/cycles/{id}/logs/{name}/stream` | SSE EventSource | Cycle detail — Logs tab (tail mode) | Live log streaming (SSE tail) |
| `/api/v5/cycles/{id}/plan` | GET | Cycle detail — Overview tab | Sprint plan markdown text (lazy-loaded) |
| `/api/v5/cycles/{id}/approval` | GET | Approvals store | Fetch pending approval for a cycle |
| `/api/v5/cycles/{id}/approval` | POST | ApprovalModal component | Submit approval decision (`approveAll` or `approvedItemIds`/`rejectedItemIds`) |

## Agents

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/agents` | GET | Agents (`/agents`), Runner (`/runner`) | List all registered agents with metadata |

## Sessions

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/cycle-sessions` | GET | Approvals store | List cycles with active sessions; used to detect `hasApprovalPending` |

## Cost

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/costs/summary` | GET | Cost Analytics (`/cost`) | Cost breakdown by model tier and time period |

## Flywheel / Intelligence

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/flywheel` | GET | Flywheel (`/flywheel`), flywheel server load | Flywheel metrics (meta-learning rate, autonomy score, capability inheritance, velocity) |
| `/api/v5/search` | POST | Search (`/search`) | Semantic search across cycles, agents, events |
| `/api/v5/memory` | GET | Memory (`/memory`) | Paginated memory entries; accepts filter params |
| `/api/v5/memory/stream` | GET | Memory (`/memory`) | Memory entries as a stream (NDJSON) |
| `/api/v5/memory/{id}` | DELETE | Memory (`/memory`) | Delete a memory entry |
| `/api/v1/stream` | SSE EventSource | Memory (`/memory`) | Legacy v1 event stream (used alongside v5 in memory page) |
| `/api/v5/org-graph` | GET | Org (`/org`) | Org graph nodes + edges for agent delegation hierarchy |
| `/api/v5/knowledge/graph` | GET | Knowledge (`/knowledge`) | Knowledge graph entities and relationships |
| `/api/v5/knowledge/entities` | GET | Knowledge (`/knowledge`) | List knowledge entities (unfiltered) |
| `/api/v5/knowledge/entities` | POST | Knowledge (`/knowledge`) | Create/upsert knowledge entity |
| `/api/v5/knowledge/query` | POST | Knowledge (`/knowledge`) | Semantic query against knowledge base |

## Branches

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/autonomous-branches` | GET | Branches (`/branches`) | List autonomous git branches with status |
| `/api/v5/autonomous-branches/{name}` | PATCH | Branches (`/branches`) | Update branch metadata / trigger action |
| `/api/v5/autonomous-branches/{name}` | DELETE | Branches (`/branches`) | Delete/archive a branch |

## Approvals

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/approvals?status={filter}` | GET | Approvals (`/approvals`) | List approvals filtered by status |
| `/api/v5/approvals/{id}/{action}` | POST | Approvals (`/approvals`) | Approve or reject an approval item |

## Sprints

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/sprints` | GET | Sprints (`/sprints`) | List historical sprints |
| `/api/v5/sprints/{version}` | GET | Sprint detail (`/sprints/[version]`) | Single sprint record and associated cycles |

## Jobs

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/jobs` | GET | Jobs (`/jobs`) | List jobs with optional filters (status, type, cursor) |
| `/api/v5/jobs/{jobId}/events?limit=100` | GET | Jobs (`/jobs`) | Events for a specific job |
| `/api/v5/jobs/{jobId}/cancel` | POST | Jobs (`/jobs`) | Cancel a running job |

## Runner

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/run` | POST | Runner (`/runner`) | Invoke an agent directly |
| `/api/v5/run/history` | GET | Runner (`/runner`) | History of runner invocations |

## Plugins

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/plugins` | GET | Plugins (`/plugins`) | List installed plugins |
| `/api/v5/plugins/{id}/{action}` | POST | Plugins (`/plugins`) | Enable/disable/reload a plugin |

## Settings

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/settings` | GET | Settings (`/settings`) | Fetch general settings |
| `/api/v5/settings` | POST | Settings (`/settings`) | Save general settings |
| `/api/v5/settings/autonomous` | GET | Settings (`/settings`) | Fetch autonomous cycle settings |
| `/api/v5/settings/autonomous` | POST | Settings (`/settings`) | Save autonomous cycle settings |

## Branches report (Home)

| Endpoint | Method | Called From | Purpose |
|---|---|---|---|
| `/api/v5/branches/report` | GET | Home (`/`) | Summary branch report for home dashboard widget |

---

## Common query parameters

- `?workspaceId={id}` — Most cycle and branch endpoints accept this to scope data to a workspace. Injected automatically by the `withWorkspace()` helper in the dashboard client code.
- `?limit={n}` — Pagination limit on list endpoints.
- `?since={seq}` — Events pagination: only return events after this sequence number.
- `?status={filter}` — Filter by status string (e.g. `pending`, `approved`, `rejected`).
