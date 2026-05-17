# AgentForge — External Project Quickstart

**Audience:** Claude Code user who has just installed the AgentForge plugin and wants to run a full cycle on an existing project.

**Time budget:** Under 10 minutes to first forge; first cycle runs unattended while you work.

---

## Section 1 — Installation

### 1.1 Prerequisites

- Claude Code installed and authenticated (`claude --version`)
- Node.js `>=20.19.0` (`node --version`)
- `pnpm` available via Corepack (`corepack enable`)
- Git with a remote GitHub origin (the cycle opens a PR at the end)
- A GitHub personal access token with `repo` scope stored in `GH_TOKEN`

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
| `ANTHROPIC_API_KEY` | SDK runtime only | Required when `AGENTFORGE_RUNTIME=sdk`. Not needed for the default CLI runtime. |
| `AGENTFORGE_RUNTIME` | Optional | Override the execution transport. `cli` (default for local users), `sdk` (AgentForge Cloud default), `auto` (probe PATH). |

Set them in your shell profile or pass inline:

```bash
export GH_TOKEN=ghp_your_token_here
export AGENTFORGE_RUNTIME=cli          # explicit; "auto" works if claude is on PATH
```

To use the Anthropic SDK transport instead of the Claude CLI subprocess:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key
export AGENTFORGE_RUNTIME=sdk
```

You can also set `runtime:` in `.agentforge/autonomous.yaml` inside your project (env var takes precedence):

```yaml
# .agentforge/autonomous.yaml
runtime: cli   # or: sdk, auto
```

---

## Section 2 — First forge against an external project

### 2.1 Point AgentForge at your project

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

### 2.2 Run the forge

```bash
agentforge team forge --project-root /path/to/your-project --verbose
```

Or, from inside the project directory:

```bash
cd /path/to/your-project
agentforge team forge --verbose
```

`--verbose` shows the full scan: files, languages, frameworks, CI provider, dependencies, and git history. Use `--dry-run` to preview the team without writing files.

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

### 2.3 Forge via the Claude Code slash command

If you prefer to run forge from inside a Claude Code session:

```
/agentforge:forge
```

The slash command runs `agentforge team forge` against the current working directory and streams output back into the session.

### 2.4 Cost of a forge

A full forge costs approximately **$2.80** (five parallel recon agents at Sonnet/Haiku tier, one Opus synthesis call, one Sonnet validation pass). Subsequent reforges are incremental — only agents whose subsystems changed are rewritten, typically $0.20-0.60.

---

## Section 3 — Running a cycle

### 3.1 Configure the cycle budget

Edit `.agentforge/autonomous.yaml` (created by `init`) to set your budget:

```yaml
# .agentforge/autonomous.yaml
budget:
  perCycleUsd: 30          # hard cap; cycle stops if exceeded
  allowOverageApproval: true  # prompt to approve overflow items

limits:
  maxItemsPerSprint: 5     # items processed per cycle

quality:
  testPassRateFloor: 0.95  # gate: at least 95% of tests must pass

git:
  branchPrefix: autonomous/
  baseBranch: main

pr:
  draft: false
  assignReviewer: your-github-username
```

### 3.2 Mark work for the autonomous loop

The cycle planner sources work from three places:

1. `TODO(autonomous)` markers in source code:
   ```typescript
   // TODO(autonomous): extract this into a reusable hook in src/hooks/useData.ts
   ```

2. Recent test failures (auto-detected from `git log` and last test run)

3. Performance regressions and cost anomalies (read from `.agentforge/memory/`)

### 3.3 Preview the cycle (recommended first run)

```bash
agentforge cycle preview --project-root /path/to/your-project
```

Output shows the ranked backlog, estimated cost, and which items are within budget vs. overflow.

### 3.4 Run the cycle

```bash
agentforge cycle run --project-root /path/to/your-project
```

Or, from inside the project directory:

```bash
agentforge cycle run
```

The cycle runs through 9 phases: audit → plan → assign → execute → test → review → gate → release → learn. It will:

1. Scan for work and score candidates
2. Dispatch your agent team to implement items in parallel
3. Run the full test suite
4. Open a draft PR on GitHub
5. Write learnings back to `.agentforge/memory/`

Use `--dry-run` to run all phases but skip the final PR push:

```bash
agentforge cycle run --dry-run
```

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

These are auto-discovered by Claude Code so you can invoke them directly with the `Agent` tool.

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
  phases/
    plan.json             # ranked backlog
    execute.json          # per-item execution records
    test.json             # test run result
    review.json           # gate verdict
  events.jsonl            # all bus events for replay/debugging
  approval-pending.json   # present when cycle awaits approval
  approval-decision.json  # written by `cycle approve`
```

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

