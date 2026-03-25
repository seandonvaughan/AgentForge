---
id: e7f1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b
agent: vp-engineering
category: feature
priority: critical
timestamp: "2026-03-25T04:00:00.000Z"
---

# v3 Plugin Improvement: Enforce Team Routing for All Work

## Problem

When executing work (implementation plans, research, code review), the current plugin has no mechanism to ensure tasks are routed through the forged team. A user or orchestrator can easily bypass the entire team hierarchy by dispatching generic subagents — losing all the value of model routing, effort levels, escalation protocols, and feedback loops.

The team exists in `.agentforge/team.yaml` but is advisory only. Nothing enforces it.

## Recommendation

The AgentForge plugin should intercept all work dispatches and route them through the active team:

### 1. Team Activation Layer
When `.agentforge/team.yaml` exists, the plugin activates a routing layer that:
- Maps incoming tasks to the appropriate team and agent based on keywords, file patterns, and task type
- Uses the agent's configured `model` and `effort` level
- Injects the agent's `system_prompt` into the dispatch
- Follows the `delegation_graph` for sub-task routing

### 2. Dispatch Protocol
Instead of: `Agent(model: "haiku", prompt: "write tests for X")`
Route through: `Agent(model: agent.model, effort: agent.effort, prompt: agent.system_prompt + task)`

The dispatch should:
- Identify which team owns the work (based on file patterns in agent triggers)
- Route to the team lead first (Sonnet) for task decomposition
- Team lead delegates to appropriate coders (Haiku) via delegation_graph
- Results flow back up through review chain (reviews_from)

### 3. Feedback Collection
After every task completion, the executing agent should automatically submit feedback to `.agentforge/feedback/` with:
- What was done
- Cost (tokens consumed, model used)
- Confidence in the result
- Any issues encountered

### 4. v3 Plugin Hook
A `PreToolUse` hook on the `Agent` tool that:
- Checks if `.agentforge/team.yaml` exists
- If yes, rewrites the agent dispatch to use the correct team agent
- If no team is forged, falls through to default behavior

## Impact

This closes the loop between team design and team usage. Without it, AgentForge is a team DESIGNER but not a team RUNNER. With it, every interaction improves the team through feedback, and the cost optimization actually applies.

## Implementation Priority

This should be a Phase 2 or Phase 3 deliverable. It requires:
- The team manifest to be loaded at plugin startup
- A task-to-agent routing function (can reuse TaskComplexityRouter patterns)
- Integration with the feedback system
