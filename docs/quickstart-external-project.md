# AgentForge — External Project Quickstart

**Audience:** Claude Code user who has just installed the AgentForge plugin and wants to run a full objective cycle on an existing project.

**Time budget:** Under 10 minutes to first forge; first cycle runs unattended while you work.

**The journey:** `agentforge demo` (free smoke test) → `agentforge team forge` (build your team) → `agentforge claude setup` (wire Claude Code) → `agentforge cycle preview --objective` (cheap rehearsal) → `agentforge cycle run --objective --budget` (one PR + spend report).

---

## Section 1 — Installation

### 1.1 Prerequisites

- Claude Code installed and authenticated (`claude --version`)
- Node.js `>=22.13.0` (`node --version`)
- Git with a remote GitHub origin (the cycle opens a PR at the end)
- A GitHub personal access token with `repo` scope stored in `GH_TOKEN`

Your project's own package manager is fine as-is: AgentForge detects npm,
yarn, and pnpm toolchains from the lockfile (`package-lock.json`,
`yarn.lock`, `pnpm-lock.yaml`) and uses the matching commands automatically.

### 1.2 Install the AgentForge CLI

```bash
npm install -g @agentforge/cli
agentforge --version
```

Or use `npx` without a global install:

```bash
npx @agentforge/cli --version
```

### 1.3 Plugin auto-discovery in Claude Code

The AgentForge plugin is installed alongside the CLI. Claude Code auto-discovers it through the `.claude-plugin/plugin.json` manifest in the package directory. No manual configuration is required — the slash commands (`/agentforge:forge`, `/agentforge:invoke`, `/agentforge:status`, etc.) appear in Claude Code as soon as the package is installed.

Verify discovery:

```bash
# In a Claude Code session, type:
/agentforge:status
```

You should see the current team composition or a message indicating no team has been forged yet.

### 1.4 Required environment variables

| Variable | When required | Description |
|---|---|---|
| `GH_TOKEN` | Always | GitHub token for opening PRs. Scope: `repo`. |
| `ANTHROPIC_API_KEY` | SDK transport only | Required only if you force `AGENTFORGE_RUNTIME=sdk` (CI, AgentForge Cloud). Not needed locally — your authenticated Claude Code session is the default path. |
| `AGENTFORGE_FORGE_STRATEGY` | Optional | `agent-driven` runs the Claude-driven forge synthesis; unset defaults to the deterministic (no-LLM) forge. |

```bash
export GH_TOKEN=ghp_your_token_here
```

That is the whole required setup for local use. AgentForge is Claude-first by
default: cycles route every item to Claude, with the Codex CLI used only as
optional auxiliary capacity when its binary is present and identity-validates.
`AGENTFORGE_RUNTIME` exists as an escape hatch to pin a cycle to one provider
family — see [Runtime Modes](runtime-modes.md) before reaching for it.

---

## Section 2 — First forge against an external project

### 2.1 Smoke test with `agentforge demo` (free)

Before spending any LLM budget, verify your installation with a scan-only
demo run against your project:

```bash
agentforge demo --project /path/to/your-project
```

This runs a full scan and a deterministic forge against the target path
without any LLM calls. It prints the scan summary (files, languages,
frameworks, package manager), the agent count, and sample agent IDs. Add
`--legacy` to force the deterministic forge path explicitly. Nothing is
written to your project.

### 2.2 Point AgentForge at your project

```bash
cd /path/to/your-project
agentforge init --project-root .
```

This creates the `.agentforge/` directory structure:

```
your-project/
  .agentforge/
    agents/          # per-agent YAML files after forge
    cycles/          # per-cycle logs after cycle run
    memory/          # persistent learning files (.jsonl)
    v5/              # SQLite workspace databases
    autonomous.yaml  # cycle configuration (created by init)
    team.yaml        # team manifest (created by forge)
```

### 2.3 Run the forge

```bash
agentforge team forge --project-root /path/to/your-project --verbose
```

Or, from inside the project directory:

```bash
cd /path/to/your-project
agentforge team forge --verbose
```

`--verbose` shows the full scan: files, languages, frameworks, CI provider, dependencies, and git history. Use `--dry-run` to preview the team without writing files.

The forge is **Claude-first**: for the agent-driven pipeline (Claude recon
agents plus a strong-model synthesis pass that writes every agent's system
prompt), set:

```bash
export AGENTFORGE_FORGE_STRATEGY=agent-driven
agentforge team forge --project-root /path/to/your-project
```

Without the env var, the forge defaults to the deterministic (no-LLM) path —
always available as a fallback, but the agents it emits are generic templates
rather than project-specialized.

