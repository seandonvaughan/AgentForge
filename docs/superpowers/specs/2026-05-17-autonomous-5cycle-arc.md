# Autonomous 5-Cycle Arc — v17 → v22

**Author:** Claude (Opus 4.7, 1M context)
**Date:** 2026-05-17
**Target window:** v17.1.0 → v22.0.0 (five sprints, scope grows each cycle)
**Mode:** Hybrid — autonomous cycles + Claude-managed waves with audit checkpoints between each PR
**Budget:** Opus + max effort permitted; tokens are not the constraint, *throughput* and *quality* are

---

## North star

> Make AgentForge production-ready for arbitrary external projects, with team forging that
> produces *deeply specialized* agents that continuously self-improve, are fully usable in a
> regular Claude Code session, and can run **20-40+ in parallel** on isolated worktrees
> coordinated by a required `pr-merge-manager` role. Lay the groundwork for AgentForge Cloud
> (Anthropic SDK transport, no CLI) without breaking the local CLI loop.

## Cross-cutting themes (every cycle must move these forward)

1. **Specialization over generalists.** Forge must emit roles like `react-component-engineer`,
   `sqlite-migrations-specialist`, `playwright-e2e-author` — not `frontend-dev`.
2. **Continuous improvement.** Every cycle outcome feeds back into every relevant agent's
   curated `learnings:` section, gated by a reforge mutator.
3. **CC parity.** Every team agent must be invokable in a vanilla Claude Code session via the
   `Agent` tool *and* via `/agentforge:invoke` — same definition, no drift.
4. **Concurrency.** Each agent runs in its own `git worktree`; the required `pr-merge-manager`
   role handles assembly. No more main-tree branch ping-pong.
5. **Cloud-ready transport.** Cycle 5 introduces an Anthropic SDK-backed `ExecutionService`
   alongside the existing CLI transport — same surface, different backend.

## Pass/fail gates for the arc

A cycle ships only if:
- All 5 mandatory autonomy gates from v5.4 still pass (`pnpm verify:gates`)
- No regression in test count or pass rate
- A new `npx agentforge demo --project <path>` smoke run works on a fresh repo
- The `pr-merge-manager` role is present in every team after each cycle's forge run

---

## Cycle 1 — v18.0.0 — *"Specialization & the required merge manager"*

**Theme:** Make forge emit more, more-specialized agents; bake the pr-merge-manager role.

**Sprint items (target ~30):**
- T1.1 **Forge:** Replace 5 generalist templates (`coder`, `frontend-dev`, `backend-dev`,
  `dba`, `test-runner`) with 18 specialized ones (`react-component-engineer`,
  `svelte-runes-engineer`, `fastify-route-engineer`, `sqlite-schema-engineer`,
  `vitest-author`, `playwright-author`, `prompt-engineer`, etc.). Keep the generalists as
  hidden fallbacks routed by capability tags.
- T1.2 **Forge:** Require `pr-merge-manager` on every team; it cannot be removed. Add a
  team-validity guard that blocks `team.yaml` writes that omit it.
- T1.3 **`pr-merge-manager` agent:** Implementation — owns the PR queue, runs rebase/squash,
  resolves trivial merge conflicts (`.jsonl` append-only, `audit.db`, lock files), opens
  follow-up tickets for non-trivial conflicts.
- T1.4 **Capability-tag routing:** `agent-runtime/agent-router.ts` picks the most-specialized
  agent whose capability tags match the task; falls back to generalist if none match.
- T1.5 **Tests:** team-validity guard, capability router, merge-manager rebase paths.
- T1.6 **Stretch:** First slice of `/agentforge:invoke` parity work (Cycle 3 lead-in) —
  emit agent definitions to `.claude/agents/<id>.md` so CC's Agent tool can see them.

**Audit checkpoint after Cycle 1 PR:**
- Spawn 3 specialized agents in parallel from a vanilla CC session
- Verify they have distinct system prompts and different learnings sets
- Confirm a forced merge conflict gets handled by `pr-merge-manager` end-to-end

---

## Cycle 2 — v19.0.0 — *"Continuous improvement loop"*

