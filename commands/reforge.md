---
description: Re-analyze project and update agent team
argument-hint: Optional --auto-apply or --upgrade flags
---

# AgentForge Reforge

Re-analyze the project and propose team updates.

1. Read existing `.agentforge/analysis/project-scan.json`
2. Run a fresh scan
3. Compare for significant changes (new frameworks, languages, dependencies)
4. If `--upgrade` flag: migrate v1 directory to v2 format
5. Otherwise: generate a team diff and present to user for approval
