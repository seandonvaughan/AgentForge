# AgentForge Dashboard V2 — Handoff Package

**Designer:** Sean Vaughan · sean.vaughan@allworth.com
**Status:** Design + interactive prototype complete, ready for SvelteKit implementation
**Reference V1:** `dashboard-v1-export/` (provided separately)

This bundle contains the V2 design and a working HTML prototype that demonstrates every screen, interaction, and motion behavior. Implementation should match the prototype's visual fidelity, layout, copy, and motion. Behavior (data shapes, SSE wiring, API calls) should follow V1 — see `dashboard-v1-export/api-reference/endpoints.md`.

---

## 1. How to view the prototype

Open `prototype/index.html` in any modern browser. No build step required (React + Babel via CDN).

- Default route: `#/` (Command Center)
- All routes are hash-based: `#/cycles`, `#/cycles/b555cca4`, `#/agents`, `#/agents/coder`, etc.
- Click anything. Tweak panel (bottom-right) lets you flip background / surface / accent / density / motion live.

---

## 2. Design philosophy

The V2 direction is **"Linear restraint, Grafana density"** — disciplined monochrome surfaces, sharp 1px borders, generous whitespace within panels, but a tmux-style operator status line and per-agent sparklines deliver the data-per-pixel an operator console needs.

| Principle | Implementation |
|---|---|
| Quiet chrome, loud data | Topbar/sidebar in `#0a0a0c` w/ 1px borders. Color reserved for state (purple=running, green=success, red=failed) |
| Live system always visible | Running-cycle widget pinned in the topbar with mini stage bar; status line under it with operator counters |
| Type-driven over chart-heavy | JetBrains Mono tabular-nums for every number; sparklines and rings only where they earn the pixel |
| Motion is information | Pulse on running, flow-gradient on active stage, animated counters, view-transitions on route change |

---

## 3. Design tokens

See `prototype/shared.jsx` lines 1–60 for the full token export. Highlights:

```
--af-bg:       #0a0a0c   (canvas)
--af-surface:  #0e0e10   (cards)
--af-border:   #18181b   (hairlines)
--af-text:     #fafafa
--af-muted:    #a1a1aa
--af-dim:      #71717a
--af-faint:    #52525b
--af-accent:   #6366f1   (indigo)
--af-purple:   #a78bfa   (active state)
--af-grad:     linear-gradient(135deg, #6366f1, #a855f7)
--af-success:  #5bd394
--af-warning:  #f5a623
--af-danger:   #ef4444
--af-opus:     #f5a623
--af-sonnet:   #7aa0f7
--af-haiku:    #5bd394

Fonts:
  Inter (UI)             400/500/600/700
  JetBrains Mono (data)  400/500/600/700 with 'tnum' enabled
```

All tokens already live as CSS custom properties on `body[data-af-accent="..."]` — the Tweak panel rewrites them. Carry these into `app.css`.

---

## 4. Screens

Each row is a route. The "Source" column is the JSX component name in the prototype.

### Top-level navigation

| Section | Route | Source |
|---|---|---|
| Command Center | `/` | `CommandCenter` |
| Cycles | `/cycles` | `CyclesList` |
| Launch | `/cycles/new` | `LaunchCycle` |
| Cycle detail | `/cycles/:id` | `CycleDetail` |
| Agents | `/agents` | `AgentsPage` |
| Agent detail | `/agents/:id` | `AgentDetailPage` |
| Org Graph | `/org` | `OrgGraphPage` |
| Branches | `/branches` | `BranchesPage` |
| Approvals | `/approvals` | `ApprovalsPage` |
| Sessions | `/sessions` | `SessionsPage` |
| Live Feed | `/live` | `LiveFeedPage` |
| Runner | `/runner` | `RunnerPage` |
| Jobs | `/jobs` | `JobsPage` |
| Cost | `/cost` | `CostPage` |
| Flywheel | `/flywheel` | `FlywheelPage` |
| Insights | `/insights` | `InsightsPage` |
| Memory | `/memory` | `MemoryPage` |
| Health | `/health` | `HealthPage` |
| Schedule | `/schedule` | `SchedulePage` |
| Webhooks | `/webhooks` | `WebhooksPage` |
| Notifications | `/notifications` | `NotificationsPage` |
| Audit log | `/audit` | `AuditPage` |
| Workspaces | `/workspaces` | `WorkspacesPage` |
| Settings | `/settings` | `SettingsPage` |

### Cycle detail tabs

`Overview | Pipeline | Items | Agents | Scoring | Events | Files | Logs`

