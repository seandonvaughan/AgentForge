# AgentForge v7.0.0 — Mission Control Design Spec

**Date:** 2026-04-08
**Status:** Design (no implementation yet)
**Author:** Design session with Claude Opus 4.6
**Predecessor:** v6.7.4 (autonomous loop proven end-to-end, dashboard salvaged from cycle 88026e07, 31 files / 2588 insertions)
**Supersedes:** `2026-04-07-v7-persistent-daemon-design.md` (rolls the daemon into v7 as one of three pillars rather than the headline)

---

## 1. Executive Summary

v6.7.x proved the autonomous loop works end-to-end. PR #6 shipped real code via the loop. Cycles plan, execute, review, gate, and open PRs without human intervention. The engine is real.

**v7.0.0 makes the dashboard the primary product surface.** The autonomous loop is now the engine; v7 makes the engine drivable, observable, and beautiful at every level — so a single human can run the work of a 20-person engineering team from one tab in their browser.

This is a UI-first release. Three pillars:

1. **Mission Control UI** — a redesigned dashboard with live everything, inline approvals, inline PR review, agent run replay, feature kanban, command palette, timeline scrubber, side-by-side cycle comparison, full keyboard navigation, and polished visual design across every page
2. **Persistent Daemon** — always-on cycle scheduler with full UI controls (start, stop, pause, schedule, trigger queue, cost ceilings) all surfaced in the dashboard rather than YAML files
3. **Multi-Cycle Features** — features decomposed into a sequence of cycles with dependencies, rollup PRs, and a dashboard kanban tracking the feature from idea to merge

Stretch goal: **Spec → Cycle Pipeline.** Drop a feature spec markdown into the dashboard, the daemon decomposes it into multi-cycle work and starts executing.

---

## 2. Goals

### Mission Control UI
1. **Inline approvals** — pending budget approvals appear as a modal in the dashboard with item-level approve/reject toggles. No more editing `approval-decision.json` by hand.
2. **Inline PR review** — when a cycle opens a PR, the cycle detail page shows the diff viewer, files-changed list, and per-file review comments inline. Click "Approve & Merge" to merge from the dashboard.
3. **Agent run replay** — every agent run on the Agents tab is replayable: click a run to see the exact prompt sent, every tool call the agent made, the streaming response, and the final output. Like a debugger for agents.
4. **Feature kanban** — a `/features` page with a kanban of multi-cycle features (Idea / Decomposed / In Progress / Review / Merged) with progress bars, child-cycle links, and cost rollups.
5. **Command palette** — `Cmd+K` opens a fuzzy command palette that can launch cycles, navigate, search, trigger workflows, manage workspaces, view docs.
6. **Timeline scrubber** — a `/timeline` page with a horizontal time axis showing every cycle, sprint, PR, and event ever. Drag to scrub, zoom in to a single cycle, zoom out to see the full project history.
7. **Cycle comparison** — pick two cycles from the list, see them side-by-side: cost, duration, agents used, items completed, gate verdicts, PR diffs.
8. **Cost forecasting** — the launch cycle UI predicts total cost from historical cycle data (similar items × historical median).
9. **Live everything** — every page that shows data updates live without manual refresh. Server-sent events drive cost/stage/agent activity into every relevant component.
10. **Markdown rendering** — phases tab, gate rationales, reviewer findings, agent responses all render markdown as formatted HTML, not raw JSON.
11. **Phase trace view** — alongside the Items kanban, a Gantt-style phase trace showing exactly when each phase started, how long it took, and which agents ran in each.
12. **Full keyboard navigation** — `j`/`k` to navigate lists, `o` to open, `/` to search, `Cmd+K` for the command palette, `?` for shortcut help. No mouse required.
13. **Dark + light themes** — both fully polished, automatic OS-preference detection, manual override.
14. **Notifications** — browser notifications when cycles complete, PRs need review, approvals are pending, gate rejects.
15. **Mobile-readable** — at minimum, the Items kanban, cycle list, and PR review pages render usefully on a phone.

### Persistent Daemon
16. **Always-on cycle execution** — long-running daemon process triggers cycles based on schedule, signal, queue, backlog state, or webhook. Detailed in §4.2.
17. **Full UI controls** — start/stop/pause the daemon from `/daemon`. Add/remove triggers from the UI. View live trigger queue. Override any decision.
18. **Cost ceilings with daily/weekly/monthly windows** — daemon-level spend tracking, not just per-cycle.
19. **Failure recovery** — daemon decides retry vs. escalate vs. pause based on configurable policy.
20. **Graceful shutdown** — never leaves a cycle half-done.

