# AgentForge v7.0.0 — Persistent Daemon Design Spec

**Date:** 2026-04-07
**Status:** Design (no implementation yet)
**Author:** Design session with Claude Opus 4.6
**Predecessor:** v6.6.0 (autonomous loop feature-complete at MVP — 348 tests, all 9 phases real, parallel execute, multi-workspace)

---

## 1. Executive Summary

v7.0.0 makes AgentForge **always-on**. v6.x ships a complete autonomous cycle that you can run on demand. v7.0.0 wraps that one-shot in a long-running daemon process that triggers cycles automatically based on configurable conditions: schedule, signal, queue, or backlog state.

The daemon's job is to keep the project in a perpetually-improving state without human prompting. The human's role shifts from "click run" to "review PRs and merge the good ones" — the same interaction model as a junior engineer on the team.

---

## 2. Goals

1. **Always-on cycle execution** — wrap `CycleRunner.start()` in a long-running process that triggers cycles automatically without human prompting
2. **Multiple trigger types** — schedule (cron-like), signal (file/HTTP), queue (manual or API-driven), backlog state (when N TODO markers accumulate)
3. **Multi-workspace coordination** — single daemon manages cycles across all registered workspaces (uses v6.6.0 multi-workspace support)
4. **Cost ceilings** — daily/weekly/monthly plan-quota limits enforced by the daemon, not just per-cycle
5. **Failure recovery** — if a cycle fails, the daemon decides whether to retry, escalate, or pause
6. **Dashboard daemon controls** — start/stop/status/pause from the UI, with live activity feed
7. **Graceful shutdown** — daemon never leaves a cycle half-done; can be killed safely
8. **Observability** — structured logs, metrics, audit trail of every triggered cycle and decision

## 3. Non-goals (deferred to v7.1+)

- **Distributed execution** — daemon runs as a single process. Multi-instance / leader election is v7.1+.
- **Authentication on daemon HTTP endpoints** — single-user assumption. Auth is v8 territory.
- **Adaptive trigger learning** — daemon doesn't learn its own optimal trigger schedule.
- **Cross-workspace dependency chains** — workspace A's cycles can't depend on workspace B's outputs.
- **Per-cycle GPU/resource quotas** — the daemon enforces only plan-quota dollar limits.

---

## 4. Architecture

### 4.1 Process model

The daemon is a separate Node.js process spawned by a new CLI command:

```bash
agentforge daemon start [--config path/to/daemon.yaml]
```

It is **not** the same process as the existing Fastify server (`packages/server`). The two are independent:

- **Server (existing, port 4750)** — REST API + dashboard backend. Stateless. Reads cycle logs, accepts launch requests, serves the UI.
- **Daemon (new, port 4760)** — Long-running cycle scheduler. Holds in-memory state (next-trigger-time, current-cycle, queue). Periodically emits heartbeat events.

The two communicate via:
1. **Filesystem** — daemon writes state to `~/.agentforge/daemon-state.json` and cycle logs to the workspace's `.agentforge/cycles/`. The server reads these.
2. **HTTP** — daemon exposes a small admin API on port 4760 (`/status`, `/pause`, `/resume`, `/trigger`, `/queue`). The server proxies these for the dashboard.

### 4.2 Daemon main loop

```typescript
async function daemonMain(config: DaemonConfig) {
  const state = loadState();
  installSignalHandlers();
  startAdminApi(4760);

  while (!state.shutdownRequested) {
    if (state.paused) {
      await sleep(1000);
      continue;
    }

    const trigger = await waitForNextTrigger(config, state);
    if (!trigger) continue;

    if (await isCostCeilingExceeded(config, state)) {
      state.pausedReason = 'cost-ceiling';
      state.paused = true;
      saveState(state);
      continue;
    }

    state.currentCycle = await launchCycle(trigger.workspaceId, trigger.options);
    saveState(state);

    const result = await waitForCycleCompletion(state.currentCycle);
    state.recentCycles.push(result);
    state.totalCostSpent += result.cost.totalUsd;
    state.currentCycle = null;
    saveState(state);

    if (result.stage === 'failed' || result.stage === 'killed') {
      await handleFailure(result, config, state);
    }
  }

  await gracefulShutdown(state);
}
```

Key properties:
- **Single-threaded cycle execution** — only one cycle runs at a time per daemon instance. Multi-cycle parallelism is v7.1+ work.
- **State persisted to disk on every transition** — daemon can crash and resume.
- **Pause-respect** — `paused: true` is honored at every loop iteration.
- **Cost-ceiling enforcement** — checked before each cycle launch.

