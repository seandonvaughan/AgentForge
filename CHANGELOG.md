# Changelog

All notable changes to AgentForge are documented in this file.

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
