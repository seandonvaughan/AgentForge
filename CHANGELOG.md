# Changelog

All notable changes to AgentForge are documented in this file.

## [Unreleased]

### Security and release gates

- Cleared current dependency audit findings while standardizing release support on Node `>=20.19.0`.
- Replaced Fastify static serving with containment-checked static file helpers.
- Added ESLint 9 flat config coverage for root, package, test, script, and config sources.
- Added release truth gates for version sync, CLI help output, changelog alignment, and dependency audit checks.
- Added dashboard check/build and dashboard Playwright gates to the Node `20.19.x` and `22.13.x` CI/release matrices.
- Documented the Node 20+ major-upgrade policy, SBOM, CodeQL, OSV, Gitleaks, and durable realtime job direction.

### Runtime streaming and async run execution

- Added normalized package runtime streaming support with `start`, `text_delta`, `usage_delta`, `done`, and `error` events.
- Implemented streaming paths for the Anthropic SDK transport and Claude Code compatibility transport.
- Updated `POST /api/v5/run` to return `202 Accepted` by default with a running `sessionId`, execute in the background, and stream output through `/api/v5/stream`.
- Preserved synchronous run behavior behind `?wait=true` for compatibility.

### Product structural closure

- Replaced the package CLI `init` placeholder with an idempotent workspace initialization service.
- Wired sprint execution to an injected executor when `dryRun:false` while keeping dry run as the default.
- Added proposal execution runtime hooks and a `ProposalSprintExecutor` adapter for sprint items.
- Added production git checkpoints with clean-worktree guards and explicit forced rollback support.

### Dashboard runner/live QA

- Updated the package dashboard runner to tolerate async `202 Accepted` run starts while continuing to support synchronous `200` completion responses.
- Buffered and replayed early `/api/v5/stream` run chunks by `sessionId`, then completed visible runs from `workflow_event` SSE status updates.
- Added runner operator polish: provider/runtime badges while running, first-token latency, copy/clear output controls, reconnect warnings, and paused autoscroll recovery.
- Added an explicit `/live` reconnect banner for dropped SSE connections.
- Reworked focused Playwright coverage for runner async starts, chunk replay, copy/clear controls, reconnect warning behavior, and live reconnect display.

### Docs and help truth cleanup

- Rewrote `README.md` around the actual `10.5.0` convergence state instead of the older v6/v3.1 narrative.
- Documented the real package-canonical CLI surface:
  - package-native `run`, `costs`, `cycle run`, `workspaces`, `migrate`, `info`
  - package CLI compatibility-bridged `team`, `team-sessions`, and legacy top-level aliases
- Corrected visible help text in the package CLI so `start` no longer implies it launches the server directly, and alias/bridge commands are labeled more explicitly.

## [10.5.0] - 2026-04-11

### Package-canonical convergence line

`10.5.0` is the first release line where the package stack is the documented center of gravity:

- `packages/core` owns the new execution service, provider resolver, runtime session boundary, Anthropic SDK transport, and Claude Code compatibility transport.
- `packages/server` aligns `/api/v5/run` with canonical runtime session ids and persists package-runtime metadata used by run history and cost reporting.
- `packages/dashboard` shows resolved runtime/provider information for agent runs.
- `packages/cli` exposes canonical `run`, `costs`, and `cycle` surfaces and now also carries the package-side `team` and `team-sessions` command groups, while still bridging team/manual workflows through legacy root logic where migration is not finished.

### Visible version alignment

- Workspace package versions were aligned to `10.5.0`.
- CLI and plugin-visible version surfaces were updated to read package metadata instead of stale hardcoded values.
- Root launch surfaces were kept for compatibility, but now clearly indicate that the package stack is canonical.

### Convergence status at release

- Package-native and converged:
  - `run invoke`
  - `run delegate`
  - `run history`
  - `run show`
  - `costs report`
  - `cycle run`
  - `workspaces *`
- Still compatibility-bridged at `10.5.0`:
  - `team`
  - `team forge`
  - `team genesis`
  - `team rebuild`
  - `team reforge *`
  - `team-sessions *`

### Validation completed around the convergence merge

- Focused runtime and server route tests passed on the merged `main` branch.
- Full monorepo build was later brought back to green after a strict TypeScript backlog pass across `packages/core`, `packages/embeddings`, `packages/plugins-sdk`, and strict server test files.

## [6.7.0] — 2026-04-07

### Slash command points to the canonical dashboard

The `/agentforge:dashboard` plugin command was still pointing at the legacy v4-era HTML dashboard at `dashboard/index.html`. That dashboard predates the autonomous loop work, hardcodes v6.2 in its UI, and uses a mix of `/api/v1/` and `/api/v5/` endpoints. The v6.5+ Autonomous Command Center lives in `packages/dashboard/` (SvelteKit) and is the canonical UI from v6.5 onward.

v6.7.0 updates `commands/dashboard.md` to:
1. Check if the Fastify v5 server is running on port 4750; if not, build + start it in the background
2. Check if Vite is running on port 4751; if not, start it in the background
3. Open `http://localhost:4751` in the default browser
4. Support an optional `--restart` flag to kill running instances and re-launch

The legacy `dashboard/index.html` is now explicitly marked deprecated in the slash command's notes.

### Files changed

- `commands/dashboard.md` — full rewrite to launch SvelteKit dashboard with auto-start of dev servers
- `.claude-plugin/plugin.json` — version 6.6.0 → 6.7.0
- `package.json` — version 6.6.0 → 6.7.0

### What v6.7.0 ships

This is a small patch focused on fixing the slash command and bumping versions. No new features. The autonomous loop, multi-workspace, parallel execute, file-conflict detection, SSE push, cost preview, and 9 real phase handlers from v6.4.0 → v6.6.0 are all preserved unchanged. 348 autonomous tests still passing.

---

## [6.6.0] — 2026-04-07

### Two complementary features in one release

v6.6.0 ships file-conflict detection for the parallel execute phase (originally scoped as v6.5.4) AND multi-workspace support (originally v6.6.0). Both shipped via 2 parallel agents in worktrees, zero merge conflicts.

### 1. File-conflict detection in parallel execute (Agent A)

v6.5.3 shipped parallel item dispatch but had no conflict detection — agents could race on the same file with last-writer-wins semantics. v6.6.0 adds a `FileLockManager` that serializes items with overlapping file declarations while still running disjoint items in parallel.

**How it works:**

1. Sprint items can declare an optional `files: string[]` field listing paths the item is expected to touch:
   ```json
   {
     "id": "fix-scanner",
     "title": "Fix scanner self-match",
     "assignee": "coder",
     "files": ["packages/core/src/autonomous/proposal-to-backlog.ts"]
   }
   ```
2. For items WITHOUT a `files` declaration, a heuristic regex extracts file mentions from the title and description (matches `.ts/.tsx/.js/.jsx/.md/.yaml/.json/.svelte/.css` patterns).
3. The dispatch loop now checks both **numeric parallelism** (from v6.5.3) AND **lock availability** before launching each item. Items contending for the same file wait via `Promise.race(inFlight)` until the lock is released.
4. Items with NO declared OR inferred files are conservative: they only dispatch when nothing else is in flight, and block new dispatches while running. (Empty files = "could touch anything" = serialize against everything.)

