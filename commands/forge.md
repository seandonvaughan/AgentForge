---
description: Analyze project and generate an optimized agent team
argument-hint: Optional --domains flag (comma-separated)
---

# AgentForge Forge

Analyze the current project and generate an optimized agent team.

## What to Do

1. Scan the project: files, git history, dependencies, CI configuration
2. Detect which domain packs should activate based on what's found
3. Compose a team from activated domain packs
4. Customize each agent template with project-specific context
5. Merge the new scan with the existing `.agentforge/team.yaml` (see Merge Behaviour below)
6. Write the merged team to `.agentforge/`
7. Display the team composition with model routing and estimated cost savings

The agent templates are in `templates/domains/`. Each domain has a `domain.yaml` manifest.

Key principle: **Cost optimization through model routing.** Show the user how much they save vs. running everything on Opus.

## Merge Behaviour

When `.agentforge/team.yaml` already exists, the forge command **merges** rather than replaces:

- **Agents** — Every agent already in `team.yaml` that is not found in the new scan is
  preserved in its original category. Newly discovered agents are added. No agent is ever
  removed. Custom categories (e.g. `ui`) are preserved alongside the standard ones.
- **model_routing** — Existing tier assignments for preserved agents are carried forward.
  New agents discovered by the scan receive tier assignments from their templates.
- **delegation_graph** — Entries not produced by the new scan (e.g. `dashboard-architect`)
  are kept. Entries that the scan does produce take the scan's value.
- **Custom metadata** — Top-level fields not managed by the scan (e.g. `team_size`,
  `version`) are carried forward from the existing manifest.
- **Timestamps** — `forged_at` and `project_hash` are always updated to reflect the
  current run.
