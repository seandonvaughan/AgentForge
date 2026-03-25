---
description: Manage agent runtime overrides and tuning mutations
argument-hint: Subcommand — apply <proposal-id> | list | rollback <agent> | status
---

# AgentForge Reforge

Apply and manage per-agent tuning overrides. Does NOT re-scan the project (use `rebuild` for that).

## Subcommands

- `apply <proposal-id>` — Apply a reforge proposal (agent system prompt or config mutation)
- `list` — List all active reforge overrides
- `rollback <agent>` — Roll back a specific agent to its baseline configuration
- `status` — Show current reforge state across all agents

## What to Do

1. Read `.agentforge/` to understand current agent configurations
2. Execute the requested subcommand
3. For `apply`: validate the proposal ID, apply the override, confirm success
4. For `rollback`: restore the agent's baseline from templates or git history
5. For `list`/`status`: summarize active mutations with agent name, what changed, and when

Note: To re-scan the project and update the team composition, use `agentforge rebuild` instead.