**Files modified:**
- `packages/core/src/autonomous/phase-handlers/execute-phase.ts` — `FileLockManager` class + heuristic extractor + reworked dispatch loop
- `packages/core/src/autonomous/sprint-generator.ts` — added optional `files?: string[]` to `SprintPlanItem`
- `tests/autonomous/unit/execute-phase.test.ts` — 6 new tests

### 2. Multi-workspace support (Agent B)

A single AgentForge server instance can now manage cycles across multiple project directories. Adds a global workspace registry, REST endpoints, CLI subcommands, and a dashboard switcher.

**Workspace registry**: `~/.agentforge/workspaces.json` — shared across CLI and server processes. Lists registered workspaces with `id`, `name`, `path`, `addedAt`, and a `defaultWorkspaceId`. New module `packages/core/src/autonomous/workspace-registry.ts` exports `loadWorkspaceRegistry()`, `saveWorkspaceRegistry()`, `addWorkspace()`, `removeWorkspace()`, `getWorkspace()`, `getDefaultWorkspace()`.

**Server REST endpoints**: new `packages/server/src/routes/v5/workspaces.ts`:
- `GET /api/v5/workspaces` — list all
- `POST /api/v5/workspaces` — register a new one (`{ name, path }` → 201)
- `DELETE /api/v5/workspaces/:id` — remove
- `GET /api/v5/workspaces/default` — fetch the default
- `PATCH /api/v5/workspaces/default` — set the default

**Existing cycles endpoints accept `?workspaceId=foo` query param** OR an `X-Workspace-Id` header. Looks up the workspace path via `getWorkspace(id)` and uses it as the project root for that request. Unknown workspace ID → 404 with `{ error: "workspace not found", workspaceId }`. Backwards compatible: no param = use the server's launch cwd (existing behavior).