**Fresh-repo gap — `epic-planner` and `ceo`:** objective-mode cycles invoke
two specific agents by ID: `epic-planner` (decomposes your objective) and
`ceo` (runs the structured epic review). The built-in templates do not ship
these two yet, so on a brand-new repo hand-add
`.agentforge/agents/epic-planner.yaml` and `.agentforge/agents/ceo.yaml`
(copy them from an existing AgentForge workspace, or write minimal YAMLs with
an `id`, a `model: opus` tier, and a short `system_prompt`) until the forge
ships them. The decomposition output contract is baked into the task prompt
itself, so a minimal `epic-planner` YAML is enough — but without these files
the runtime falls back to a generic `coder` agent for planning and review,
which degrades both.

Sample output:

```
--- Scan Results ---
  Files scanned: 214
  Lines of code: 18,042
  Languages: typescript
  Frameworks: react, vite
  CI provider: github-actions
  Package manager: npm
  Production deps: 31
  Dev deps: 22
  Test frameworks: vitest
  Git commits: 183
  Contributors: 3

Team: my-project-team (12 agents)
  Strategic  (Opus):     architect, product-manager
  Impl       (Sonnet):   react-component-engineer, fastify-route-engineer, ...
  Quality    (Haiku):    vitest-author, linter, dba
  Utility    (Haiku):    documentation-writer

Written: .agentforge/team.yaml
         .agentforge/agents/*.yaml (12 files)
         .agentforge/manifest.json
```

### 2.4 Wire the project for Claude Code: `agentforge claude setup`

```bash
cd /path/to/your-project
agentforge claude setup
```

This registers the AgentForge MCP server in the project's `.mcp.json` and
re-emits any missing `.claude/agents/<id>.md` mirrors from your forged
`.agentforge/agents/*.yaml` files, so the agents and the `agentforge` MCP
tools are available the next time you open a Claude Code session in the
project. (If it warns that the MCP server build is missing, run
`corepack pnpm build` in your AgentForge checkout first.)

### 2.5 Forge via the Claude Code slash command

If you prefer to run forge from inside a Claude Code session:

```
/agentforge:forge
```

The slash command runs `agentforge team forge` against the current working directory and streams output back into the session.

### 2.6 Cost of a forge

The deterministic forge is free (no LLM calls). A full agent-driven forge costs approximately **$2.80** (parallel recon agents at Sonnet/Haiku tier, one strong-model synthesis call, one deterministic validation pass). Subsequent reforges are incremental — only agents whose subsystems changed are rewritten, typically $0.20-0.60.

---

## Section 3 — Running an objective cycle

The primary loop is **objective mode**: you supply one high-level goal and a
dollar budget; AgentForge decomposes it into a dependency-ordered epic,
executes it in waves, and ships **one PR** with a planned-vs-actual spend
report. The full operator guide is [Objective Mode](guides/objective-mode.md)
— this section is the quickstart path.

### 3.1 Configure the project for cycles

Edit `.agentforge/autonomous.yaml` (created by `init`). The built-in defaults
are tuned for a pnpm workspace, so **on an npm repo you should set the testing
commands explicitly**. A minimal example for a typical npm project:

```yaml
# .agentforge/autonomous.yaml — minimal example for an npm repo
budget:
  perCycleUsd: 50          # reference budget; --budget on the CLI overrides it

quality:
  testPassRateFloor: 0.95  # gate: at least 95% of tests must pass

git:
  branchPrefix: autonomous/
  baseBranch: main

pr:
  draft: false
  assignReviewer: your-github-username

testing:
  command: npm test                              # full-suite test command
  buildCommand: npm run build                    # build gate
  typeCheckCommand: npx tsc --noEmit --pretty false
```

The per-child verifier inside the execute phase does not use these settings —
it detects npm/yarn/pnpm from your lockfile automatically. The `testing:`
block governs the cycle-level VERIFY gate that runs on the integrated result.

### 3.2 Rehearse the decomposition (recommended first run)

```bash
agentforge cycle preview \
  --objective "Add CSV export to the reports page" \
  --budget-usd 50 \
  --project-root /path/to/your-project
```

For roughly $0.50–$2 of planner spend, the epic planner explores your
repository (read-only), decomposes the objective into child items, and
validates the plan: dependency waves, per-wave cost, and whether the child
estimates fit the budget band. Exit code `0` means the plan is valid. Nothing
is executed and no git state changes — preview artifacts land under
`.agentforge/previews/`, never under `.agentforge/cycles/`.

### 3.3 Run the cycle

```bash
agentforge cycle run \
  --objective "Add CSV export to the reports page" \
  --budget 50 \
  --project-root /path/to/your-project
```

(Equivalent shorthand: `agentforge objective "Add CSV export to the reports page" --budget 50`.)

The cycle will:

