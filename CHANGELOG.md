# Changelog

All notable changes to AgentForge are documented in this file.

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
