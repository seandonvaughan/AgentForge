---
name: agentforge-cycle
description: Run AgentForge autonomous cycle checks and Codex-backed cycle execution.
---

# AgentForge Cycle

Use this skill when a user wants AgentForge to preview or run an autonomous cycle from Codex.

## Workflow

1. Verify the workspace:

```bash
corepack pnpm build
node packages/cli/dist/bin.js codex readiness --project-root .
```

2. Preview the cycle before execution:

```bash
node packages/cli/dist/bin.js cycle preview --project-root .
```

3. Run with Codex CLI execution:

```bash
AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js cycle run --project-root .
```

PowerShell:

```powershell
$env:AGENTFORGE_RUNTIME = 'codex-cli'
node packages/cli/dist/bin.js cycle run --project-root .
```

Use `--runtime codex-cli` for manual agent invokes. Codex agent subprocesses run with the default `workspace-write` sandbox; manual invokes can pass `--codex-sandbox read-only`, `--codex-sandbox workspace-write`, or `--codex-sandbox danger-full-access` when the user explicitly chooses another sandbox.
