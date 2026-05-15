# Design Brief — AgentForge Dashboard V2

**Project:** AgentForge — Autonomous AI cycle control center  
**Current version:** V1 (SvelteKit, Svelte 5, dark-mode-first)  
**Assignment:** Redesign V2 — improved hierarchy, richer visualization, better real-time UX  
**Stack constraint:** SvelteKit + Svelte 5 (runes syntax). No React.  

---

## What this dashboard does

AgentForge runs autonomous development cycles: a multi-agent system that picks sprint items, assigns them to AI agents (Claude Opus/Sonnet/Haiku), executes code changes, runs tests, gates the commit, and learns from each run. This dashboard is the operator's window into that loop.

The core user journey:
1. **Launch** a cycle from `/cycles/new` — pick a version target, budget, and items.
2. **Watch** it run in real time — the cycle detail page shows live stage progression, agent activity, log streaming.
3. **Approve** or reject the commit when the system pauses at the gate stage.
4. **Review** what passed, what failed, and why — via scoring, events, phases, and logs.
5. **Understand** trends over time — flywheel metrics, cost analytics, sprint history.

---

## What's working well (keep in V2)

### The 6-stage workflow pill bar
The stage bar on cycle detail (PLAN → STAGE → RUN → VERIFY → COMMIT → REVIEW) with ✓/✕ per stage and an active pulse is one of the clearest at-a-glance indicators in the whole UI. It also appears on the cycles list page as a compact progress indicator per row. Keep this component — consider making it larger and more prominent at the top of the cycle detail page.

### The Logs tab with Structured/Raw toggle and SSE tail
The Logs tab delivers genuinely useful debugging value: you can switch between parsed structured log entries and raw text, and you can tail live output via SSE. The toggle mechanic is good — consider visual polish (better empty states, timestamp formatting, per-line severity colorization) but don't break the core SSE streaming behavior.

### The now-playing agent strip
When a cycle is running, a strip shows the active phase, active agent name, model tier (with color coding), running cost, and elapsed duration. This is the "what is the system doing right now" answer. Keep this and consider promoting it to a persistent global presence when a cycle is active.

### Dark theme + monospace number rendering
The dark theme is correct for an operator dashboard. The use of JetBrains Mono for all numeric values (costs, counts, durations) prevents layout reflow during live updates and gives the UI a purposeful data-terminal feel. Preserve both.

### Model tier color coding
Yellow (Opus), Blue (Sonnet), Green (Haiku) is applied consistently to badges throughout the UI. This makes it instant to visually distinguish which tier handled which work item. Keep and extend this pattern.

---

## What needs work in V2

### 1. Items / Agents / Overview / Scoring tabs — weak visual hierarchy
These four tabs currently feel like dense data dumps with minimal visual structure. Items is a flat list of text. Agents is a table. Scoring is a series of unlabeled numbers. Overview is a box showing sprint plan text.

V2 opportunity: Give each tab a clear information architecture with sections, summaries up top, details below. Items could show completion ring / kanban-light grouping by status. Agents could show a cost-per-agent bar chart inline. Scoring should show the metrics visually (radar chart or gauge cluster). Overview should show the sprint plan as a card grid, not raw markdown.

### 2. Events tab — raw JSON display
The Events tab currently renders event records as collapsed JSON objects. There are 39+ events in a typical cycle, and distinguishing `cycle.started` from `agent.completed` from `phase.failed` requires manually expanding each one.

V2 opportunity: Replace with a vertical timeline. Each event type should have an icon and a summary line rendered from the payload (not raw JSON). Color-code by category (lifecycle events, agent events, error events). Support filtering by category. Consider collapsing identical repeated events (e.g., 20x `agent.heartbeat`).

### 3. Sprint Plan (Overview tab) — markdown text wall
The Overview tab fetches the sprint plan markdown and renders it as prose. It is not scannable. It contains the original planning rationale, decisions made, and item assignments.

V2 opportunity: Parse the markdown structure and render it as a decision tree or kanban-of-decisions. At minimum: show a summary card (version target, item count, estimated cost, time estimate) at the top, and collapse the rationale text behind a "Show full plan" toggle.

### 4. Phases tab — manual expand per phase
The Phases tab shows phase names (audit, plan, assign, execute, test, review, learn) but requires a click on each to expand. A completed cycle has 7 phases, each with agent run data, cost, duration, and markdown responses.