**Theme:** Every cycle outcome becomes a learning for the agents that did the work.

**Sprint items (target ~35):**
- T2.1 **Outcome→learning pipeline:** New `learning-curator` reads `cycle-outcome.jsonl`,
  `gate-verdict.jsonl`, `review-finding.jsonl`; scores entries by recency/severity/role-tag;
  proposes updates to each agent's `learnings:` array.
- T2.2 **Mutator gate:** `reforge --apply` validates each proposed learning against the
  agent's existing learnings (no duplicates, no contradictions, dedup by semantic hash),
  caps at 12 lessons per agent (was 8).
- T2.3 **Auto-reforge hook:** Optional `--auto-reforge` flag on cycle-runner; after gate
  approval, regenerates learnings for any agent that ran in the cycle.
- T2.4 **Telemetry:** New `flywheel.continuous_improvement` metric — % of new cycle items
  whose root cause matches a learning from a *previous* cycle (target: drops over time).
- T2.5 **Cross-agent learnings:** When agent A learns "X causes Y", inject into related
  agents (B, C) via tag-similarity ≥ 0.7.
- T2.6 **Self-eval:** Each agent grades its own session at end-of-turn (1-5 scale) — feeds
  into the learning curator weighting.

**Audit checkpoint after Cycle 2 PR:**
- Run a deliberate-bug cycle, observe the learning propagate, run a second cycle, observe
  the new agent system prompt actively prevent the same bug.

---

## Cycle 3 — v20.0.0 — *"Claude Code in-session team parity"*

**Theme:** The team you forge IS the team you can call in any CC session.

**Sprint items (target ~40):**
- T3.1 **`.claude/agents/` emission:** Forge writes a CC-compatible markdown file per team
  agent (frontmatter: `name`, `description`, `tools`, optional `model`). Single source of
  truth: the `.agentforge/agents/<id>.yaml` — markdown is generated.
- T3.2 **`/agentforge:invoke` upgrade:** Becomes a thin wrapper over CC's native `Agent`
  tool when running inside a CC session (`CLAUDE_CODE_RUNTIME=1`), else falls back to the
  CLI path. Identical I/O.
- T3.3 **Memory loading parity:** When invoked via CC Agent tool, the agent still reads
  `.agentforge/memory/*.jsonl` and gets fresh-context injection.
- T3.4 **Slash-command auto-emit:** Each team role gets a slash command stub
  (`/team:<id>`) emitted to `.claude/commands/` so power users can hot-key roles.
- T3.5 **Inbox bridge in CC:** When a CC-invoked agent receives a DM in the session, the
  injection happens via `additional_directives` so user sees it as a real prompt addition.
- T3.6 **Plugin packaging:** Confirm the AgentForge plugin's `agents/` and `commands/`
  directories pick up forge-emitted files. Run `/reload-plugins` end-to-end.

**Audit checkpoint after Cycle 3 PR:**
- In a fresh CC session on AgentForge, type `/team:react-component-engineer` and run a real
  task; verify it has the same prompt, learnings, and memory access as in a cycle.

---

## Cycle 4 — v21.0.0 — *"Worktree-isolated parallel agents"*

**Theme:** Stop the main-tree branch ping-pong. Scale to 20-40 concurrent agents.

**Sprint items (target ~45):**
- T4.1 **WorktreePool:** New `packages/core/src/runtime/worktree-pool.ts` manages a pool of
  ephemeral `git worktree`s under `.agentforge/worktrees/agent-<id>-<sessionId>/`. Each
  agent gets a fresh checkout off origin/main on a uniquely-named branch.
- T4.2 **Cycle-runner integration:** `dispatchAgent()` allocates a worktree, sets `cwd`,
  passes `--workspace-dir` flag, returns the path back for diff capture.
- T4.3 **Auto-commit & push:** Coder-class agents auto-commit at end of task; push to
  remote on the unique branch; emit `agent.branch.pushed` topic.
- T4.4 **`pr-merge-manager` evolution:** Now consumes `agent.branch.pushed` events, opens
  draft PRs against the cycle's parent branch, sequences merges by dependency tag.