1. Decompose the objective into child items via the epic planner
2. Execute each dependency wave in parallel, in isolated git worktrees, with a deterministic per-child verify (scoped typecheck + related tests + declared-files contract)
3. Merge every verified child onto one local integration branch
4. Run a structured Opus review of the integration branch (`phases/epic-review.json`), with a bounded fix-up loop on `REQUEST_CHANGES`
5. Run your test/build/typecheck VERIFY gate
6. Open **one PR** and write `spend-report.json` reconciling planned vs actual cost per child

Use `--dry-run` to run all phases but skip opening the PR:

```bash
agentforge cycle run --objective "..." --budget 50 --dry-run
```

### 3.4 Legacy: the signal-backlog cycle

Running `agentforge cycle run` *without* `--objective` uses the legacy
signal-backlog loop: it harvests `TODO(autonomous)` markers, recent test
failures, and cost anomalies into a multi-item sprint. It still works, but
objective mode is the primary loop — see the
[Autonomous Loop Guide](guides/autonomous-loop.md) for both.

### 3.5 Run via the Claude Code slash command

```
/agentforge:dashboard
```

Opens the operator dashboard at `http://localhost:4751`. Use the **Runner** page to launch and monitor cycles interactively.

---

## Section 4 — Reading the output

### 4.1 Team manifest

After forge, your team lives at:

```
.agentforge/team.yaml
```

Individual agent definitions:

```
.agentforge/agents/<agent-name>.yaml
```

Starting from Cycle 3 (v20.0.0), forge also emits Claude Code-compatible agent definitions to:

```
.claude/agents/<agent-name>.md
```

These are auto-discovered by Claude Code so you can invoke them directly with the `Agent` tool. If any mirrors are missing (e.g. after hand-adding an agent YAML), `agentforge claude setup` re-emits them.

### 4.2 Memory accumulation

All persistent learnings accumulate under:

```
.agentforge/memory/
  cycle-outcome.jsonl     # per-cycle result records
  gate-verdict.jsonl      # pass/fail decisions with reasoning
  review-finding.jsonl    # code review findings per agent
```

These files are the flywheel. After 2-3 cycles, the forge and reforge use them to produce more specialized agents.

### 4.3 Cycle logs

Each cycle writes a structured log directory:

```
.agentforge/cycles/<cycle-id>/
  cycle.json              # top-level result (cost, tests, PR URL, stage)
  decomposition.json      # objective cycles: the epic plan + validation report
  spend-report.json       # objective cycles: planned vs actual cost per child
  phases/
    plan.json             # ranked backlog (epic children in objective mode)
    execute.json          # per-item execution records
    test.json             # test run result
    review.json           # gate verdict
    epic-review.json      # objective cycles: structured Opus verdict + faultedItems
  events.jsonl            # all bus events for replay/debugging
  approval-pending.json   # present when cycle awaits approval
  approval-decision.json  # written by `cycle approve`
```