Or switch back to the CLI runtime:

```bash
export AGENTFORGE_RUNTIME=cli
```

### "claude: command not found"

**Symptom:** Cycle fails at EXECUTE phase with a subprocess error.

**Fix:** The Claude CLI is not installed or not on PATH. Options:

1. Install Claude Code and ensure `claude` is on PATH
2. Switch to SDK transport: `export AGENTFORGE_RUNTIME=sdk` (requires `ANTHROPIC_API_KEY`)

### "Forge scan produced generic agents"

**Symptom:** Agents have names like `coder` or `frontend-dev` with vague system prompts.

**Cause:** The agent-driven forge (v18.0.0+) uses memory from past cycles to specialize agents. On the first forge against a fresh repo there is no history yet. After 2-3 cycles the recon agents will have real data and forge will emit project-specific roles.

**Fix:** Run 2-3 cycles to accumulate memory, then:

```bash
agentforge team forge --project-root /path/to/your-project
```

### "Cycle killed: budget exceeded"

**Symptom:** Cycle terminates with `stage: KILLED, reason: budget_exceeded`.

**Fix:** Raise `perCycleUsd` in `.agentforge/autonomous.yaml`, or reduce `maxItemsPerSprint`:

```yaml
budget:
  perCycleUsd: 50
limits:
  maxItemsPerSprint: 3
```

### "Cycle killed: test floor not met"

**Symptom:** Cycle terminates because tests dipped below `testPassRateFloor`.

**Fix:** Either fix the failing tests, or temporarily lower the floor:

```yaml
quality:
  testPassRateFloor: 0.90   # allow a small number of flaky tests
```

Do not set it below 0.80 in production.

### "Scan found 0 work items"

**Symptom:** `cycle preview` shows `Candidates: 0`.

**Fix:** Add `TODO(autonomous):` markers to your codebase, or check that `sourcing.lookbackDays` is long enough to see recent test failures:

```yaml
sourcing:
  lookbackDays: 14
  includeTodoMarkers: true
```

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
| `agentforge team forge` (first run) | ~$2.80 |
| `agentforge team forge` (incremental reforge, 2-5 agents) | $0.20 – $0.60 |
| `agentforge cycle run` (3-5 items, typical) | $15 – $30 |
| `agentforge cycle run` (1-2 items, small fix) | $3 – $8 |
| `agentforge cycle run` (10+ items, large sprint) | $40 – $80 |

Costs are denominated in USD against Anthropic's published API pricing. The cycle budget cap (`perCycleUsd`) is enforced as a hard kill-switch — the cycle stops before exceeding it.

To track spend across cycles:

```bash
agentforge costs report --project-root /path/to/your-project
```

---

## Related docs

- [Autonomous Loop Guide](guides/autonomous-loop.md) — How the 9-phase cycle works in detail
- [Configuration Reference](guides/autonomous-config-reference.md) — All `autonomous.yaml` options
- [Troubleshooting Guide](external-project-troubleshooting.md) — Expanded issue catalog
- [Plugin Manifest Audit](plugin-manifest-audit-2026-05-17.md) — Cross-project portability audit
- [Forge Command Reference](commands/forge.md) — All forge flags
