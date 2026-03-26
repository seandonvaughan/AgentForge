---
description: View current team composition and model routing
---

# AgentForge Team

Display the current agent team composition.

Read `.agentforge/team.yaml` and show:
- Team name and forge date
- Agents organized by category (strategic, implementation, quality, utility)
- Model routing (which agents use Opus, Sonnet, Haiku)
- Delegation graph (V4 org-graph with ancestor authority)
- Active domains
- Cost optimization summary
- Autonomy tiers (if flywheel is active)

## V4 Additions

- Use `/agentforge:org graph` for the full org-graph DAG with delegation authority
- Use `/agentforge:flywheel autonomy` for agent tier promotion/demotion history
- Use `/agentforge:memory stats` for per-agent memory usage