Every completed cycle also appends one line to
`.agentforge/memory/cycle-ledger.jsonl`, which feeds cost calibration so
future epic plans on this repo use observed actuals. See
[Objective Mode § Cycle Artifacts](guides/objective-mode.md#cycle-artifacts)
for the full schemas.

List recent cycles:

```bash
agentforge cycle list --project-root /path/to/your-project
```

Inspect a specific cycle:

```bash
agentforge cycle show <cycle-id> --project-root /path/to/your-project
```

### 4.4 Dashboard

Start the operator dashboard:

```bash
agentforge start --project-root /path/to/your-project
```

Open `http://localhost:4751` to see:

- `/` — Command Center: live cycle status, agent activity, cost counters
- `/cycles` — Cycle history with phase timeline and scoring radar
- `/runner` — Launch new cycles and monitor progress
- `/memory` — Browse the knowledge base

---

## Section 5 — Troubleshooting

### "No API key found"

**Symptom:** `Anthropic SDK transport requires ANTHROPIC_API_KEY` error.

**Fix:** You are using `AGENTFORGE_RUNTIME=sdk` but haven't set the API key. Either:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or drop the escape hatch and return to the Claude-first default (uses your authenticated Claude Code CLI):

```bash
unset AGENTFORGE_RUNTIME    # default: auto
```

### "claude: command not found"

**Symptom:** Cycle fails at EXECUTE phase with a subprocess error.

**Fix:** The Claude CLI is not installed or not on PATH. Options:

1. Install Claude Code and ensure `claude` is on PATH
2. Switch to SDK transport: `export AGENTFORGE_RUNTIME=sdk` (requires `ANTHROPIC_API_KEY`)

### "Forge scan produced generic agents"

**Symptom:** Agents have names like `coder` or `frontend-dev` with vague system prompts.

**Cause:** Either the deterministic (default) forge ran — it emits template agents by design — or the agent-driven forge ran on a fresh repo with no cycle memory to specialize against yet.

**Fix:** Use the agent-driven strategy, and re-forge after 2-3 cycles have accumulated memory:

```bash
export AGENTFORGE_FORGE_STRATEGY=agent-driven
agentforge team forge --project-root /path/to/your-project
```

### "INVALID (budget): sum out of band"

**Symptom:** `cycle preview --objective` (or the plan phase) exits 1 because the planner's child estimates don't fit the budget band.

**Fix:** The planner must size the epic to fit `[0.7, 1.0] × spendable` of your budget. Either raise `--budget-usd` to give it room, or narrow the objective. See [Objective Mode § Budget Band Math](guides/objective-mode.md#budget-band-math).

### "Budget warning mid-cycle"

**Symptom:** Log line saying cumulative spend crossed the `perCycleUsd` reference ceiling.

**Fix:** The in-flight budget check is warn-only — the cycle continues to completion. The real spend control in objective mode is the `--budget` flag, which the planner sizes the whole epic against up front. Check `spend-report.json` afterwards for where the money went.

### "Cycle killed: test floor not met"

**Symptom:** Cycle terminates because tests dipped below `testPassRateFloor`.

**Fix:** Either fix the failing tests, or temporarily lower the floor:

```yaml
quality:
  testPassRateFloor: 0.90   # allow a small number of flaky tests
```

Do not set it below 0.80 in production.

### "Scan found 0 work items" (legacy signal-backlog mode only)

**Symptom:** `cycle preview` (without `--objective`) shows `Candidates: 0`.

**Fix:** This only affects the legacy signal-backlog loop — objective mode needs no markers. Either run with `--objective` instead, or add `TODO(autonomous):` markers to your codebase / check that `sourcing.lookbackDays` is long enough to see recent test failures:

```yaml
sourcing:
  lookbackDays: 14
  includeTodoMarkers: true
```

### "Every child failed verify immediately"

**Symptom:** Objective cycle children all fail their per-child verify before their code is even considered.

**Fix:** The per-child verifier picks its commands from your lockfile (`pnpm-lock.yaml` → corepack pnpm, `yarn.lock` → yarn, otherwise npx/npm). Make sure your lockfile is committed and matches the package manager you actually use. Also check `phases/execute.json` for per-item errors — a child that edits a file missing from its declared `files[]` is failed by design (scope contract).

### "Init failed: permission denied"

**Symptom:** `agentforge init` fails with a filesystem permission error.

**Fix:** Ensure the current user owns the project directory:

```bash
ls -la /path/to/your-project
```

### "No GitHub token"

**Symptom:** RELEASE phase fails when trying to open a PR.

**Fix:**

```bash
export GH_TOKEN=ghp_...
# or use the gh CLI auth flow:
gh auth login
```

---

## Section 6 — Cost reference

| Operation | Estimated cost |
|---|---|
| `agentforge demo` | $0 (no LLM calls) |
| `agentforge team forge` (deterministic default) | $0 (no LLM calls) |
| `agentforge team forge` (agent-driven, first run) | ~$2.80 |
| `agentforge team forge` (incremental reforge, 2-5 agents) | $0.20 – $0.60 |
| `agentforge cycle preview --objective` (rehearsal) | $0.50 – $2 |
| `agentforge cycle run --objective` (small feature) | $20 – $50 |
| `agentforge cycle run --objective` (large feature/refactor) | $50 – $300 |

Costs are denominated in USD against published API pricing. In objective mode
the `--budget` flag is the spend control: the planner sizes the entire epic to
fit inside it up front (with ~$6 reserved for gate/judgment overhead and a 20%
fix-up buffer), and `spend-report.json` reconciles planned vs actual
afterwards. The in-flight `perCycleUsd` check is a warn-only reference line.

To track spend across cycles:

```bash
agentforge costs report --project-root /path/to/your-project
```

---

## Related docs

- [Objective Mode](guides/objective-mode.md) — The primary loop: flags, budget-band math, artifacts, troubleshooting
- [Autonomous Loop Guide](guides/autonomous-loop.md) — Objective loop overview + the legacy signal-backlog cycle
- [Runtime Modes](runtime-modes.md) — Claude-first resolution and the `AGENTFORGE_RUNTIME` escape hatch
- [Configuration Reference](guides/autonomous-config-reference.md) — All `autonomous.yaml` options
- [Troubleshooting Guide](external-project-troubleshooting.md) — Expanded issue catalog
- [Plugin Manifest Audit](plugin-manifest-audit-2026-05-17.md) — Cross-project portability audit
- [Forge Command Reference](commands/forge.md) — All forge flags