### 4.3 Trigger types

```yaml
triggers:
  - type: schedule
    cron: "0 */4 * * *"      # every 4 hours
    workspaceId: agentforge
    enabled: true

  - type: backlog-threshold
    workspaceId: agentforge
    minTodoMarkers: 5
    minIntervalMinutes: 30
    enabled: true

  - type: file-watcher
    workspaceId: agentforge
    paths: ["src/**/*.ts"]
    debounceMinutes: 60
    enabled: false

  - type: queue
    workspaceId: agentforge
    enabled: true

  - type: webhook
    workspaceId: agentforge
    secret: "shared-secret"
    enabled: false
```

| Type | When it fires | Use case |
|---|---|---|
| **schedule** | At cron times | Nightly improvement runs, hourly polls |
| **backlog-threshold** | When N markers accumulate | Reactive: don't run if there's nothing to fix |
| **file-watcher** | After source-file activity stops | Run after a coding session ends |
| **queue** | When an item is enqueued via API | Human-driven: "run this specific sprint" |
| **webhook** | On HTTP POST to /trigger | CI/CD integration, external scheduling |

### 4.4 Cost ceilings

```yaml
costCeilings:
  perDay:    25.00
  perWeek:   125.00
  perMonth:  400.00
  perWorkspace:
    agentforge: { perDay: 15.00 }
    myapp:      { perDay: 10.00 }
```

Spent amounts tracked in `~/.agentforge/daemon-state.json`. Period counters reset at the start of each new day/week/month. When a ceiling is hit, daemon **pauses** with `pausedReason: 'cost-ceiling'`. User can manually resume or wait for the next period reset.

### 4.5 Failure recovery

When a cycle ends in `failed` or `killed`, `handleFailure()` runs:

1. **Log the failure** with full cycle.json + events.jsonl references
2. **Determine retry policy** by failure reason:
   - `killed: budget` → don't retry, log warning
   - `killed: regression` → don't retry; notify via webhook if configured
   - `killed: testFloor` → retry once with longer "fix tests" prompt
   - `failed: scoringFallback=static` → retry once with sonnet → opus fallback
   - `failed: GateRejectedError` → don't retry; CEO said no for a reason
   - `failed: subprocess timeout` → retry once with longer timeout
3. **Increment failure counter** in state
4. **Consecutive-failure threshold**: 3+ in a row → pause daemon entirely (`consecutive-failures`). Forces human review.

### 4.6 Graceful shutdown

On SIGTERM/SIGINT:

1. Stop accepting new triggers
2. If a cycle is running, wait up to `gracefulShutdownTimeoutMs` (default 5 min) for completion
3. If exceeded, write a "shutdown-during-cycle" marker and abort the subprocess
4. Save state, close admin API, exit cleanly

The daemon NEVER orphans a running cycle.

---

## 5. Configuration: `~/.agentforge/daemon.yaml`

```yaml
daemon:
  name: "agentforge-daemon"
  pidFile: ~/.agentforge/daemon.pid
  logFile: ~/.agentforge/daemon.log
  stateFile: ~/.agentforge/daemon-state.json
  adminPort: 4760

costCeilings:
  perDay: 25.00
  perWeek: 125.00
  perMonth: 400.00
  perWorkspace: {}

triggers:
  - type: schedule
    cron: "0 */4 * * *"
    workspaceId: agentforge
    enabled: true
  - type: backlog-threshold
    workspaceId: agentforge
    minTodoMarkers: 5
    minIntervalMinutes: 30
    enabled: true
  - type: queue
    workspaceId: agentforge
    enabled: true

recovery:
  consecutiveFailureLimit: 3
  retryPolicies:
    testFloor: { maxRetries: 1, backoffMinutes: 5 }
    subprocessTimeout: { maxRetries: 1, backoffMinutes: 1 }
  notifyOnFailure:
    webhook: null
    email: null

shutdown:
  gracefulTimeoutMs: 300000
  saveStateOnExit: true

logging:
  level: info
  format: json
  rotateAfterMb: 100
```

---

## 6. Admin API (port 4760)

| Endpoint | Method | Purpose |
|---|---|---|
| `/status` | GET | Current state, paused reason, current cycle, recent history, total cost |
| `/pause` | POST | Pause (no new triggers fire) |
| `/resume` | POST | Resume |
| `/trigger` | POST | Manually queue a cycle for a specific workspace |
| `/queue` | GET | Inspect manual-trigger queue |
| `/queue/:id` | DELETE | Cancel a queued trigger |
| `/cost` | GET | Day/week/month spend breakdown |
| `/triggers` | GET | List configured triggers + last-fire times |
| `/triggers/:i/enable` | POST | Toggle trigger on |
| `/triggers/:i/disable` | POST | Toggle trigger off |
| `/shutdown` | POST | Graceful shutdown |

