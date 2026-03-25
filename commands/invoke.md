---
description: Invoke an agent via AgentForgeSession
argument-hint: --agent <name> --task <description> [--budget <usd>] [--loop]
---

# AgentForge Invoke

Run a task through a specific agent using the v3 AgentForgeSession runtime. Writes a cost entry to `.agentforge/sessions/` on completion.

## Flags

- `--agent <name>` — Agent to invoke (e.g., `genesis-pipeline-dev`, `cost-engine-designer`)
- `--task <description>` — Task description to pass to the agent
- `--budget <usd>` — Optional spend cap in USD (e.g., `0.50`)
- `--loop` — Enable the control loop (experimental — runs multiple iterations until task satisfied or exit condition hit)

## What to Do

1. Read `.agentforge/team.yaml` to find the target agent and its configuration
2. Look up the agent's system prompt from `.agentforge/agents/<name>.yaml`
3. Run the agent with the given task using the appropriate model (from model_routing)
4. On completion, write a cost entry: `.agentforge/sessions/cost-entry-<sessionId>-<timestamp>.json`
5. Display the result and cost summary

## Control Loop (--loop)

When `--loop` is set, the session runs iteratively:
- Selects the next speaker each iteration
- Checks exit conditions: max iterations (20), budget exhausted, loop detected, no progress, task satisfied
- Reports exit reason on completion

Note: `--loop` is experimental. Validate results carefully before relying on multi-iteration sessions.