V2 opportunity: Render as a vertical scrolling timeline with each phase as a card in sequence. Show duration, cost, and status inline without requiring a click to expand. Let the user click to see the full phase detail panel. Make the "failed" phase visually prominent so operators immediately see where the cycle broke.

### 5. No global "where am I in this cycle" indicator
When the user is on `/cost`, `/flywheel`, `/health`, or any non-cycle page while a cycle is actively running, there is no ambient indicator that a cycle is in flight or that an approval is pending.

V2 opportunity: Add a persistent top-bar widget (or a collapsible bottom dock) that shows the current active cycle: stage pill, elapsed time, running cost, and a quick-link to the cycle detail. If approval is pending, show a prominent alert CTA. This replaces the need to navigate to the cycle page just to check status.

### 6. Mobile is unconsidered
The layout uses a fixed `220px` sidebar + `48px` topbar in a grid with `overflow: hidden`. It breaks below ~800px viewport width and is completely unusable on mobile.

V2 opportunity: Design a responsive layout where the sidebar collapses to a hamburger menu below a breakpoint (suggest 900px), and the main content reflows to single-column. The primary use case (an operator checking a running cycle from a phone) is achievable.

### 7. Accessibility not audited
Known gaps: Many icon-only buttons lack `aria-label`. Color is used as the sole differentiator for some states (e.g., model tier). Some muted text color combinations likely fail WCAG AA contrast (e.g., `--color-text-faint: #4a4a60` on `--color-bg: #0d0d0f` may be close to failing). Tab order on the cycle detail tab bar is not keyboard-navigable.

V2 opportunity: Audit and fix. The minimum bar is WCAG AA. Run axe or Lighthouse against each page.

### 8. Sidebar has 25+ links across 6 sections
The sidebar currently exposes: Overview (4 links), Autonomous (5 links), Operations (3 links), Organization (2 links), Intelligence (4 links), Platform (3 links). Many of these pages are stubs or low-frequency. The link density makes the sidebar feel like a utility menu, not a workflow guide.

V2 opportunity: Collapse rarely-used sections behind a toggle. Add a search/filter box for power users. Allow pinning/favoriting frequently visited pages. Consider progressive disclosure: show fewer links by default, expand on hover or click.

---

## V2 constraints

1. **Must stay SvelteKit + Svelte 5** (runes syntax: `$state`, `$derived`, `$effect`). The designer should produce working Svelte component code, not just mockups.
2. **Must remain dark-mode-first**. Light mode as an optional toggle is fine, but the default is dark.
3. **Real-time SSE is core**. Every design decision for live pages (cycle detail, live feed, runner) must account for data arriving via SSE without full page reload. Avoid designs that require a layout recalculation on every event. Animations should be additive (append, fade-in), not reflow-triggering.
4. **Data shapes cannot change without backend work**. The API reference (`api-reference/endpoints.md`) documents what each page receives. V2 can add new derived views, client-side groupings, or computed metrics — but cannot assume the backend returns data in a different structure unless that work is also scoped.
5. **No external chart libraries without discussion**. The codebase currently has zero charting dependencies. If V2 needs charts (e.g., cost over time, scoring radar), prefer D3-lite SVG hand-drawn components or a very small well-maintained library. No heavyweight dependencies.

---

## Inspiration references

The team's aesthetic references for V2:

- **Linear** — Clean dark operator UI, strong typography hierarchy, subtle animations, fast feels
- **Grafana** — Dense data dashboards that remain readable; panel-based layout; timeline charts
- **Vercel's deployment detail page** — Multi-phase deployment progress with a clear timeline, log streaming, build output
- **Sentry's issue detail** — The way Sentry structures an error event (header with key facts, tabs for breadcrumbs/stacktrace/context) is the right model for the cycle detail page
- **Raycast** — The command-palette filter pattern for the sidebar collapse/search

---

## Deliverable for V2

Return working Svelte 5 component files (`.svelte`) with the same route structure as V1 (see `source/routes/`). Include updated `app.css` or a new design token set if the color/spacing/type system changes. Include a short changelog noting which components were reworked and why.

Send mockups (Figma or screenshots) first for alignment, then implementation. Contact: **Sean Vaughan** — sean.vaughan@allworthfinancial.com
