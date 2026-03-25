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
5. Write the team to `.agentforge/`
6. Display the team composition with model routing and estimated cost savings

The agent templates are in `templates/domains/`. Each domain has a `domain.yaml` manifest.

Key principle: **Cost optimization through model routing.** Show the user how much they save vs. running everything on Opus.