`DaemonStatus` shape:

```typescript
interface DaemonStatus {
  state: 'running' | 'paused' | 'shutting-down' | 'crashed';
  pausedReason: string | null;
  currentCycle: { cycleId; workspaceId; stage; startedAt } | null;
  uptime: number;
  startedAt: string;
  consecutiveFailures: number;
  totalCostSpent: { today; thisWeek; thisMonth };
  costCeilings: { perDay; perWeek; perMonth };
  ceilingPctReached: { day; week; month };
  recentCycles: Array<{ cycleId; stage; cost; durationMs; finishedAt }>;
  triggers: Array<{ type; enabled; lastFiredAt; nextFireAt }>;
  queueLength: number;
}
```

---

## 7. Dashboard integration

A new `/daemon` route shows:

- **Status hero**: state badge, uptime, Pause/Resume button
- **Cost meter**: today/week/month spent vs budgets, color-coded
- **Current cycle**: if running, links to `/cycles/[id]` with budget burn
- **Recent cycles list**: last 10 with stage/cost/duration
- **Triggers panel**: enable/disable toggles + relative "next fire"
- **Queue panel**: manual queue with cancel buttons
- **Logs tail**: live SSE feed of daemon log lines

Sidebar gets a new "Daemon" section above the existing "Autonomous" group.

Home page (`/`) gets a new top-row "Daemon Status" widget.

---

## 8. Implementation Plan

### Phase 1 — Daemon core (Wave 1, ~3 parallel agents)

**Agent A**: `packages/core/src/daemon/` module (NEW)
- `daemon-runner.ts` — main loop, state, cycle launcher integration
- `daemon-state.ts` — load/save state
- `cost-ceiling.ts` — period tracking, ceiling checks, period reset
- `failure-recovery.ts` — retry policies, consecutive failure tracking
- Tests in `tests/autonomous/unit/daemon/`

**Agent B**: Trigger types (NEW)
- `triggers/schedule-trigger.ts` — cron parser + next-fire calculator
- `triggers/backlog-trigger.ts` — TODO marker counter
- `triggers/queue-trigger.ts` — manual queue
- `triggers/webhook-trigger.ts` — HTTP receiver
- `triggers/file-watcher-trigger.ts` — fs watcher with debounce
- Common `Trigger` interface; tests for each

**Agent C**: CLI command + admin API
- `packages/cli/src/commands/daemon.ts` — start/stop/status/pause/resume/trigger
- `packages/core/src/daemon/admin-api.ts` — Fastify on port 4760, bind to 127.0.0.1
- SIGINT/SIGTERM handlers
- Tests for admin endpoints

### Phase 2 — Dashboard (Wave 2, ~2 parallel agents)

**Agent D**: `/daemon` page + status widget
- `packages/dashboard/src/routes/daemon/+page.svelte`
- `packages/dashboard/src/lib/components/DaemonStatusWidget.svelte`
- Modify home page — add status widget
- SSE log feed subscription

**Agent E**: Sidebar integration + sub-pages
- Modify `Sidebar.svelte` — new "Daemon" section
- `/daemon/triggers` and `/daemon/cost` sub-pages
- Cost meter component reusable across pages

### Phase 3 — Documentation + smoke (Wave 3)

- README update
- `docs/superpowers/specs/2026-04-07-v7-daemon-quickstart.md`
- Manual smoke test procedure
- CHANGELOG entry

---

## 9. Acceptance Criteria

The daemon is shipped when ALL of these are true:

