---
id: af-tdd
version: "1.0"
upstream: "https://www.anthropic.com/engineering/claude-code-best-practices"
upstream_ref: "tdd-section"
tags: [tdd, testing, vitest, quality]
applies_to: [implementation, quality]
mandatory_for: [test-engineer]
max_tokens: 700
requires_tools: [Bash, Write, Edit]
applies_to_tasks: [implement-feature, fix-bug, refactor]
---

## Test-Driven Development in AgentForge

Write the test first. Run it red. Then write the minimum production code to turn it green. This discipline applies across every phase of the AgentForge autonomous cycle.

### Ground rules

1. **Red before green.** Create the test file and assert the expected behaviour before touching the implementation file. A test that passes without any implementation code was written wrong.

2. **One failing assertion at a time.** Keep each commit small enough that a single `pnpm test -- --run` shows exactly which contract you are satisfying.

3. **Tests live under `tests/`** — never under `packages/*/src/` and never as `+`-prefixed files inside `packages/dashboard/src/routes/`. SvelteKit's router treats `+`-prefixed files as route segments; placing tests there crashes `svelte-kit sync` and breaks CI within seconds.

### Running tests

```bash
# Run the full suite (all packages)
pnpm test

# Run a single test file (fastest feedback loop during TDD)
pnpm test -- --run tests/agent-runtime/skills-injection.test.ts

# Run a package's suite in watch mode during active development
pnpm --filter @agentforge/core test
```

### Cycle-phase integration

The **test phase** (phase 5 of 9) runs `pnpm test` and gates on `quality.testPassRateFloor` from `.agentforge/autonomous.yaml` (default: 0.95). If you are the agent executing the test phase:

- Parse the vitest JSON reporter output (`--reporter=json`) to compute the pass-rate ratio.
- Emit the result as a structured gate-verdict to `.agentforge/memory/gate-verdict.jsonl` so the flywheel can learn which subsystems are flaky.
- Never lower `testPassRateFloor` to make a gate pass — fix the tests.

### What good AgentForge tests look like

- **Unit tests** cover a single exported function with mocked fs/db. Avoid `existsSync` assertions on gitignored paths (they pass locally but fail in CI fresh checkouts).
- **Integration tests** spin up a real `WorkspaceAdapter` against a temp SQLite file, then call the route handler directly — no HTTP.
- **Regression tests** are named after the gate-verdict id that prompted them: `tests/regression/gv-<id>-<slug>.test.ts`.

### The flywheel connection

Every test failure surfaced by the autonomous **test phase** becomes a `review-finding.jsonl` entry. The `memory-curator` agent distils these into up to 12 lessons per agent at the next forge boundary. Writing clear failure messages (`expect(actual).toBe(expected, 'reason')`) accelerates the learning loop.
