# rebuild

Re-scan project and update agent team.

## Overview

The `rebuild` command re-analyzes your project to detect changes and update the team manifest accordingly. It replaces the old base reforge functionality and also handles v1 → v2 team format upgrades.

Use this when your codebase has evolved and you want to refresh agent assignments, add new agents for detected languages/frameworks, or remove agents that are no longer needed.

## Flags

- `--auto-apply` — Apply detected changes immediately without review
- `--upgrade` — Migrate v1 team.yaml to v2 format (runs alone, doesn't perform rebuild)

## Behavior

### Standard Rebuild

Without `--upgrade`:

1. Scans project for code, dependencies, frameworks, and git history
2. Compares against the current team manifest
3. Detects changes:
   - New agents to add
   - Agents to remove (no longer applicable)
   - Modified agents (skill/responsibility changes)
   - Model tier reassignments
   - Skill updates per agent
4. Displays a summary of proposed changes
5. Without `--auto-apply`, prompts to review before applying

### Format Upgrade

With `--upgrade`:

1. Migrates `.agentforge/team.yaml` from v1 to v2 format
2. Exits immediately (does not perform rebuild)

## Examples

### Review changes before applying
```bash
agentforge rebuild
```

Output shows agents to add/remove, modified agents, model changes, and skill updates.

### Auto-apply all detected changes
```bash
agentforge rebuild --auto-apply
```

### Upgrade team manifest format
```bash
agentforge rebuild --upgrade
```

## Output

The command displays:

- **Summary**: Overall change count
- **Agents to add**: List of new agents
- **Agents to remove**: List of agents no longer needed
- **Agents modified**: Changed agents with specific modifications
- **Model tier changes**: Agent reassignments to different model tiers
- **Skill updates**: Skill additions and removals per agent

Example:
```
Summary: 3 changes detected

Agents to add:
  + research-analyst

Agents to remove:
  - deprecated-tool

Model tier changes:
  code-writer: sonnet → opus

Run with --auto-apply to apply these changes.
```

## When to Use

- After adding new code in a different language (new agents needed)
- After removing a domain (agents become redundant)
- After framework upgrades that require different skills
- To sync the team manifest with project evolution

## Storage

Applied changes are logged to `.agentforge/reforge-history/` with timestamps for audit trails.

## Notes

- `rebuild` is safe to run multiple times; it's idempotent
- No agent code is regenerated, only assignments and manifest updates
- To regenerate agent YAML files completely, use `forge` instead

## Exit Codes

- `0` — Success
- `1` — Error during scan, comparison, or application