The **Pipeline** tab is the V2 reinvention of V1's Phases tab — a vertical timeline (Vercel-style) with each phase as a row showing agent, duration, cost, and a status dot. Active phase animates a flow gradient down its connector.

The **Scoring** tab is new — radar chart across 6 dimensions (Velocity / Quality / Cost / Autonomy / Safety / Learning) + per-item ranking.

### Agent detail tabs

`Overview | Sessions | Memory | Config`

Config tab shows a fully-formatted `agent.yaml` preview that's editable — this maps to the YAML files in V1's `agents/` directory.

---

## 5. New surfaces V1 didn't have

These are net-new in V2 — confirm scope with backend before building.

| Page | What it needs from the API |
|---|---|
| **Insights** | A new endpoint `/api/v5/insights` that returns auto-generated observations (wins/risks/shifts). Could be derived client-side from existing cycle/cost data to start. |
| **Memory** | Already partially exists in V1 (`/memory`) — V2 promotes it to a filterable knowledge browser with kind tags (pattern/failure/decision/metric) and hit counts. |
| **Audit log** | Needs `/api/v5/audit?since=…&actor=…` — append-only log of admin + autonomous actions for compliance/SOC 2. |
| **Schedule** | Cron-style scheduled cycles. Needs `/api/v5/schedules` CRUD endpoints. |
| **Webhooks** | Outbound delivery to Slack/Linear/Datadog. Needs `/api/v5/webhooks` CRUD + test endpoint. |
| **Notifications** | In-app inbox. Needs `/api/v5/notifications?unread=…` and a mark-read mutation. |
| **Settings → Security** | API keys table — needs `/api/v5/keys` CRUD with scoped permissions. |
| **Settings → Team** | Member roster — needs `/api/v5/members` if multi-user is on the roadmap. |
| **Cycle compare drawer** | Computed client-side from existing cycle data — no new API needed. |

---

## 6. Reusable components

Build these as Svelte components in `lib/components/v2/`. The prototype has equivalents you can mirror 1:1:

| Component | Purpose | Prototype source |
|---|---|---|
| `<StageRail>` | Horizontal 6-step pipeline used on cycle list rows, hero, and detail header | `shared.jsx` |
| `<StageDots>` | Compact 6-brick stage indicator for table rows | `shared.jsx` |
| `<Sparkline>` | SVG sparkline with optional gradient fill — used everywhere | `shared.jsx` |
| `<Ring>` | Progress ring with animated stroke (KPIs, scoring, utilization) | `shared.jsx` |
| `<MiniBars>` | Tiny SVG bar chart | `shared.jsx` |
| `<DistBar>` | Segmented distribution bar (model mix) | `shared.jsx` |
| `<PulseDot>` | Animated dot + ring used on "live" indicators | `shared.jsx` |
| `<AnimNum>` | Counts up to a value on mount — used on hero numbers | `shared.jsx` |
| `<ModelChip>` | Opus/Sonnet/Haiku tier chip with consistent coloring | `shared.jsx` |
| `<Badge>` | Status/severity chip (success/warning/danger/info/purple/muted) | `shared.jsx` |
| `<Btn>` | Primary / purple / ghost / danger button at 3 sizes | `shared.jsx` |
| `<KpiTile>` | Compact KPI card with delta, sub, and optional sparkline | `page-rest.jsx` |
| `<Tabs>` | Tab strip with animated underline that slides between active tabs | `shared.jsx` |
| `<Card>` | Standard surface — `hover` and `accent` props | `shared.jsx` |

---

## 7. Layout shell

The grid is 2-column × 3-row:

```
┌─────────────────────────────────────────────┐ 44px  Topbar (logo, search, running-cycle widget, avatar)
├─────────────────────────────────────────────┤ 22px  Status line (api/ws/sse dots, counters, clock)
│ Sidebar │ Main                              │
│         │                                   │
│ icons   │ Page content (overflow:auto)      │
│ + labels│                                   │
│         │                                   │
└─────────┴───────────────────────────────────┘
  48 / 220px
```

**Sidebar:**
- Default pinned + expanded (220px wide)
- Pin button in top-left toggles collapsed mode (48px icons-only)
- When collapsed, hover anywhere on the sidebar expands it temporarily (absolute-positioned overlay; main content does not shift)
- State persists in `localStorage` under `af2-sidebar-pinned`

**Running-cycle widget (topbar):**
- Visible whenever a cycle is in flight (poll `/api/v5/cycles?limit=1` or use SSE)
- Compact stage bricks (6 small rects, accent for active, gradient for done)
- Click → navigate to `/cycles/:id`