- [ ] `agentforge daemon start` launches the daemon as a background process
- [ ] `agentforge daemon status` shows the running state
- [ ] A cron-scheduled trigger fires at the configured time and launches a real cycle
- [ ] A manual queue trigger via `agentforge daemon trigger <workspaceId>` launches a cycle within 1 second
- [ ] When a cycle's cost would exceed the daily ceiling, the daemon pauses with `pausedReason: 'cost-ceiling'`
- [ ] When 3 cycles fail in a row, the daemon pauses with `pausedReason: 'consecutive-failures'`
- [ ] `agentforge daemon pause` and `agentforge daemon resume` work
- [ ] SIGINT during a running cycle waits up to 5 minutes for completion before exiting
- [ ] State persists across daemon restarts
- [ ] Dashboard `/daemon` page shows live status with current cycle + recent history + cost meter
- [ ] Home page widget shows daemon state at a glance
- [ ] All existing 348 autonomous tests still pass (no v6.6.0 regressions)
- [ ] At least 30 new tests covering daemon core + triggers + admin API + dashboard

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Daemon crashes mid-cycle, leaves orphaned subprocess | PID file + child-process lifecycle tracking; on startup, check for stale PIDs |
| Cost ceiling check races with cycle completion | Reserve estimated cost before launch; refund difference after actual cost is known |
| Cron expression with bad syntax | Validate at config load; fail loudly with line number |
| Queue grows unbounded | Cap queue length at 100; oldest items dropped with warning |
| Webhook trigger receives malicious payload | HMAC signature verification with shared secret |
| Multiple daemon instances on same machine | PID file lock — second instance refuses to start |
| Daemon eats CPU watching files | File watcher with debounce + ignored patterns |
| Admin API exposed publicly | Bind to `127.0.0.1` only by default; require explicit `--bind 0.0.0.0` to listen externally |
| State file corruption | Atomic writes via temp-file + rename; backup snapshots |
| Daemon paused but user doesn't notice | Dashboard hero card shows "PAUSED" prominently; webhook fires `daemon.paused` event |

---

## 11. Open Questions

1. **Multi-instance daemons?** — No for v7.0.0. v7.1+ if needed.
2. **Auth on admin API?** — No. Bind to 127.0.0.1 only. v8 territory.
3. **Retry on different model (sonnet → opus)?** — Yes for `scoringFallback=static`. Configurable.
4. **Missing workspace `autonomous.yaml`?** — Fall back to defaults (existing `loadCycleConfig` behavior).
5. **Slack/Discord webhook notifications?** — Yes, optional via `recovery.notifyOnFailure.webhook`. v7.0.0 ships the field; thin POST helper.

---

## 12. Estimated Scope

- **Files**: ~25 new, ~6 modified
- **LOC**: ~3,500 lines new code + tests
- **Tests**: ~50 new (~30 unit + 15 integration + 5 E2E)
- **Implementation time**: 5 parallel agents in 2 waves, ~30 minutes wall-clock with the existing parallel-agent pattern

---

## 13. Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Daemon is a separate process from the server | Keeps server stateless; allows independent restarts |
| 2 | State in JSON file at `~/.agentforge/` | No new database; share with existing workspace registry |
| 3 | Cron trigger uses standard cron syntax | Familiar; reuse existing parser libs |
| 4 | Single concurrent cycle per daemon | Simpler state machine; multi-cycle is v7.1+ |
| 5 | Cost ceilings track plan-equivalent USD | Consistent with v6.x cost reporting |
| 6 | No auth on admin API; bind 127.0.0.1 | Single-user assumption; keep complexity down |
| 7 | Retry policies are per-failure-reason | Fine-grained control; some failures shouldn't retry |
| 8 | Graceful shutdown waits for current cycle | Avoid orphaned subprocesses |
| 9 | Dashboard `/daemon` page (new) | Clear separation of concerns |
| 10 | File-watcher trigger opt-in (off by default) | Could be too noisy; users opt in |

---

## 14. What v7.0.0 unlocks for the user

```
Morning:
- User checks dashboard, sees daemon ran 3 cycles overnight
- 2 PRs are open: one is a clean fix, one needs minor changes
- User merges the clean one, comments on the second
- Daemon picks up the comment as a new TODO(autonomous) and queues a follow-up

Afternoon:
- User pushes new code with a TODO(autonomous) marker
- backlog-threshold trigger fires within an hour
- Daemon runs a cycle, opens a PR
- User reviews, merges or rejects

Evening:
- Daemon enters scheduled "improve documentation" cron window
- Cycle runs against docs/ directory
- New PR opens for review tomorrow
```

The user's role becomes **review and merge**, not **plan and execute**. AgentForge becomes a junior team member that works around the clock within budget limits.

This is the long-arc payoff of the v6.4 → v6.6.0 work: the loop is complete, the UI is real, the safety guards work, the auth uses the user's plan, the cycles produce real PRs. The only missing piece is "what makes the loop start a cycle". v7.0.0 answers that.

---

## End of design

When implementation begins:

1. Read this spec end-to-end
2. Use the existing parallel-agent dispatch pattern from v6.4.0/v6.5.0/v6.6.0 (worktrees + cherry-pick + sync)
3. Follow Phase 1 → Phase 2 → Phase 3 in §8
4. Land each phase as a separate set of commits with version bumps to v7.0.0-alpha → v7.0.0-beta → v7.0.0
5. Manual smoke test the daemon against the live AgentForge repo before declaring shipped
