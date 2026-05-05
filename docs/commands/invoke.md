# invoke

Invoke a specific agent using the v3 AgentForgeSession runtime.

## Overview

The `invoke` command runs a single agent from your team against the Claude API. It creates an AgentForgeSession, routes the task through the agent, and tracks cost, token usage, and escalations.

Requires a team manifest to be present (generated via `genesis` or `forge`). Also requires Claude Code authentication (logged-in session or `CLAUDE_SESSION_TOKEN`). See [API Reference § 1 — Authentication](../api-reference.md#-1--authentication) for setup.

## Flags

- `--agent <agent>` (required) — Name of the agent to invoke (case-insensitive, hyphen-aware matching)
- `--task <task>` (required) — Task description or prompt to send to the agent
- `--budget <usd>` — Maximum USD spend for this session (default: 1.00)

## Examples

### Invoke an agent with default budget
```bash
agentforge invoke --agent "architect" --task "Design the database schema for a blog platform"
```

### Invoke with custom budget
```bash
agentforge invoke --agent "code-writer" --task "Implement the authentication module" --budget 5.00
```

## Behavior

1. Loads the team manifest from `.agentforge/team.yaml`
2. Matches the agent name (case-insensitive) against all agents in the team
3. Loads the agent's YAML configuration from `.agentforge/agents/{agent-name}.yaml`
4. Creates an AgentForgeSession with the specified budget and configuration
5. Runs the agent with cost-aware routing enabled
6. Displays the response and usage summary

## Output

The command prints:

- **Invocation header**: Agent name, model tier, budget, and task
- **Response section**: The agent's output
- **Usage summary**: Input/output tokens and model used
- **Cost summary**: Session ID, total spent, agent runs, and budget remaining

## Cost Tracking

Each invocation is logged to `.agentforge/sessions/{session-id}.json` with:
- Token counts
- Model assignments
- Cost breakdown
- Escalation information (if any)

## Notes

- **Session routing**: All invocations route through AgentForgeSession, enabling cost tracking, review enforcement (if enabled), and potential escalations.
- **Iterative / loop mode**: Use `agentforge cycle run` for autonomous multi-sprint loops. The root `invoke` command is a single-shot compatibility shim only.

## Exit Codes

- `0` — Success
- `1` — Error (missing team, agent not found, API key not set, invocation failed)