**Status line:**
- Read from `/api/v5/health/services` (api/ws/sse) and `/api/v5/counters`
- Refreshes every 5–10s

---

## 8. Motion behavior

| Element | Motion |
|---|---|
| Route changes | `document.startViewTransition()` where supported, instant fallback otherwise |
| Active stage rail | Flow gradient (configurable in Tweaks: `flow` / `scan` / `static`) |
| Pulse dots | 1.6s ease-out radial ring expansion |
| Number changes | `<AnimNum>` interpolates over 600ms with cubic-out easing |
| Tab switching | Underline slides between active tabs over 250ms |
| Card hover | Border color shifts to accent; no scale, no shadow change |
| KPI ring fills | 700ms cubic-bezier `(.2,.7,.2,1)` stroke-dashoffset transition |

If `prefers-reduced-motion` is set, fall back to "quiet" mode (the Tweak panel demonstrates what this looks like).

---

## 9. Data shape changes from V1

V2 stays compatible with V1's API surface (see `dashboard-v1-export/api-reference/endpoints.md`). New derived/client-side computations:

- **Cycle scoring** — radar dimensions can be derived from existing cycle data (cost vs. budget → Cost score, tests passed → Quality score, etc.). The exact formula is open — see `prototype/data.js` for the shape we use as scaffolding.
- **Insights** — start by computing 3–4 insights client-side from the last 14 cycles (cost trend, model shift, memory plateau). Promote to a server endpoint once the heuristics stabilize.
- **Per-agent profiling** — aggregate sessions + cycles client-side. No new server work needed for V1 of the agent detail page.

The Tweak panel persists user preferences via the `__edit_mode_set_keys` protocol — in production these should live in `localStorage` or user settings.

---

## 10. Open questions / things to confirm

1. **Multi-user**: Is the Team tab in Settings in scope, or single-operator-only for now?
2. **Audit log retention**: How far back should we serve? 30d / 90d / forever?
3. **Notification delivery**: Is in-app enough, or do we need email/Slack at launch?
4. **Webhooks**: Real outbound HTTP, or just a stub UI for now?
5. **Scheduled cycles**: Does the backend already have a scheduler, or is this new infrastructure?
6. **Cost forecasting**: Should we forecast spend ("at current burn, you'll hit $X this month")? Designs ready if yes.

---

## 11. File map

```
prototype/
├── index.html              — entry point, fonts, base CSS, polish CSS for Tweaks
├── data.js                 — mock data (cycles, agents, sessions, scoring, etc.)
├── shared.jsx              — tokens, atoms (Btn, Card, Badge, ModelChip),
│                             viz (Sparkline, Ring, DistBar, PulseDot, AnimNum),
│                             layout (Topbar, StatusLine, Sidebar, Layout),
│                             Tabs, StageRail, StageDots, formatters
├── page-cmd-cycles.jsx     — CommandCenter, CyclesList (w/ compare drawer), LaunchCycle
├── page-cycle.jsx          — CycleDetail (all 8 tabs)
├── page-agents.jsx         — AgentsPage, AgentDetailPage, OrgGraphPage (tree + SVG graph)
├── page-rest.jsx           — Sessions, Cost, Health, Flywheel, Live, Runner, Branches,
│                             Approvals, Workspaces, Jobs, Settings (6 sub-sections),
│                             Memory, Audit, Insights, Schedule, Webhooks, Notifications
├── app.jsx                 — Hash router + Layout wrapper
├── tweaks-panel.jsx        — Tweaks panel framework (provided by design system)
└── tweaks.jsx              — V2-specific Tweak controls
```

---

## 12. Suggested implementation order

1. **Layout shell** (Topbar + Status line + Sidebar + collapsible behavior + Tweaks tokens)
2. **Command Center** (validates KPI tiles, hero panel, agent activity, recent cycles, fleet mix)
3. **Cycle list + Cycle detail** (the operator's main workflow — get Overview / Pipeline / Items / Agents shipping)
4. **Launch** (validates form patterns + estimate card)
5. **Agents + Agent detail + Org Graph**
6. **Operations group** (Branches / Approvals / Sessions)
7. **Insights group** (Cost / Flywheel / Insights / Memory / Health)
8. **System group** (Schedule / Webhooks / Notifications / Audit log)
9. **Settings** (6 sub-sections — Workspace / Autonomous / Notifications / Security / Team / Billing)

---

Questions? sean.vaughan@allworth.com