### Multi-Cycle Features
21. **Feature spec → backlog** — drop a markdown spec into the dashboard or via API, the daemon decomposes it into a sequence of TODO markers across files, each tagged with the feature ID.
22. **Feature kanban** — tracked on the `/features` page (see UI goal #4 above).
23. **Rollup PRs** — when all child cycles for a feature complete, an optional rollup PR collapses them into a single PR for human review.
24. **Cross-cycle dependencies** — feature plan can declare "cycle B depends on cycle A's branch being merged" and the daemon honors that.
25. **Cost forecasting per feature** — predict total feature cost from historical cycle data before starting.

### Quality of Life
26. **Reviewer calibration** — configurable severity thresholds. The reviewer can be tuned per-workspace to be lenient (auto-approve everything that compiles + tests pass) or strict (current default).
27. **Cross-cycle memory** — agents read past gate verdicts and review findings before starting new work, so they don't repeat mistakes.
28. **Approval-via-Slack/email** — optional webhook integration sends approval requests to Slack/email; reply to approve.

---

## 3. Non-goals (deferred to v7.1+)

- **Distributed execution / multi-instance daemon** — single process per machine.
- **Authentication / multi-user** — single-operator assumption.
- **Cloud hosting** — runs locally only.
- **Real-time collaboration** — one operator at a time per workspace.
- **Custom dashboard plugins** — fixed page set in v7.0.0.
- **Cross-workspace feature decomposition** — features stay within one workspace.
- **AI-generated dashboard layouts** — themes are designer-fixed.
- **Mobile app** — mobile web only, no native shell.
- **Voice control** — keyboard + mouse only.

---

## 4. Architecture

### 4.1 UI architecture

The dashboard is rebuilt around three new core components:

**`<LiveCycle>`** — a smart wrapper around any cycle ID that subscribes to the SSE stream and exposes reactive `cost`, `stage`, `agentRuns`, `items`, `lastEvent` slots. Every page that shows cycle data uses this. Single source of truth for all live updates.

**`<MarkdownView>`** — universal markdown renderer used by phase outputs, gate rationales, reviewer findings, agent responses, and PR descriptions. Built on `marked` with syntax highlighting via `highlight.js`. All raw JSON in the dashboard is replaced with this.

**`<ApprovalModal>`** — a modal triggered automatically when an approval is pending (detected via SSE). Shows the proposed sprint items grouped by within-budget / overflow, lets the operator toggle individual items, and writes `approval-decision.json` via the new `POST /api/v5/approvals/:cycleId/decide` endpoint. No more file-editing.

The page tree adds:
```
/                          (home — redesigned with live cycle widget)
/cycles                    (existing list)
/cycles/[id]               (existing detail with all v6.7.4 tabs)
/features                  (NEW — multi-cycle feature kanban)
/features/[id]             (NEW — feature detail with child cycles + rollup PR)
/daemon                    (NEW — daemon controls + trigger queue + cost windows)
/timeline                  (NEW — horizontal scrubber over all events)
/compare                   (NEW — side-by-side cycle comparison)
/agents/[id]/runs          (NEW — per-agent run history with replay)
```

The existing `/sprints`, `/agents`, `/org`, `/memory`, `/flywheel`, `/branches`, `/runner`, `/live`, `/approvals`, `/settings`, `/health`, `/cost`, `/sessions`, `/knowledge`, `/plugins`, `/workspaces`, `/search` pages all get a polish pass — consistent header, real backend data, live updates, markdown rendering where applicable.

### 4.2 Daemon architecture

Two processes:

- **Server (existing, port 4750)** — REST API + SSE stream + dashboard backend. Stateless. Reads cycle logs, writes approval decisions, serves the UI.
- **Daemon (new, port 4760)** — Long-running cycle scheduler. Holds in-memory state (next-trigger-time, current-cycle, queue, daily spend). Communicates with the server via filesystem (cycle dirs, daemon-state.json) and an admin HTTP API (`/status`, `/pause`, `/resume`, `/trigger`, `/queue`, `/cost`).

Daemon main loop:

```typescript
async function daemonMain(config: DaemonConfig) {
  const state = loadState();
  installSignalHandlers();
  startAdminApi(4760);

  while (!state.shutdownRequested) {
    if (state.paused) { await sleep(1000); continue; }

    const trigger = await waitForNextTrigger(config, state);
    if (!trigger) continue;

    if (await isCostCeilingExceeded(config, state)) {
      state.pausedReason = 'cost-ceiling';
      state.paused = true;
      saveState(state);
      continue;
    }

    const cycleId = await launchCycle(trigger);
    state.currentCycleId = cycleId;
    saveState(state);

    const result = await waitForCycle(cycleId);
    state.currentCycleId = undefined;
    recordCycleSpend(state, result.costUsd);
    handleCycleResult(state, result, config);
    saveState(state);
  }
}
```

Trigger types:
- **Schedule** (cron expression) — fires at fixed times
- **Backlog** (TODO marker count threshold) — fires when N markers accumulate
- **Queue** — manual triggers added via API or dashboard
- **Webhook** — HTTP POST endpoint
- **File watcher** — fires on filesystem changes (debounced)
- **Feature decomposition** — fires when a new feature spec is dropped

State persistence: `~/.agentforge/daemon-state.json` (0o600 perms, single source of truth across restarts).

Cost ceilings: daily / weekly / monthly windows tracked in state. Daemon pauses when ceiling crossed; auto-resumes at next window rollover.

### 4.3 Multi-cycle features

A feature is a markdown spec at `.agentforge/features/<feature-id>.md` with frontmatter:

```markdown
---
id: dashboard-overhaul
title: Mission Control UI rewrite
status: in_progress
budget: 500
maxCycles: 5
priority: P0
dependencies: []
---

## Description
[markdown body]

## Acceptance criteria
- [ ] command palette working
- [ ] feature kanban live
...
```

The daemon's `decomposeFeature(spec)` function:
1. Parses the spec
2. Asks the architect agent to break it into cycle-sized chunks
3. Writes child specs to `.agentforge/features/<feature-id>/cycle-N.md`
4. Plants TODO(autonomous, feature=dashboard-overhaul) markers across the codebase
5. Queues the first child cycle

Each child cycle's PR gets a `feature: <id>` label and a comment linking back to the feature spec. When all children complete, the daemon optionally squash-merges them into a rollup PR.

Cross-cycle memory: each cycle reads `.agentforge/memory/cycle-history.jsonl` before audit phase. The history contains every gate verdict, every reviewer finding, every PR review comment from past cycles. Agents instructed to "avoid repeating mistakes from previous cycles" with this context.

---

## 5. Configuration: `~/.agentforge/daemon.yaml`

```yaml
workspaces:
  - /Users/seandonvaughan/Projects/AgentForge

budget:
  perCycleUsd: 200
  dailyUsd: 500
  weeklyUsd: 2000
  monthlyUsd: 7000
  warnOnly: true   # cycles continue past ceiling, just warn

failureRecovery:
  pauseAfterConsecutiveFailures: 3
  retryBackoffMs: 60000

adminApi:
  host: 127.0.0.1
  port: 4760

triggers:
  - kind: schedule
    workspaceId: default
    cron: "0 9 * * 1-5"   # weekdays 9am

  - kind: backlog
    workspaceId: default
    thresholdMarkers: 5
    pollIntervalMs: 60000

  - kind: queue
    workspaceId: default

  - kind: webhook
    workspaceId: default
    path: /trigger/manual

features:
  rollupPr: true
  defaultMaxCycles: 5
  decompositionAgent: architect
```

---

## 6. Admin API (port 4760)

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Daemon state, current cycle, last trigger, cost windows |
| POST | `/pause` | Pause daemon (no new cycles dispatched) |
| POST | `/resume` | Resume from pause |
| POST | `/trigger` | Add a manual trigger to the queue |
| GET | `/queue` | List pending triggers |
| DELETE | `/queue/:id` | Cancel a queued trigger |
| GET | `/cost` | Current daily/weekly/monthly spend windows |
| POST | `/cost/reset` | Manually reset a cost window (rollover) |
| GET | `/triggers` | List configured trigger sources |
| POST | `/shutdown` | Graceful shutdown (waits for current cycle) |

Server proxies all these for the dashboard at `/api/v5/daemon/*`.

---

## 7. Dashboard integration (key new pages)

### 7.1 `/` Home — Mission Control overview
Header card with daemon status (running/paused, last cycle, next trigger, daily spend gauge). Below it, three columns:
- **Active cycle** (live `<LiveCycle>` widget showing current stage, progress %, cost ticker)
- **Recent PRs** (last 5 cycle PRs with state, age, click-to-review)
- **Active features** (top 3 multi-cycle features with progress bars)

Bottom: live activity feed (mini version of `/live`).

### 7.2 `/features` — Feature kanban
Five-column kanban: Idea / Decomposed / In Progress / Review / Merged. Each card shows feature ID, title, child cycle count, total cost, last activity. Drag a card to manually advance state. Click to open detail.

### 7.3 `/features/[id]` — Feature detail
Spec markdown rendered at top. Below: child cycles list with status badges. Cost rollup. Acceptance criteria checklist (auto-checked as PRs merge). "Trigger next cycle" button.

### 7.4 `/daemon` — Daemon controls
Start / Stop / Pause buttons. Live state. Configured triggers list with enable/disable toggles. Trigger queue table. Daily/weekly/monthly cost gauges. Recent daemon events log.

### 7.5 `/timeline` — Horizontal scrubber
Full-width time axis spanning the project's history. Cycles render as colored blocks (success/failure), PRs as dots, gate rejections as red Xs. Drag to zoom, click to open. Filter by feature, agent, cycle id.

### 7.6 `/compare` — Side-by-side
Two cycle pickers at the top. Below: split view with stat grid, cost comparison, agents used, items completed, gate verdict diff, PR diff (if both merged). Useful for "did v7.0.5 actually improve over v7.0.4?".

### 7.7 `/cycles/[id]` — Detail page additions
Existing tabs (Items, Agents, Overview, Scoring, Events, Phases, Files) get joined by:
- **PR** — if cycle opened a PR, show diff viewer + review comments + merge button
- **Replay** — full reconstruction of the cycle: timeline of phase transitions, agent dispatches, file edits, test runs. Click any agent run to see the prompt + tool calls + response.
- **Trace** — Gantt-style phase + agent timing visualization

### 7.8 `/agents/[id]/runs` — Per-agent run history
List every run this agent has done across all cycles, with cost, duration, status, and a click-to-replay link. Charts: cost-over-time, success rate, average duration.

### 7.9 Approval modal (global, triggered by SSE)
When the SSE stream emits `approval.pending`, a modal slides in. Item table with checkboxes (approve / reject). Cost summary at the bottom. "Approve N items / $X" button.

### 7.10 Command palette (`Cmd+K`, global)
Fuzzy-searchable command list:
- Launch new cycle
- Open cycle by ID
- Pause/resume daemon
- Switch workspace
- Open feature
- Search across cycles, sprints, PRs, agents
- Navigate to any page
- Toggle theme
- Show keyboard shortcuts

---

## 8. Implementation Plan

### Phase 1 — Mission Control core (Wave 1, ~6 parallel agents)

**Agent A**: `<LiveCycle>` component + reactive store. Wraps SSE subscription, exposes cost / stage / agentRuns / items / lastEvent. Used by every other component. Tests for SSE reconnect, stale data eviction, multiple subscribers.

**Agent B**: `<MarkdownView>` component. marked + highlight.js. Used in phases tab, gate rationales, reviewer findings, agent responses, PR descriptions. Sanitization via DOMPurify.

**Agent C**: `<ApprovalModal>` global component + new `POST /api/v5/approvals/:cycleId/decide` endpoint. Approval modal slides in on SSE event. Item-level toggles. Writes approval-decision.json server-side.

**Agent D**: Command palette (`Cmd+K`). Fuzzy search via fzf-style ranking. 20+ commands. Keyboard navigation. Tested with axe for accessibility.

**Agent E**: Cycle detail page additions — PR tab (gh diff viewer), Replay tab (timeline), Trace tab (Gantt). Real data from existing endpoints + new `/api/v5/cycles/:id/replay`.

**Agent F**: Home page redesign — three-column live layout. Daemon status header. Recent PRs widget. Active features widget. Mini activity feed.

### Phase 2 — Multi-cycle features (Wave 2, ~4 parallel agents)

**Agent G**: Feature spec parser + `.agentforge/features/<id>.md` schema + `decomposeFeature(spec)` function. Architect agent dispatched to break specs into cycle chunks.

**Agent H**: `/features` kanban page + `/features/[id]` detail page. Drag-to-advance. Cost rollup. Acceptance criteria auto-check.

**Agent I**: Cross-cycle memory module. `.agentforge/memory/cycle-history.jsonl` writer (in cycle-runner). Reader injected into audit/plan/execute prompts.

**Agent J**: Cost forecasting service. Reads `.agentforge/cycles/*/cycle.json` history, computes per-tag medians, exposes `POST /api/v5/cost/forecast`. Used by launch cycle UI + feature decomposition.

### Phase 3 — Persistent daemon (Wave 3, ~3 parallel agents)

**Agent K**: `packages/core/src/daemon/daemon-runner.ts` — main loop, signal handlers, state load/save. Reuses v6.7.4 daemon scaffolding (types.ts, daemon-state.ts already exist).

**Agent L**: Trigger implementations — `triggers/{schedule,backlog,queue,webhook,file-watcher,feature-decomposition}-trigger.ts`. Common Trigger interface. One file per trigger kind.

**Agent M**: Daemon admin API on port 4760 + server proxy at `/api/v5/daemon/*`. CLI command `agentforge daemon {start,stop,status,pause,resume}`.

### Phase 4 — Daemon UI + polish (Wave 4, ~3 parallel agents)

**Agent N**: `/daemon` page. Live state widget. Trigger config table. Cost gauges. Event log. Reuses `<LiveCycle>` for current cycle display.

**Agent O**: `/timeline` scrubber. SVG-based timeline component. Cycle/PR/event rendering. Drag-to-zoom. Filter UI.

**Agent P**: `/compare` page + split-view component. Two-cycle picker. Stat grid diff. Cost comparison chart. PR diff side-by-side.

### Phase 5 — Quality of life + tests (Wave 5, ~3 parallel agents)

**Agent Q**: Reviewer calibration — config schema for severity thresholds. Per-workspace `.agentforge/reviewer.yaml`. Gate phase reads thresholds and applies them.

**Agent R**: Notifications — browser Notification API integration. Permission flow on first visit. Notification on cycle complete / PR ready / approval pending.

**Agent S**: Mobile + theme polish — responsive breakpoints across all pages, light theme parity, full keyboard navigation testing, accessibility audit.

### Phase 6 — End-to-end smoke + docs

- Manual smoke test procedure for each new page
- README rewrite focused on Mission Control
- Migration guide v6.7 → v7.0
- Updated CHANGELOG
- Recorded demo video

---

## 9. Acceptance Criteria

The release ships when ALL of these are true:

1. ✅ A fresh user can install AgentForge, open the dashboard, hit `Cmd+K`, type "launch cycle", and have a cycle complete end-to-end with PR opened — without ever editing a YAML or JSON file
2. ✅ Approvals can be granted from the dashboard modal (no file editing)
3. ✅ Feature spec drop → 5-cycle decomposition → rollup PR works for at least one real feature
4. ✅ Daemon runs unattended for 24 hours without crashing, executing >5 cycles
5. ✅ Cost forecasting predicts feature cost within ±25% of actual on a backtest of 5 historical features
6. ✅ Every dashboard page shows live data (no static placeholders)
7. ✅ Phases tab, gate rationales, reviewer findings render as formatted markdown (no raw JSON)
8. ✅ Cycle replay shows the full agent run timeline including prompts and tool calls
9. ✅ Timeline scrubber covers the full project history and is performant at 1000+ events
10. ✅ Light + dark themes both pass an accessibility audit (WCAG AA)
11. ✅ Full keyboard navigation: every action reachable without a mouse
12. ✅ Mobile-readable on iPhone 15 viewport at minimum
13. ✅ Test count ≥ 4500 (currently ~4267)
14. ✅ Zero pre-existing TypeScript strict-mode errors (currently ~22 baseline)
15. ✅ Cross-cycle memory measurably reduces gate rejections (compared to a v6.7.4 baseline)

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Scope explosion — 19 components in one release | Hard phase gating. Each phase ships independently as v7.0.0-alpha.N. v7.0.0 final waits for all six phases. |
| Live SSE breaks under high cycle activity | `<LiveCycle>` has built-in reconnect, debounce, and stale-data eviction. Load test with 50 simultaneous cycles. |
| Markdown rendering opens XSS surface | DOMPurify + content security policy. All markdown sources are agent-generated text, not user input, but treat them as untrusted anyway. |
| Cost forecasting wildly inaccurate early on | Start with `±50%` confidence band, narrow as historical data accumulates. Show forecast as a range, not a point. |
| Daemon multi-trigger races | Single-process design rules out distributed races. Within process, queue is mutex-protected. |
| Cross-cycle memory grows unbounded | Rotate `cycle-history.jsonl` at 10,000 entries. Compact older entries to summary form. |
| Reviewer calibration makes the loop too lenient → bad code ships | Default thresholds remain strict. Lenient mode requires explicit opt-in per workspace. Always log gate decisions for audit. |
| Feature decomposition produces nonsense child cycles | Architect agent reviews its own decomposition before queuing. Human can pause and edit child specs before they execute. |
| Browser notifications are annoying | Off by default. Granular per-event-type toggles. Quiet hours config. |

---

## 11. Open Questions

1. **Should the daemon and server be one process or two?** Current spec: two. Pro: clean isolation, daemon survives server restarts. Con: more moving parts. **Decision: keep two for v7.0.0; revisit in v7.1.**
2. **Should features support sub-features (recursive decomposition)?** Current spec: no, flat. **Decision: defer to v7.1.**
3. **Should the timeline scrubber render server-side for first paint?** Performance question. **Decision: client-only for v7.0.0; SSR if needed in v7.1.**
4. **Should approvals be Slack-integratable in v7.0.0?** Goal #28 mentions it as optional. **Decision: scaffold the webhook hook in v7.0.0; ship integration as v7.0.1.**
5. **Should the command palette include AI search ("find me a cycle that fixed parser bugs")?** **Decision: keyword search only in v7.0.0; AI search is v7.1.**

---

## 12. Estimated Scope

- **New code:** ~8,000–12,000 lines
- **Modified code:** ~3,000–5,000 lines (existing dashboard pages get a polish pass)
- **New tests:** ~150 unit + 30 e2e
- **New agents:** 0 (uses existing agents in execution)
- **Parallel workstreams:** 19 across 6 phases
- **Estimated cycle count:** 8–15 cycles (1 wave = 1–3 cycles)
- **Estimated total cost:** $80–$150 (within current $200/cycle ceiling for any single cycle)

---

## 13. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-08 | UI is the primary pillar (not daemon) | User explicitly asked for "huge UI development". The autonomous loop is proven; the missing piece is making it operable. |
| 2026-04-08 | Supersede the 2026-04-07 daemon spec | The daemon is now one of three pillars, not the headline. Roll its design into §4.2 of this spec; mark the old doc as superseded. |
| 2026-04-08 | Multi-cycle features over single-cycle improvements | A feature decomposition primitive lets the daemon plan work bigger than a single cycle, which is the missing scale step from v6.7.x. |
| 2026-04-08 | Reviewer calibration is in scope | v6.7.x cycles repeatedly hit gate rejections for arguably-minor issues. Without calibration, the loop is too aggressive for non-trivial features. |
| 2026-04-08 | Cross-cycle memory in scope | Same reasoning. Agents repeating mistakes wastes tokens and frustrates the operator. |
| 2026-04-08 | Mobile-readable, not mobile-native | Practical scope cap. Mobile web at iPhone-15 viewport is enough for monitoring; full app is v8+ if ever. |
| 2026-04-08 | Inline PR review in scope | Currently the operator has to leave the dashboard and go to GitHub. Having it inline closes the loop entirely within the dashboard. |

---

## 14. What v7.0.0 unlocks for the user

**Before v7.0.0** (today, end of v6.7.x):
- You can run autonomous cycles
- The dashboard shows what cycles did
- You manually launch each cycle
- You manually approve overage budgets via `approval-decision.json`
- You manually review PRs in a separate tab on GitHub
- Each cycle is a one-shot
- Multi-cycle features need manual decomposition

**After v7.0.0** (target):
- The daemon launches cycles automatically based on schedule, backlog state, or queue
- The dashboard is your sole interface — approvals, PR review, feature planning, agent replay all in one tab
- You drop a feature spec, it decomposes into 5 cycles, runs them, opens a rollup PR
- You watch progress live with sub-second updates
- You scrub through history with the timeline
- You compare cycles side-by-side to see if a refactor actually helped
- The daemon respects daily/weekly/monthly cost ceilings
- The reviewer is calibrated to your team's standards
- Agents learn from past mistakes via cross-cycle memory
- Everything is reachable from `Cmd+K`
- Notifications tell you when something needs attention

The role shift is real: human goes from "operator" to "PM + reviewer", and the project advances overnight without you in the chair.

---

## End of design
