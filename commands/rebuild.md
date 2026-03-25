---
description: Re-scan project and update agent team composition
argument-hint: Optional --auto-apply or --upgrade flags
---

# AgentForge Rebuild

Re-analyze the project and propose team updates. This is the team re-scan command (formerly the base `reforge` command).

## What to Do

1. Read existing `.agentforge/analysis/project-scan.json`
2. Run a fresh project scan (files, git, dependencies, docs)
3. Compare against current team for significant changes (new frameworks, languages, dependencies)
4. If `--upgrade` flag: migrate v1 directory to v2 format first
5. Generate a team diff and present to user for approval
6. If `--auto-apply` flag or user approves: apply the diff and update `.agentforge/`

## Flags

- `--auto-apply` — Apply diff without approval prompt
- `--upgrade` — Migrate v1 team format to v2 before diffing

Note: For agent-level tuning overrides (not team re-scan), use `agentforge reforge` instead.