**CLI**: `--workspace <id>` option on `autonomous:cycle`. Resolution order:
1. `--workspace` flag (explicit)
2. Registry default (only if user didn't override `--project-root`)
3. `--project-root` / `process.cwd()` (existing behavior)

New `agentforge workspaces` command with subcommands: `list`, `add <name> <path>`, `remove <id>`, `default <id>`.

**Dashboard**:
- New `packages/dashboard/src/lib/stores/workspace.ts` — Svelte store with localStorage persistence + `withWorkspace(url)` helper
- Sidebar dropdown showing the current workspace name + a list of all registered workspaces; clicking switches and reloads
- All cycles API fetches now include the current `workspaceId` query param via `withWorkspace()`
- New `/workspaces` management page with list/add/remove/set-default actions

### Test Coverage

- **348 autonomous tests passing** (was 320 in v6.5.3, +28 new)
- +6 file-conflict detection tests (Agent A)
- +9 workspace registry unit tests (Agent B)
- +13 workspaces API integration tests (Agent B)

### Files Changed

Agent A:
- `packages/core/src/autonomous/phase-handlers/execute-phase.ts`
- `packages/core/src/autonomous/sprint-generator.ts`
- `tests/autonomous/unit/execute-phase.test.ts`

Agent B:
- `packages/core/src/autonomous/workspace-registry.ts` (new)
- `packages/core/src/autonomous/index.ts` (export new module)
- `packages/server/src/routes/v5/workspaces.ts` (new)
- `packages/server/src/routes/v5/cycles.ts` (workspaceId query param)
- `packages/server/src/routes/v5/cycles-preview.ts` (same)
- `packages/server/src/server.ts` (register workspaces routes)
- `packages/cli/src/commands/workspaces.ts` (new)
- `packages/cli/src/commands/autonomous.ts` (--workspace option)
- `packages/cli/src/bin.ts` (register workspaces command)
- `packages/dashboard/src/lib/stores/workspace.ts` (new)
- `packages/dashboard/src/lib/components/Sidebar.svelte` (workspace dropdown)
- `packages/dashboard/src/routes/workspaces/+page.svelte` (new)
- `packages/dashboard/src/routes/cycles/+page.svelte` (use withWorkspace)
- `packages/dashboard/src/routes/cycles/[id]/+page.svelte` (same)
- `packages/dashboard/src/routes/cycles/new/+page.svelte` (same)
- `packages/dashboard/src/routes/+page.svelte` (same)
- `tests/autonomous/integration/workspaces-api.test.ts` (new, 13 tests)
- `tests/autonomous/unit/workspace-registry.test.ts` (new, 9 tests)

Versions: `plugin.json` 6.5.3 → 6.6.0, `package.json` 6.5.3 → 6.6.0.

### Migration / usage

```bash
# Register a workspace
agentforge workspaces add "My App" /Users/me/projects/myapp

# List workspaces
agentforge workspaces list

# Set default
agentforge workspaces default myapp

# Run a cycle against a specific workspace
agentforge autonomous:cycle --workspace myapp

# Or just use the default
agentforge autonomous:cycle

# Dashboard: workspace dropdown in the sidebar — click to switch
```

### What's still deferred (v6.6.1+)

- **Cross-workspace cycle queue** — currently each workspace runs independently. A queue that schedules cycles across workspaces (e.g., "run all default workspaces nightly") is daemon-tier work (v7.0.0).
- **Per-workspace cost ceilings** — workspaces share the global budget config. Per-workspace overrides would need a `.agentforge/autonomous.yaml` per workspace (already supported by `loadCycleConfig(cwd)` since the cwd switches per workspace, so this technically works today).
- **Workspace permissions** — no auth on the workspace endpoints. Anyone with server access can list/add/remove. v7.0.0 is when auth becomes important.

---

## [6.5.3] — 2026-04-07

### Four improvements shipped in parallel

v6.5.3 bundles four independent improvements to the autonomous cycle: parallel item dispatch, adaptive retry on item failure, SSE push updates for cycle events, and a cost preview endpoint. Three parallel agents shipped in ~5 minutes of wall-clock time.

### 1. Parallel execute phase (Agent A)

`runExecutePhase` in `packages/core/src/autonomous/phase-handlers/execute-phase.ts` now dispatches sprint items concurrently via an inline semaphore, capped at `config.limits.maxExecutePhaseParallelism` (default 3). Target speedup: ~3x on multi-item sprints.

- Uses `Promise.allSettled()` to collect every result even when some items fail
- File-conflict detection between parallel items is a known limitation for v6.5.4+; current implementation uses numeric parallelism only
- New config field: `CycleConfig.limits.maxExecutePhaseParallelism` (default 3)

### 2. Adaptive retry on item failure (Agent A)

Items that fail on first dispatch are automatically retried once with a "previous attempt failed, here's the error, please take a different approach" prompt. Bounded at 1 retry per item to prevent runaway quota burn.

- New config field: `CycleConfig.limits.maxItemRetries` (default 1)
- Per-item result in `phases/execute.json` now includes an `attempts` field showing which items needed retries
- Retry prompt includes the original task plus: `"PREVIOUS ATTEMPT FAILED:\n${lastError}\n\nPlease take a different approach..."`

### 3. SSE cycle events (Agent B)

The dashboard's cycle detail view no longer polls `/api/v5/cycles/:id/events` every 3 seconds. Instead, the server runs a filesystem watcher on `.agentforge/cycles/*/events.jsonl` and pushes new events to SSE clients in real time.

- **Server approach**: 500ms polling watcher (not `fs.watch` — more reliable cross-platform). Anchors at file size when first seen, only emits appended bytes. Works for both `POST /api/v5/cycles`-spawned cycles and manually-invoked `npm run autonomous:cycle`.
- **New cycle_event SSE type**: emitted via `globalStream.emit()` with `{ cycleId, type, phase, at, payload }` structure
- **Dashboard**: `/cycles/[id]` Events tab uses `EventSource('/api/v5/stream')`, filters by `cycleId === $page.params.id`, prepends new events. Historical load still uses the REST endpoint; switches to SSE for incremental updates. Reconnect logic mirrored from `/live/+page.svelte`.
- **Global live feed**: `/live` now recognizes `cycle_event` in its filter list — users can see cycle activity alongside other system events
- Zero re-emission of historical events on server start (watcher anchors per-cycle file size at first sight)

### 4. Cost preview endpoint (Agent C)

New `POST /api/v5/cycles/preview` endpoint runs ONLY the PLAN stage (proposal scan + scoring agent) without spawning a full cycle. Users can see projected cost + ranked items + agent rationale before clicking "Run Cycle".

- **Server**: new file `packages/server/src/routes/v5/cycles-preview.ts` (separate from `cycles.ts` to avoid merge conflicts with Agent B's SSE work). Registered alongside `cyclesRoutes` in `server.ts`.
- **Cost**: the scoring agent IS called for real (~$0.50-2.00 plan quota), but NO other agents run, NO sprint JSON written, NO files modified. Preview is a pure planning dry-run.
- **Dashboard**: `/cycles/new` now has a "Preview Cost" button next to "Run Cycle". Clicking it POSTs to `/preview` and renders a result panel with total cost vs budget, ranked items table with per-item cost/assignee/within-budget status, agent summary as blockquote, warnings list, and an overflow warning if the projected total exceeds the budget. Users can still run the cycle directly without previewing.
- Response shape:
  ```typescript
  {
    candidateCount: number;
    rankedItems: RankedItem[];
    totalEstimatedCostUsd: number;
    budgetOverflowUsd: number;
    withinBudget: number;
    requiresApproval: number;
    summary: string;
    warnings: string[];
    durationMs: number;
    scoringCostUsd: number;
    fallback: 'static' | null;
  }
  ```

### Test Coverage

- **320 autonomous tests passing** (was 300 in v6.5.2)
- +7 execute phase tests (parallel dispatch cap, retry on failure, retry prompt content, double failure, attempts field, new config defaults)
- +2 SSE watcher tests (pre-existing events not re-emitted, new events emitted correctly)
- +11 cycles-preview tests (shape validation, empty backlog, body validation, no-side-effect invariant, fallback propagation, 500 on failures)

### Files Changed

Agent A:
- `packages/core/src/autonomous/phase-handlers/execute-phase.ts` — parallel + retry
- `packages/core/src/autonomous/types.ts` — new config fields
- `packages/core/src/autonomous/config-loader.ts` — defaults
- `tests/autonomous/unit/execute-phase.test.ts` — +6 tests
- `tests/autonomous/unit/config-loader.test.ts` — +1 test

Agent B:
- `packages/server/src/routes/v5/cycles.ts` — startCycleEventsWatcher
- `packages/server/src/routes/v5/stream.ts` — cycle_event type
- `packages/dashboard/src/routes/cycles/[id]/+page.svelte` — EventSource subscription
- `packages/dashboard/src/routes/live/+page.svelte` — filter list
- `tests/autonomous/integration/cycles-api.test.ts` — +2 watcher tests

Agent C:
- `packages/server/src/routes/v5/cycles-preview.ts` (new)
- `packages/server/src/server.ts` — register cyclesPreviewRoutes
- `packages/dashboard/src/routes/cycles/new/+page.svelte` — preview button + panel
- `tests/autonomous/integration/cycles-preview.test.ts` (new, 11 tests)

Versions: `plugin.json` 6.5.2 → 6.5.3, `package.json` 6.5.2 → 6.5.3.

### Running the new features

```bash
# Preview a cycle's cost before running
curl -X POST http://localhost:4750/api/v5/cycles/preview \
  -H 'Content-Type: application/json' \
  -d '{}'
# → { candidateCount: 5, totalEstimatedCostUsd: 7.25, ... }

# Watch cycle events live
curl http://localhost:4750/api/v5/stream
# → event stream with cycle_event messages as cycles run

# Dashboard: visit /cycles/new, click "Preview Cost", see projected spend,
# then click "Run Cycle" to actually execute.
```

### What's still deferred

- **File-conflict detection between parallel execute items** — agents can currently race on the same file. Serialization on overlap is v6.5.4+ scope.
- **Retry count > 1** — bounded at 1 retry intentionally to limit quota burn. Configurable per-cycle.
- **Preview cost includes only scoring** — does not estimate execute phase agent calls. The scoring agent's per-item `estimatedCostUsd` is used for totals but execute reality may diverge.

---

## [6.5.2] — 2026-04-07

### Full executive delegation — all 9 phases are real

v6.5.2 wires the remaining 8 stub phase handlers in the CLI's autonomous cycle to real agent dispatches. Combined with v6.5.1's execute phase, **all 9 sprint phases are now real** and the cycle has the full executive delegation chain the v6.3 vision originally called for.

### The complete phase chain

| # | Phase | Agent | Tools | Role |
|---|---|---|---|---|
| 1 | **audit** | `researcher` | read-only | Scans codebase, produces audit report with recent commits, TODO markers, failing tests, cost concerns |
| 2 | **plan** | `cto` | read-only | Reads audit + sprint items, produces technical plan with execution order, risk, team allocation |
| 3 | **assign** | (keyword-based) | none | Pure data transformation — infers assignees from item tags (fix→coder, breaking→architect, etc.) |
| 4 | **execute** | per-item assignee | **Read/Write/Edit/Bash/Glob/Grep** | Dispatches each item to its assignee; the ONLY phase that modifies code |
| 5 | **test** | `backend-qa` | read-only | Analyzes execute results + git diff for testing concerns, produces risk report + 1-5 confidence |
| 6 | **review** | `code-reviewer` | read-only | Reads the diff, produces structured code review with 1-5 verdict |
| 7 | **gate** | `ceo` | read-only | Reads all prior phase outputs + test results + cost, returns APPROVE/REJECT JSON; throws `GateRejectedError` on reject |
| 8 | **release** | (metadata marker) | none | No-op phase that updates sprint JSON field + emits completion event. The real release is the commit + push + PR |
| 9 | **learn** | `data-analyst` | read-only | Writes retrospective covering what went well/poorly, cost accuracy, flaky tests, next-cycle recommendations |

Only the **execute** phase can modify source files. All other phases are analytical — they read, think, and report. This is the intended safety boundary.

### New files

Agent A (strategic phases):
- `packages/core/src/autonomous/phase-handlers/audit-phase.ts`
- `packages/core/src/autonomous/phase-handlers/plan-phase.ts`
- `packages/core/src/autonomous/phase-handlers/assign-phase.ts` (no agent call — pure keyword mapping)
- `packages/core/src/autonomous/phase-handlers/gate-phase.ts` (+ `GateRejectedError` class)
- `packages/core/src/autonomous/phase-handlers/learn-phase.ts`
- `tests/autonomous/unit/phase-handlers-strategic.test.ts` (10 tests)

Agent B (verification phases):
- `packages/core/src/autonomous/phase-handlers/test-phase.ts` (analyzes, does NOT run tests — VERIFY stage still runs real vitest)
- `packages/core/src/autonomous/phase-handlers/review-phase.ts`
- `packages/core/src/autonomous/phase-handlers/release-phase.ts` (metadata marker, no agent call)
- `tests/autonomous/unit/phase-handlers-verification.test.ts` (10 tests)

Modified:
- `packages/core/src/autonomous/phase-handlers/index.ts` — all 9 handlers exported
- `packages/cli/src/commands/autonomous.ts` — all 9 stubs replaced with real handlers (merged from 2 parallel worktrees)

### Test Coverage

- **300 autonomous tests passing** (was 280 in v6.5.1)
- +20 new tests: 10 for strategic phases, 10 for verification phases
- All mocked runtime — no real claude -p calls in tests

### `GateRejectedError`

New error class exported from `phase-handlers/index.ts`. The gate phase's CEO agent returns JSON with `{ verdict: "APPROVE" | "REJECT", rationale: string }`. On REJECT, the handler throws `GateRejectedError(rationale)`, which `CycleRunner.start()` catches at the top level and converts to `stage: failed` with the rationale stored in the new `error` field (v6.4.4 addition). The CEO can now halt a cycle that shouldn't ship.

### What this means in practice

When you run `npm run autonomous:cycle` now, the full chain runs:

1. **Audit** — researcher agent scans the repo, summary goes to phases/audit.json
2. **Plan** — CTO produces a technical plan, reads audit output for context
3. **Assign** — any unassigned items get an assignee from tag-based rules
4. **Execute** — each item dispatches to its assignee agent with full Read/Write/Edit tools. Real code changes happen.
5. **Test** — backend-qa analyzes the changes and flags testing concerns
6. **Review** — code-reviewer reads the diff and produces structured feedback
7. **Gate** — CEO reads everything and decides APPROVE/REJECT. If REJECT, cycle halts with the CEO's rationale.
8. **Release** — metadata marker; the real "release" is the commit+push+PR
9. **Learn** — data-analyst writes a retrospective for the next cycle's backlog

Each phase produces a JSON artifact in `.agentforge/cycles/{cycleId}/phases/{phase}.json` that the dashboard's detail view (v6.5.0) renders. The cycle's cost meter sums all phase costs.

### Cost estimates per cycle (approximate, plan-equivalent quota)

Based on the v6.5.1 execute phase dispatching 3 items per sprint:

| Phase | Calls | Typical quota cost |
|---|---|---|
| Plan (scoring) | 1 (backlog-scorer) | ~$1.00 |
| Audit | 1 (researcher) | ~$0.50 |
| Plan | 1 (cto) | ~$0.50 |
| Assign | 0 | $0 |
| Execute | N=3 items × assignee | ~$4.50 |
| Test | 1 (backend-qa) | ~$0.50 |
| Review | 1 (code-reviewer) | ~$1.00 |
| Gate | 1 (ceo) | ~$0.50 |
| Release | 0 | $0 |
| Learn | 1 (data-analyst) | ~$0.50 |
| **Total** | ~9 agent calls | **~$9.00/cycle** |

At ~$9/cycle, the default $50 budget comfortably runs 5+ cycles per day on plan quota without hitting the kill switch.

### Files Changed

See commits `39de05e` (strategic phases) and `e4374e6` (verification phases). Version bumps in `plugin.json` and `package.json` from 6.5.1 to 6.5.2.

### What's still deferred (v6.5.3+)

- **Parallel execute phase** — currently dispatches items sequentially. With file-conflict detection (already in `packages/core/src/orchestration/`), could run 3-5x faster.
- **SSE cycle events** — dashboard polls instead of push. Full SSE wiring would make `/live` show cycle events in real-time.
- **Cost/quota meter at cycle start** — surface plan quota consumption vs. cost in the dashboard launcher so the user sees projected cost before clicking "Run Cycle".
- **Adaptive retry in execute phase** — if an item fails, automatically retry once with a "fix this" prompt pointing at the error output.
- **Per-phase kill switches** — the CEO gate can already halt the cycle, but test and review phases could also halt on very low confidence/verdict scores.

---

## [6.5.1] — 2026-04-07

### The cycle goes from "proposer" to "doer"

v6.5.1 closes the biggest remaining architectural gap from the v6.4 design: the execute phase now dispatches sprint items to real agents that can read, edit, and write files. The autonomous cycle produces real code changes in the working tree, which the Git stage then commits into a real PR.

### What changed

**`runExecutePhase` in `packages/core/src/autonomous/phase-handlers/execute-phase.ts`** (new)

The handler:
1. Reads the sprint JSON from `.agentforge/sprints/v{version}.json`
2. For each sprint item, dispatches the `assignee` agent via `RuntimeAdapter.run(agentId, task, { allowedTools })` with a structured prompt that includes the item title, description, source, and tags
3. Captures result, updates the item's status (`completed` / `failed`) in the sprint JSON, persists after each item
4. Publishes per-item `sprint.phase.item.completed` events
5. Writes a phase JSON to `.agentforge/cycles/{cycleId}/phases/execute.json` with all item results + aggregate cost/duration
6. Publishes `sprint.phase.started`, `sprint.phase.completed`, or `sprint.phase.failed` events on the cycle bus
7. Computes phase status: `blocked` if all items fail, `failed` if > 50% fail (per `config.limits.maxExecutePhaseFailureRate`), `completed` otherwise

**`claude -p --allowed-tools` support in AgentRuntime**

- `AgentRuntime.invokeClaudeCli()` now accepts an optional `allowedTools: string[]` argument and appends `--allowed-tools <csv>` to the claude CLI args when present. Verified flag syntax with `claude --help`.
- `RunOptions` gains `allowedTools?: string[]` so individual runs can specify per-call tool access.
- `RuntimeAdapter.run()` gains a third param `options?: { responseFormat?: string; allowedTools?: string[] }` — propagates through to the underlying AgentRuntime.
- **Default for execute phase calls**: `['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']`. Explicitly omits `Task` to prevent recursive agent dispatch that would burn plan quota uncontrollably.

**CLI wiring — `packages/cli/src/commands/autonomous.ts`**

Replaces ONLY the `execute` stub handler with the real `runExecutePhase`. The other 8 phase handlers (audit/plan/assign/test/review/gate/release/learn) remain lightweight stubs that just publish `phase.completed` events — they'll be wired in v6.5.2+.

### Test pollution workaround removed

The `TEST_POLLUTION_PATTERNS` filter in `cycle-runner.ts` from v6.4.4 has been DELETED. It was a short-term workaround for tests that mutated `.agentforge/` in the real repo. v6.5.1 audits all polluting tests and rewrites them to use `os.tmpdir()` workspaces:

- `tests/e2e/cli.test.ts` — the forge test previously ran `forge` against `process.cwd()` (the real repo). Now seeds a TypeScript fixture project in `mkdtempSync(...)` and runs forge there.

All other test files that touched `.agentforge/` were audited and found to either already use tmpdir or be read-only against the real repo (no pollution).

The `.agentforge/cycles/**` filter in `collectChangedFiles` is preserved — that's a legitimate exclusion for the cycle's own log output, not a test workaround.

**Net effect**: tests no longer mutate the repo. `git status --porcelain` after running the suite is clean. The cycle's `collectChangedFiles` now reflects only what the cycle's own agents changed.

### Test Coverage

- **280 autonomous tests passing** (was 271 in v6.5.0)
- +10 new tests in `tests/autonomous/unit/execute-phase.test.ts` (mocked runtime, no real API calls)
- −1 deleted test: the v6.4.4-era test that asserted `TEST_POLLUTION_PATTERNS` behavior (its contract no longer exists)

### Files Changed

- `packages/core/src/autonomous/phase-handlers/execute-phase.ts` (new)
- `packages/core/src/autonomous/phase-handlers/index.ts` (new, barrel)
- `packages/core/src/autonomous/index.ts` (add phase-handlers barrel)
- `packages/core/src/autonomous/runtime-adapter.ts` (add allowedTools option)
- `packages/core/src/agent-runtime/agent-runtime.ts` (accept allowedTools param)
- `packages/core/src/agent-runtime/types.ts` (add allowedTools to RunOptions)
- `packages/core/src/autonomous/cycle-runner.ts` (remove TEST_POLLUTION_PATTERNS)
- `packages/cli/src/commands/autonomous.ts` (wire execute handler)
- `tests/autonomous/unit/execute-phase.test.ts` (new, 10 tests)
- `tests/autonomous/unit/cycle-runner.test.ts` (remove workaround-assertion test)
- `tests/e2e/cli.test.ts` (use tmpdir workspace)

Versions: `plugin.json` 6.5.0 → 6.5.1, `package.json` 6.5.0 → 6.5.1.

### What this means in practice

When you run `npm run autonomous:cycle` now, the execute phase will:

1. Read the sprint JSON (generated by the scoring agent in the PLAN stage)
2. For each of the top N items, dispatch to its `assignee` agent via `claude -p --allowed-tools Read,Write,Edit,Bash,Glob,Grep`
3. The agent reads source files, makes the fix, writes the result
4. The cycle's Git stage picks up the changed files via `git status --porcelain` and commits them
5. The PR contains actual code fixes, not just a sprint JSON describing what should be fixed

This is the single most important architectural change since v6.4.0. The cycle is now a real autonomous development loop, not a proposal system.

### What's still deferred (v6.5.2+)

- **Wire the other 8 phase handlers** (audit, plan, assign, test, review, gate, release, learn) to real agents. For now they're lightweight stubs that only emit events. Wiring them would give the cycle full executive delegation (CTO plans → VP distributes → Leads assign → specialists execute → reviewers check → CEO gates).
- **Drag-and-drop on the sprint kanban** (v6.5.0 deferred item)
- **SSE cycle events** push updates to `/live` feed instead of polling
- **Cost/quota meter at the cycle level** tying plan consumption to concrete cycle boundaries
- **Parallel per-item execution** in the execute phase (currently sequential for safety)

### Testing end-to-end

To run a real cycle that produces real code changes against your plan:

```bash
cd packages/core && npx tsc --noEmitOnError false && cd ../cli && npx tsc && cd ../..
node packages/cli/dist/bin.js autonomous:cycle
# ...watch it scan, score, execute, test, commit, push...
# Check the new branch for a real code change commit
```

The execute phase will make real `claude -p` calls against your logged-in Claude Code session. Each item typically costs $0.20–$3.00 in plan-equivalent quota. Default budget is $50 so even a large sprint comfortably fits.

---

## [6.5.0] — 2026-04-07

### Autonomous Command Center — dashboard UI for the v6.4 loop

v6.5.0 ships the first full-fidelity UI for the autonomous development cycle. The SvelteKit dashboard at `packages/dashboard/` now has dedicated pages for launching, monitoring, and auditing autonomous cycles, plus a refreshed home page, a sprint kanban view, and a restructured navigation with an "Autonomous" section.

Built by 4 parallel Opus agents in ~12 minutes of wall-clock time, each owning disjoint files (server routes, cycles list+detail, launcher+home, kanban+nav). Zero merge conflicts.

### New REST API (Agent A)

New file: `packages/server/src/routes/v5/cycles.ts` (+ wiring in `server.ts`).

- `GET /api/v5/cycles` — list all cycles from `.agentforge/cycles/*/cycle.json`, sorted by `startedAt` DESC. Supports `?limit=N`. Synthesizes in-progress rows from partial data when `cycle.json` doesn't exist yet.
- `GET /api/v5/cycles/:id` — raw parsed `cycle.json`. Returns 404 with `{ cycleInProgress: true }` if the dir exists but `cycle.json` doesn't.
- `GET /api/v5/cycles/:id/scoring` — parsed `scoring.json` (ScoringResult + grounding context).
- `GET /api/v5/cycles/:id/events?since=N` — parsed `events.jsonl`, supports incremental polling.
- `GET /api/v5/cycles/:id/phases/:phase` — parsed phase JSON (9-phase whitelist).
- `GET /api/v5/cycles/:id/files/:name` — tests/git/pr/approval-pending/approval-decision readers.
- `POST /api/v5/cycles` — spawns `node packages/cli/dist/bin.js autonomous:cycle` as a detached subprocess, returns 202 with `{ cycleId, startedAt, pid }`. Subprocess stdout streams to `.agentforge/cycles/{id}/cli-stdout.log`.

**Safety:** all endpoints path-sanitize via `safeJoin()` — cycle IDs validated against `/^[a-zA-Z0-9_-]+$/`, resolved paths verified to stay inside the cycles base dir (prevents traversal). 24 new tests cover happy paths, traversal rejection, sort order, 404s, and the POST spawn flow.

### New pages (Agents B, C)

**`/cycles`** — history browser. Fetches `/api/v5/cycles?limit=50`, renders a table sorted by `startedAt` DESC with stage badge, cycle ID, sprint version, duration, cost bar, test summary, PR link, approval indicator. Auto-refreshes every 5s while any cycle is in a non-terminal stage. Empty state links to `/cycles/new`.

**`/cycles/[id]`** — 5-tab detail view:
- **Overview**: stage badge, duration, cost bar, test summary, git branch + commit SHA, PR link, kill switch info
- **Scoring**: full ranked list from `scoring.json` with agent rationale, confidence, dependencies, suggested assignees
- **Events**: timeline of `events.jsonl`, polls every 3s while cycle is running
- **Phases**: lazy-loaded accordion of 9 phase JSON files
- **Files**: tabbed viewer for tests/git/pr/approval-*.json

**`/cycles/new`** — cycle launcher. Config form (budget, max items, dry-run, branch prefix, purpose comment) → POST `/api/v5/cycles`. Live 6-stage pill progress (PLAN→STAGE→RUN→VERIFY→COMMIT→REVIEW) polling `/events` every 1s, elapsed clock, budget burn bar, "View details" redirect on terminal stage.

### Home page refresh (Agent C)

`packages/dashboard/src/routes/+page.svelte` now opens with an **Autonomous Loop hero card** + CTA ("Launch New Cycle"), a **running-cycle mini panel** (shows current stage + budget burn if a cycle is live), and a **Recent Cycles list** (5 most recent, polled every 5s). All existing stat grid / agent table / sessions list content preserved below.

### Sprint kanban view (Agent D)

`packages/dashboard/src/routes/sprints/[version]/+page.svelte` now opens with a **4-column kanban** (Planned / In Progress / Completed / Blocked) above the existing sprint detail. Item cards show priority pill, title (truncated, full on hover), assignee, cost estimate, and tag pills. Columns show live counts. Cards click to expand full description inline. Responsive: stacks vertically under 900px. All existing sprint detail content preserved below.

### Navigation refresh (Agent D)

`packages/dashboard/src/lib/components/Sidebar.svelte` now groups autonomous-related routes under a new **"Autonomous"** section header: `/cycles`, `/cycles/new`, `/sprints`, `/runner`, `/live`. No existing nav entries removed — just regrouped for discoverability. Sidebar is now scrollable for overflow.

### New components + utilities

- `packages/dashboard/src/lib/components/StageBadge.svelte` — reusable colored stage badge with pulse animation for in-progress stages
- `packages/dashboard/src/lib/util/relative-time.ts` — `relativeTime()` and `formatDuration()` helpers

### Design system additions

`packages/dashboard/src/app.css` — additive only. New `@keyframes pulse` + `.pulse` utility class for active stage pills. Existing `--color-success/warning/danger/info` tokens were already present and are now reused consistently. No renames or deletions.

### Test Coverage

- **271 autonomous tests passing** (up from 247 in v6.4.4)
- +24 new tests: all in `tests/autonomous/integration/cycles-api.test.ts` covering the new REST endpoints
- svelte-check on the dashboard: no new errors from v6.5.0 files (remaining errors are pre-existing environmental issues in `runner/`, `cost/`, `sprints/[version]/`)

### Files Changed

Server:
- `packages/server/src/routes/v5/cycles.ts` (new)
- `packages/server/src/server.ts` (register cycles routes)

Dashboard:
- `packages/dashboard/src/routes/cycles/+page.svelte` (new)
- `packages/dashboard/src/routes/cycles/[id]/+page.svelte` (new)
- `packages/dashboard/src/routes/cycles/new/+page.svelte` (new)
- `packages/dashboard/src/routes/+page.svelte` (home refresh)
- `packages/dashboard/src/routes/sprints/[version]/+page.svelte` (kanban)
- `packages/dashboard/src/lib/components/Sidebar.svelte` (nav section)
- `packages/dashboard/src/lib/components/StageBadge.svelte` (new)
- `packages/dashboard/src/lib/util/relative-time.ts` (new)
- `packages/dashboard/src/app.css` (additive: pulse animation)

Tests:
- `tests/autonomous/integration/cycles-api.test.ts` (new, 24 tests)

Versions:
- `.claude-plugin/plugin.json` 6.4.4 → 6.5.0
- `package.json` 6.4.4 → 6.5.0

### What's still deferred (v6.5.1+)

- **Phase handlers still stubs** — the CLI's phaseHandlers just publish `phase.completed` events. Real per-phase agent dispatch is v6.5.1+ scope.
- **Kanban drag-and-drop** — agent D added the layout but skipped drag-reorder. Future polish.
- **SSE cycle events** — cycles update via polling, not push. Full SSE integration via `sprint.phase.*` → `/live` feed is v6.5.1 scope.
- **Test suite rewrite to tmpdir** — the `TEST_POLLUTION_PATTERNS` filter from v6.4.4 is still in place as a workaround.
- **Dashboard build environment** — worktree-based agents hit `@sveltejs/adapter-node` node_modules issues. Not a code problem; environment only.

### Running the new UI

```bash
# Start the v5 server (port 4750)
cd packages/server && npm run build && npm start

# In another terminal, start the SvelteKit dev server (port 4751)
cd packages/dashboard && npx vite --port 4751

# Visit http://localhost:4751
# Home page → Launch New Cycle → watch it run
```

---

## [6.4.4] — 2026-04-07

### What's Fixed

Six bugs surfaced by the v6.4.3 first self-directed autonomous cycle (PR #4, closed). The cycle proposed these fixes as its top-priority sprint; three parallel Opus agents implemented them in a single shipping wave.

**#1 — Scanner self-matches TODO(autonomous) in documentation strings** (`proposal-to-backlog.ts`)

The scanner's line-level regex matched `TODO(autonomous)` anywhere on a line, so source comments documenting the marker syntax got ingested as real backlog items. Fix: require the marker to be preceded only by comment characters (`//`, `/*`, `*`, `<!--`, `#`) plus optional text. Strings in code, regex literals, and object literals no longer match. The scoring agent called this out as the highest-priority fix because *"it contaminates every subsequent backlog scan and must land first."*

**#2 — CycleResult drops `error` field on FAILED stage** (`types.ts`, `cycle-runner.ts`)

When `CycleRunner.start()` caught an exception and set `stage=FAILED`, the error message was dropped because `CycleResult` had no place to store it. Downstream consumers had to reconstruct the failure from `events.jsonl`. Fix: added `error?: string` to `CycleResult` alongside `killSwitch?` and `scoringFallback?`, and made `buildResult` propagate the field.

**#3 — Test suite pollutes `.agentforge/`** (`cycle-runner.ts`)

`npm run test:run` mutates `.agentforge/agents/`, `.agentforge/v5/`, `.agentforge/analysis/`, `.agentforge/config/`, `team.yaml`, and `data/`. Then `collectChangedFiles` picked them all up via `git status --porcelain` and committed them as cycle "work product". Fix: added `TEST_POLLUTION_PATTERNS` filter in `collectChangedFiles` that excludes the six known pollution paths alongside the existing `.agentforge/cycles/**` exclusion. The real fix (tests using `os.tmpdir()` workspaces) is deferred to v6.5.0 — this is the safer short-term workaround.

**#4 — Branch name double-"v" concat** (`exec/git-ops.ts`)

`"smoke-test/autonomous-v"` + `createBranch("7.0.0")` produced `"smoke-test/autonomous-vv7.0.0"` because `GitOps.createBranch` hardcoded a `"v"` prefix after the configured branch prefix. Fix: strip a trailing `"v"` from the branch prefix before concatenation. Existing prefixes without trailing `v` are unaffected.

**#5 — PROpener requests review from PR author** (`exec/pr-opener.ts`)

Every cycle's auto-PR-creation failed because `gh pr create --reviewer <self>` is rejected by GitHub when reviewer matches the authenticated user. Fix: PROpener now queries `gh api user --jq .login` once per instance, filters the authenticated user out of the reviewers list before building args, and omits `--reviewer` entirely if the filtered list is empty. Accepts a `getAuthUser` callback for testability.

**#6 — PROpener fails hard on unknown labels** (`exec/pr-opener.ts`)

`gh pr create --label foo` fails the entire PR creation if `foo` doesn't exist on the repo. Fix: PROpener now queries `gh label list` once per instance, filters `req.labels` to only labels that exist on the repo, and logs a warning for skipped labels. Accepts a `getRepoLabels` callback for testability.

### Test Coverage

- **247 autonomous tests passing** (up from 236 in v6.4.3)
- +11 new tests: 1 for scanner strict matching, 7 for pr-opener filter logic, 3 for cycle-runner fixes
- All existing tests unchanged

### Files Changed

- `packages/core/src/autonomous/proposal-to-backlog.ts` — strict comment-prefix regex
- `packages/core/src/autonomous/exec/pr-opener.ts` — auth user + label filtering, optional callbacks
- `packages/core/src/autonomous/types.ts` — `error?: string` on `CycleResult`
- `packages/core/src/autonomous/cycle-runner.ts` — error propagation + `TEST_POLLUTION_PATTERNS` filter
- `packages/core/src/autonomous/exec/git-ops.ts` — strip trailing "v" in `createBranch`
- `tests/autonomous/unit/proposal-to-backlog.test.ts` — 1 new test
- `tests/autonomous/unit/pr-opener.test.ts` — 7 new tests
- `tests/autonomous/unit/cycle-runner.test.ts` — 2 new tests
- `tests/autonomous/unit/git-ops.test.ts` — 1 new test
- `.claude-plugin/plugin.json` — version bump to 6.4.4
- `package.json` — version bump to 6.4.4

### What this means for the autonomous loop

With these six fixes, the cycle now runs end-to-end without any manual intervention:

1. **Cleaner backlog** — the scanner no longer matches its own documentation
2. **Real debuggability** — `cycle.json` now shows WHY a cycle failed
3. **Clean commits** — test pollution no longer leaks into cycle commits
4. **Correct branch names** — no more double-v artifacts
5. **Auto PR creation works** — the self-reviewer bug and unknown-label bug no longer block `gh pr create`

The next run of `npm run autonomous:cycle` should produce a PR automatically, with no manual `gh pr create` fallback needed.

### What's still deferred

- **Phase handlers are still stubs** in the CLI path — cycles propose work but don't implement it. Real per-phase agent dispatch is scheduled for v6.5.0.
- **Tests still write to `.agentforge/`** — the pollution filter is a workaround. Test suite rewrite is v6.5.0 scope.

---

## [6.4.1-plan-auth] — 2026-04-06

### What's Fixed

- **`AgentRuntime` now uses the logged-in Claude Code session (Max/Pro plan) instead of requiring `ANTHROPIC_API_KEY`.** v6.4.0 inherited an SDK-based runtime from v5.x that hardcoded `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`, which bypassed the user's plan quota and forced a separate API key. v6.4.1 refactors `AgentRuntime.run()` and `AgentRuntime.runStreaming()` to shell out to `claude -p --output-format json` via `execFile`. The subprocess uses the logged-in OAuth session automatically.
- **New `RuntimeAdapter`** (`packages/core/src/autonomous/runtime-adapter.ts`) bridges the `AgentRuntime` class-per-agent interface to the `RuntimeForScoring` service-style interface expected by `ScoringPipeline`. Previously a silent interface mismatch would have made the autonomous cycle fail at scoring stage even with working auth. The adapter lazily loads agent YAML from `.agentforge/agents/{agentId}.yaml` and caches `AgentRuntime` instances per agentId.

### Migration Notes

- **`ANTHROPIC_API_KEY` is no longer required.** The CLI uses `claude -p` which reads OAuth credentials from the logged-in Claude Code session. Users on the Claude Max/Pro plan get autonomous cycle execution billed against plan quota instead of separate API cost.
- **`claude` CLI must be installed.** The refactor assumes `claude` is on `PATH`. If missing, `AgentRuntime.run()` throws a clear error with install instructions. Install Claude Code from https://claude.com/claude-code.
- **The `apiKey` constructor parameter on `AgentRuntime` is preserved for backward compatibility but ignored.** Existing callers that passed an API key will continue to work — the subprocess inherits `process.env` anyway.
- **Cost tracking now reflects actual billed tokens.** The claude CLI reports `total_cost_usd` in its JSON output, which includes cache creation/read overhead. This replaces the local `MODEL_PRICING` calculation as the authoritative source. The `MODEL_PRICING` table is still used as a fallback if the CLI omits cost (shouldn't happen in normal usage).
- **Streaming is degraded in v6.4.1.** `runStreaming()` no longer emits incremental token deltas — it delegates to `run()` and invokes `onChunk`/`onEvent` once at the end with the full result. Dashboard consumers will see phases transition from "running" → "completed" without live text. Proper stream-json parsing via `claude -p --output-format stream-json --include-partial-messages` is deferred to a future patch.
- **Known token overhead per call (~50K cache creation tokens).** The `claude` CLI injects a default Claude Code system context on every invocation. Using `--system-prompt` replaces the default with just the agent's own prompt, but there is still baseline overhead. For a $50/cycle budget, this is still comfortably within limits (approximately 600–1000 agent calls per cycle).

### Testing

- All 236 autonomous tests still pass unchanged (existing mocks operate at the `AgentRuntime` class level, not the SDK level).
- All 49 phase-handler regression tests still pass (the HTTP route shape and event contracts are preserved).
- No new tests added — the refactor is minimal and the existing test surface covers the behaviors that matter.

### Files Changed

- `packages/core/src/agent-runtime/agent-runtime.ts` — complete rewrite of `run()` and `runStreaming()` to use `execFile('claude', ...)`. Removes `import Anthropic from '@anthropic-ai/sdk'`.
- `packages/core/src/autonomous/runtime-adapter.ts` — new file. `RuntimeAdapter` class implementing `RuntimeForScoring`.
- `packages/core/src/autonomous/index.ts` — export the new `runtime-adapter` module.
- `docs/superpowers/specs/2026-04-06-autonomous-loop-design.md` — new §4.1 documenting plan-based auth.

### Deferred to future patches

- Proper streaming via `--output-format stream-json --include-partial-messages` (parse incremental events from subprocess stdout)
- CLI command wiring: `packages/cli/src/commands/autonomous.ts` should construct a `RuntimeAdapter` instead of a raw `AgentRuntime` (currently left as `any` cast — will be cleaned up when the command is first exercised end-to-end)
- Cache optimization: minimize per-call token overhead by investigating how to skip Claude Code's default context loading while still using the plan

---

## [6.4.0-autonomous-loop] — 2026-04-06

### What's New

The first closed self-development loop for AgentForge. `npm run autonomous:cycle` runs one supervised end-to-end cycle: plans the next sprint from session history, executes phases with real agents, runs real tests, commits to a feature branch, and opens a PR for human review.

#### New module: `packages/core/src/autonomous/`

- **`CycleRunner`** — top-level orchestrator (`cycle-runner.ts`). Drives 6 stages: PLAN → STAGE → RUN → VERIFY → COMMIT → REVIEW. Catches `CycleKilledError` at top level and produces terminal `cycle.json`.
- **`PhaseScheduler`** — event-driven phase auto-advance (`phase-scheduler.ts`). Subscribes to `sprint.phase.completed` on the EventBus and triggers the next phase in-process. Kill switch checked between every phase.
- **`KillSwitch`** — centralized safety monitor (`kill-switch.ts`) with 9 trip reasons: budget, duration, regression, testFloor, buildFailure, typeCheckFailure, consecutiveFailures, manualStop, manualStopFile. Sticky state, signal handlers, STOP file watching.
- **`GitOps`** — real git subprocess (`exec/git-ops.ts`) with 10 safety guards: refuses commits to main, secret scan (ANTHROPIC/OpenAI/GitHub PAT/AWS/private keys), dangerous path filter (.env/.pem/id_rsa), traversal prevention, `git add --` only (never -A or .), stdin-fed commit messages, post-commit branch verification, explicit file lists.
- **`PROpener`** — `gh pr create` wrapper (`exec/pr-opener.ts`) with dry-run mode for tests. Body passed via stdin to avoid shell escaping.
- **`RealTestRunner`** — shells `npm run test:run` (`exec/real-test-runner.ts`), parses vitest JSON reporter output, computes new failures vs prior snapshot.
- **`ScoringPipeline`** — agent-driven backlog ranking (`scoring-pipeline.ts`) via new `backlog-scorer` agent. 3-strike fallback ladder: retry → simpler schema → static priority ranking.
- **`BudgetApproval`** — TTY prompt + file-based polling (`budget-approval.ts`) for budget overrun approval. Supports the future daemon flow without code changes.
- **`ProposalToBacklog`** — bridges `SelfProposalEngine` → `BacklogItem[]` (`proposal-to-backlog.ts`). Scans `TODO(autonomous)` and `FIXME(autonomous)` markers (plain TODOs ignored).
- **`SprintGenerator`** — wires version bumper + sprint planning (`sprint-generator.ts`). Writes next sprint JSON with tag-driven semver.
- **`VersionBumper`** — pure function (`version-bumper.ts`) implementing `v6.4.0 → v6.5.0` (minor), `v6.4.0 → v6.4.1` (patch), `v6.4.0 → v7.0.0` (major) based on item tags.
- **`CycleLogger`** — structured per-cycle logger (`cycle-logger.ts`). Writes `.agentforge/cycles/{cycleId}/` with cycle.json, scoring.json, tests.json, git.json, pr.json, events.jsonl, and per-phase JSON.
- **`ConfigLoader`** — parses `.agentforge/autonomous.yaml` (`config-loader.ts`) over deep-frozen defaults, validates with plain TypeScript type guards.
- **`renderPrBody`** — markdown PR body template (`pr-body-renderer.ts`).

#### Refactored

- **`packages/server/src/lib/phase-handlers.ts`** — All 9 sprint phase handlers (audit/plan/assign/execute/test/review/gate/release/learn) extracted from `sprint-orchestration.ts` (1055 → 669 lines) into plain async functions. Each handler publishes `sprint.phase.started`, `sprint.phase.completed`, or `sprint.phase.failed` events. HTTP routes become thin wrappers. **Zero behavior change** — locked in by 33 regression tests captured before the refactor.

#### New CLI command

- **`npm run autonomous:cycle`** — runs one autonomous cycle. Distinct exit codes: 0 (COMPLETED), 1 (unexpected error), 2 (kill switch trip). `--dry-run` flag skips real PR creation for testing.

#### New configuration files

- **`.agentforge/autonomous.yaml`** — cycle configuration (budget, limits, quality gates, git settings, PR settings, sourcing, scoring, logging, safety). See spec §9.
- **`.agentforge/agents/backlog-scorer.yaml`** — new Sonnet-tier scoring agent for dynamic proposal ranking with structured JSON output.

#### Documentation

- **`docs/superpowers/specs/2026-04-06-autonomous-loop-design.md`** — full design spec (1865 lines, 18 sections, 16 locked-in decisions).
- **`docs/superpowers/plans/2026-04-06-autonomous-loop.md`** + `-part2.md` — TDD implementation plan (26 tasks, 6660 lines).
- **`docs/superpowers/specs/2026-04-06-autonomous-smoke-test.md`** — manual smoke test procedure for proving the loop end-to-end against the real repo.

### Test Coverage

- **236 new tests** across 20 files in `tests/autonomous/`
- Unit tests for every module with safety-guard negative tests
- Integration tests for real vitest, real git, phase handler events, regression baseline
- E2E test that runs the full cycle end-to-end with mocked Anthropic + real git + dry-run PR (1.7s)

### Locked-in Design Decisions

| Decision | Value |
|---|---|
| Autonomy level | Supervised loop (PR-based, human merges) |
| Work sourcing | Self-proposals from metrics (agent-driven scoring) |
| Budget | $50/cycle, configurable |
| Version bumping | Full semver with tag-driven major/minor/patch |
| Phase advance | Event-driven via in-process EventBus |
| Logging | Filesystem at `.agentforge/cycles/{cycleId}/`, no new DB tables |
| PR reviewer | Auto-assign `seandonvaughan` |

### Deferred (intentionally — bootstrap paradox)

These are reserved for AgentForge's first self-written sprint:
- Persistent daemon (looping CLI runs indefinitely)
- Durable state for in-memory stores (SelfProposalEngine, CanaryManager, etc.)
- Horizontal scale (Postgres, worker queue)
- Multi-workspace coordination
- Automatic PR merging
- Hiring trigger at cycle start

### Migration Notes

- Requires `gh` CLI installed and authenticated (`gh auth login`).
- Set `ANTHROPIC_API_KEY` before running `autonomous:cycle`.
- `.agentforge/autonomous.yaml` is read from the working directory; missing file uses defaults.
- The CLI requires a fresh `cd packages/cli && npx tsc` build before first use (the repo-level `npm run build` has pre-existing strict-mode errors in unrelated packages).

## [6.0.0] — 2026-03-27

### What's New

- **Execution API** — `POST /api/v5/run` triggers real AgentRuntime calls with live Anthropic API streaming. `GET /api/v5/run/:sessionId` for session retrieval. Agent YAML is resolved from `.agentforge/agents/` and model tier is mapped automatically.
- **AgentRuntime Streaming** — New `runStreaming()` method on `AgentRuntime` using the Anthropic SDK streaming API. Exposes `onChunk` and `onEvent` callbacks; output is published directly to the SSE message bus for real-time browser delivery.
- **Agent Runner Dashboard Page** — `/runner` route: enterprise UI to trigger live agent runs from the browser. Includes agent selector, task input, real-time SSE output panel, run history, and cost estimates.
- **Approvals Queue UI** — `/approvals` route: full human-in-the-loop approval workflow. Pending queue, approve/deny actions, auto-refresh, and queue stats.
- **Knowledge Graph UI** — `/knowledge` route: search, browse, and add knowledge store entries. Connects to the existing knowledge API.
- **Sprint API** — `GET /api/v5/sprints` and `GET /api/v5/sprints/:version` read `.agentforge/sprints/*.json` and normalize to a consistent schema.
- **Dashboard Navigation** — New sidebar entries: Agent Runner and Approvals under Operations; Knowledge under Intelligence.
- **Svelte 5 Migration** — Full migration from `$app/stores` to `$app/state`, reactive `$derived()` pattern, and fixed SSR hydration crashes.
- **CORS + Proxy Fix** — All API calls now use the Vite proxy (relative URLs). CORS configuration explicitly allows ports 4751 and 4752.
- **Server Route Deduplication** — Eliminated duplicate route registrations that caused "Method already declared" Fastify errors on startup.

### Breaking Changes

None.

### Migration Notes

- The dashboard requires the Svelte 5 runtime (`svelte ^5.55.0`). Ensure `packages/dashboard` dependencies are installed fresh if upgrading from v5.x.
- All dashboard API calls now use relative URLs via the Vite dev proxy (`/api/*` → `http://localhost:4750`). Any custom proxy configuration should be updated accordingly.
