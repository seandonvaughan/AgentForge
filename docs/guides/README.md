# AgentForge Guides

Complete guides for using AgentForge features.

---

## Autonomous Development Loop

**The system that plans sprints, executes them, tests, commits, and opens PRs — all automatically.**

### Getting Started

Start here if you're new to autonomous cycles:

- **[Autonomous Loop Guide](./autonomous-loop.md)** — Complete overview
  - How it works (5 stages: plan, execute, test, commit, review)
  - When to use it and when to use manual dispatch
  - Running your first cycle
  - Understanding cycle output

### Reference & Configuration

Detailed reference and configuration options:

- **[Configuration Reference](./autonomous-config-reference.md)** — All `.agentforge/autonomous.yaml` options
  - Budget and cost controls
  - Time and failure limits
  - Test thresholds and quality gates
  - Git branch conventions
  - PR creation options
  - Work sourcing and filtering
  - Common configuration patterns

- **[Troubleshooting](./autonomous-troubleshooting.md)** — Common issues and solutions
  - Cycle won't start errors
  - Early termination and kill switches
  - High costs and optimizations
  - Unexpected behavior
  - Git and GitHub issues

### Quick Lookup

**"How do I..."**

| Question | Answer |
|---|---|
| Run my first autonomous cycle? | [Autonomous Loop Guide → Running a Cycle](./autonomous-loop.md#running-a-cycle) |
| Set budget limits? | [Configuration Reference → budget](./autonomous-config-reference.md#budget) |
| Mark code for autonomous work? | [Autonomous Loop Guide → TODO(autonomous) Markers](./autonomous-loop.md#todoautonomous-markers) |
| Understand cycle costs? | [Autonomous Loop Guide → Cost & Budget](./autonomous-loop.md#cost--budget) |
| Debug a failed cycle? | [Troubleshooting → Cycle Stops Early](./autonomous-troubleshooting.md#cycle-stops-early) |
| Lower my cycle costs? | [Troubleshooting → High Costs](./autonomous-troubleshooting.md#high-costs) |
| Speed up my cycle? | [Configuration Reference → limits](./autonomous-config-reference.md#limits) |
| Change PR assignment? | [Configuration Reference → pr.assignReviewer](./autonomous-config-reference.md#assignreviewer) |
| Include more work items? | [Configuration Reference → limits.maxItemsPerSprint](./autonomous-config-reference.md#maxitemsperspring) |
| Filter out vague work? | [Configuration Reference → sourcing.minProposalConfidence](./autonomous-config-reference.md#minproposalconfidence) |

---

## API Reference

**For developers integrating AgentForge or calling Claude models programmatically.**

- **[API Reference](../api-reference.md)** — Complete API documentation
  - Authentication (OAuth via Claude Code)
  - Client API (`sendMessage()` function)
  - Cost tracking and budgeting
  - Integration patterns and examples
  - Migration from API keys
  - Troubleshooting guide

---

## Key Concepts

### Cycle

One end-to-end run: plan → execute → test → commit → review. Takes 20-120 minutes depending on scope.

### Stage

One phase within a cycle (e.g., PLAN, EXECUTE, VERIFY, COMMIT, REVIEW).

### Work Item

A single task, usually from a `TODO(autonomous)` marker, test failure, or performance metric.

### Kill Switch

A safety limit (budget, duration, test floor) that halts the cycle early if exceeded.

### Diagnostic Branch

A git branch created on failure, kept for debugging (e.g., `autonomous/v6.4.2-failed`).

### Cycle Log

Structured JSON logs in `.agentforge/cycles/{cycleId}/` documenting every decision.

---

## Configuration Patterns

### Quick Start (Conservative)

Use defaults:
```yaml
# .agentforge/autonomous.yaml
# (empty, or delete the file)
# Uses: $50 budget, 95% test floor, 2-5 items per sprint
```

### Small Project

```yaml
budget:
  perCycleUsd: 20

limits:
  maxItemsPerSprint: 2
```

### Nightly CI Integration

```yaml
budget:
  perCycleUsd: 100
  allowOverageApproval: false  # No prompts during nightly run

limits:
  maxDurationMinutes: 60

pr:
  draft: true  # Always review before merge
  assignReviewer: 'your-username'
```

### Aggressive Experimentation

```yaml
budget:
  perCycleUsd: 200

limits:
  maxItemsPerSprint: 10

quality:
  testPassRateFloor: 0.90
```

See **[Configuration Reference](./autonomous-config-reference.md#common-configurations)** for more patterns.

---

## Workflow Examples

### Workflow 1: Nightly Autonomous Sprints

```bash
# .github/workflows/autonomous.yml
name: Nightly Sprint
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC

jobs:
  autonomous:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm install
      - run: npm run autonomous:cycle
        env:
          CLAUDE_SESSION_TOKEN: ${{ secrets.CLAUDE_SESSION_TOKEN }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Workflow 2: Manual Trigger with Approval

```bash
# Run locally with configuration approval
npm run autonomous:cycle

# Review the PR
# Merge if satisfied
```

### Workflow 3: Continuous Bug-Fix Cycles

Set this in `.agentforge/autonomous.yaml`:

```yaml
sourcing:
  lookbackDays: 1  # Only today's failures
  includeTodoMarkers: false  # Focus on actual failures
  
limits:
  maxItemsPerSprint: 10  # Process many small fixes

quality:
  allowRegression: false  # Prevent new breakage
```

---

## FAQ

### Can I run multiple cycles in parallel?

No. One cycle per directory at a time. However, you can:
- Run cycles on different branches sequentially
- Use different workspaces for different projects
- Schedule cycles for different times

### Can the cycle auto-merge PRs?

No. By design, humans review and merge. Auto-merge is a conscious future decision.

### What if my tests are flaky?

Flaky tests will cause cycles to fail. Recommended:
1. Fix the flaky tests first
2. Or temporarily: `quality.testPassRateFloor: 0.90` (allows 1-2 failures)
3. Better: `quality.allowRegression: false` (only new failures kill the cycle)

### Can I use this for production deployments?

Yes, with careful configuration:
1. Use conservative budget: `perCycleUsd: 25`
2. Strict quality gates: `testPassRateFloor: 0.99`
3. Manual approval: `pr.draft: true`
4. Assign reviewer: `pr.assignReviewer: 'security-lead'`
5. Start with small work items, expand as you gain confidence

### How much does it cost?

Typical cycle: **$5-15** depending on:
- Number of work items (2-5 items = $1-3 each)
- Complexity of items (simple fixes < refactors)
- Test suite size (more tests = higher verification cost)

See **[Cost & Budget](./autonomous-loop.md#cost--budget)** for examples.

### How long does a cycle take?

Typical cycle: **20-120 minutes** depending on:
- Number of items (2 items = 20-30m, 5 items = 60-120m)
- Complexity (fixes < features)
- Test suite size
- API rate limits

---

## Advanced Topics

### Custom Scoring

The default scorer uses a simple ROI formula. Future versions will support:
- Custom scoring agents
- ML-based confidence prediction
- Domain-specific weighting

For now, adjust via configuration:
```yaml
sourcing:
  minProposalConfidence: 0.7  # Stricter filtering
```

### Integration with Other Tools

- **Jira/Linear**: Convert issues to `TODO(autonomous)` comments
- **GitHub Issues**: Scanner reads issue labels
- **Slack**: Notify of cycle completion, PR links
- **Datadog**: Cost tracking via webhooks

### Durable State & Daemon (v7.0)

Future: Long-running daemon that:
- Runs cycles continuously on schedule
- Maintains state across restarts
- Publishes metrics to monitoring
- Scales horizontally with work queue

For now: Manual invocation, scheduled via cron or CI.

---

## Glossary

| Term | Definition |
|---|---|
| **Cycle** | One complete plan → execute → test → commit → review run |
| **Stage** | One of 5 phases: PLAN, STAGE, EXECUTE, VERIFY, COMMIT+REVIEW |
| **Work item** | A single task (from TODO marker, test failure, metric) |
| **Backlog** | All proposed work items for a cycle |
| **Proposal** | A candidate work item before scoring |
| **Kill switch** | Safety limit that halts the cycle (budget, duration, test floor) |
| **Diagnostic branch** | Git branch created on failure for debugging |
| **Cycle ID** | Unique identifier: `{date}-{time}-{hash}` |
| **Cost report** | JSON breakdown of token spend per phase/item |
| **Scorer** | Opus-class agent that ranks work by ROI |
| **Auto-advance** | Moving to next stage without manual intervention |

---

## Related Documentation

- **[Main README](../README.md)** — AgentForge overview
- **[Technical Design](../design.md)** — Architecture and design decisions
- **[Command Reference](../commands/)** — CLI command documentation
  - [genesis](../commands/genesis.md) — Build a team from scratch
  - [forge](../commands/forge.md) — Analyze project and generate team
  - [invoke](../commands/invoke.md) — Run a single agent
  - [reforge](../commands/reforge.md) — Update team configuration

---

## Getting Help

- **Check [Troubleshooting](./autonomous-troubleshooting.md)** — Most issues are covered there
- **Review cycle logs** — `.agentforge/cycles/{cycleId}/cycle.log`
- **Inspect execution transcript** — `.agentforge/cycles/{cycleId}/exec.log`
- **File an issue** — Include cycle ID, configuration, and error message

---

**Last updated:** April 7, 2026
