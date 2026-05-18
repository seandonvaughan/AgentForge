---
id: af-verify-before-done
version: "1.0"
tags: [verification, quality, gate, universal]
applies_to: [strategic, implementation, quality, utility]
max_tokens: 500
applies_to_tasks: [any]
---

## Verify Before Declaring Done

Before you report a task as complete, run the verification commands and confirm their output. Evidence before assertions — always.

### Mandatory pre-completion checklist

1. **Type-check** — `pnpm exec tsc --noEmit` must exit 0. A TypeScript error you didn't see means the next CI run will catch it.

2. **Tests** — `pnpm test -- --run <your-test-file>` must show 0 failures. If you added implementation code, at least one new test must cover it.

3. **Lint** — `pnpm exec eslint .` on the files you touched. CodeQL flags live in CI; you can catch them locally.

### AgentForge gate-verdict awareness

The **gate phase** (phase 7 of 9) runs all three checks above and records a `gate-verdict.jsonl` entry. A failing gate blocks the release phase and feeds a `[CRITICAL]` entry into the memory flywheel — every subsequent agent sees it via fresh-context injection at invocation time.

Declaring done without verifying shifts the cost from your current task to every agent in the next cycle. Verify locally; save the team the rework.

### Pre-verify typecheck pattern

```bash
# Minimum before any "done" claim:
pnpm exec tsc --noEmit && pnpm test -- --run <changed-test-file>
```

If either command fails, fix the issue before responding. Do not report partial success ("it mostly works"). The gate does not accept "mostly".