- T4.5 **Concurrency cap & backpressure:** `MAX_PARALLEL_AGENTS` env var (default 8, max
  40). When saturated, dispatcher enqueues with priority.
- T4.6 **Worktree GC:** Cleanup after cycle completion; keep last N for forensics.
- T4.7 **Dashboard:** New `/workspaces/active` view showing live worktrees + their agents +
  their branches.
- T4.8 **Stress test:** End-to-end test with 20 concurrent agents writing to 20 separate
  files; verify clean assembly via `pr-merge-manager`.

**Audit checkpoint after Cycle 4 PR:**
- Trigger a cycle of 25 items, watch the dashboard show 25 active worktrees, verify all
  agent diffs assemble into a single mergeable PR.

---

## Cycle 5 — v22.0.0 — *"AgentForge Cloud groundwork + multi-project"*

**Theme:** Run AgentForge against any external repo; pluggable SDK transport.

**Sprint items (target ~50):**
- T5.1 **`ExecutionService` interface:** Refactor `packages/core/src/runtime/execution-service.ts`
  to be transport-agnostic; current implementation becomes `ClaudeCliExecutionService`.
- T5.2 **Anthropic-SDK transport:** New `AnthropicSdkExecutionService` using
  `@anthropic-ai/sdk` directly. No CLI subprocess. Streams token-by-token over SSE to the
  dashboard. Cost tracking uses the API response headers.
- T5.3 **Runtime selector:** `AGENTFORGE_RUNTIME=cli|sdk` env var. SDK becomes default for
  AgentForge Cloud; CLI stays default for local CC users.
- T5.4 **Project-root portability:** `npx agentforge forge --project /path/to/external/repo`.
  All `.agentforge/` paths become relative to project root; no hardcoded monorepo
  assumptions remain.
- T5.5 **External-project onboarding doc:** `docs/quickstart-external-project.md` — fresh
  repo → first cycle in <10 minutes.
- T5.6 **Plugin packaging audit:** Ensure the AgentForge plugin works when installed in any
  CC user's environment, not just this monorepo (no relative-path leaks).
- T5.7 **Telemetry export:** Optional anonymized cycle telemetry to a remote endpoint;
  off by default; required for AgentForge Cloud.
- T5.8 **Smoke test:** End-to-end run on a small sample external repo (e.g., a Vite + React
  starter) — full cycle from forge → run → gate → PR.

**Audit checkpoint after Cycle 5 PR:**
- Initialize AgentForge in `~/Projects/test-external-repo`; run a real cycle; merge the
  resulting PR; confirm zero monorepo-path leaks in the diff.

---

## Coordination rules between Claude and the autonomous loop

- **After each cycle PR:** Claude (this assistant) manually merges (squash by default),
  reloads plugins if `.claude/agents/` or `.claude/commands/` changed, then announces the
  audit checkpoint result to the user before launching the next cycle.
- **Wave dispatch fallback:** If a cycle stalls (>2 gate rejections), Claude takes over the
  remaining items as a parallel-agent wave using the `Agent` tool with explicit
  `subagent_type` and worktree isolation. The wave's output is committed as a `wave/<vN>`
  branch that the next cycle picks up.
- **No cycle is allowed to delete tests.** Test-count must be monotonically non-decreasing.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Specialization explosion (300 agents) | Hard cap at 50 per team; capability tags collapse overlapping roles |
| Auto-reforge corrupts working agent prompts | Validation gate (T2.2) + git history of agents/ dir + `reforge --revert` |
| Worktree pool fills the disk | GC after cycle; `--max-worktree-disk` flag (default 5GB) |
| SDK transport diverges from CLI | Shared contract tests against both backends |
| External project breaks AgentForge | Cycle 5 smoke test gates the release |

---

## Open questions to validate during the arc

1. Should `pr-merge-manager` ever auto-merge to main, or always require human approval?
   (Default: human approval, configurable via team.yaml.)
2. Cross-agent learning propagation — does the tag-similarity ≥ 0.7 threshold introduce
   noise? May need to tune in Cycle 2 itself.
3. SDK transport cost vs CLI — measure side-by-side after Cycle 5.
