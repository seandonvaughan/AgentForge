# AgentForge v3 Genesis Prompt

Use this prompt with the `/genesis` command to build the v3 development team.

---

## The Prompt

```
Build a large, cost-optimized development team for AgentForge v3 — "Intelligent Forge."

PROJECT CONTEXT:
AgentForge is a Claude Code plugin that assembles optimized AI agent teams. v2 is complete with 59 agent templates across 9 domains, a Genesis workflow, collaboration templates, and runtime orchestration. The codebase is TypeScript/Node.js with 517 tests and ~34K lines of code.

V3 GOALS:
The vision for v3 is to make AgentForge a self-improving, cost-aware system that can replicate any workflow. Key objectives:

1. COST-AWARE AGENT ARCHITECTURE
   - Agents should have cost awareness built into their decision-making
   - Instead of 1 Opus coder, prefer 10 Haiku coders running in parallel for mechanical tasks
   - Each role should exist at multiple skill levels (junior/mid/senior mapped to Haiku/Sonnet/Opus)
   - Same position, different responsibility — a "security coder" vs a "frontend coder" vs a "API coder"
   - Cost budgets per task: agents should know their token budget and optimize within it
   - Pre-execution cost projection: estimate cost before running and ask for approval if over threshold

2. R&D TEAMS
   - Build R&D teams that explore new capabilities and bring proposals to management
   - R&D agents should research AI agent patterns, multi-agent frameworks, and emerging techniques
   - Each R&D team focuses on a domain: orchestration improvements, new domain packs, integration patterns, cost optimization
   - R&D agents submit improvement proposals as structured markdown files via the feedback system

3. FEEDBACK LOOP
   - Every agent should be able to submit feedback via .agentforge/feedback/
   - Feedback categories: optimization, bug, feature, process, cost, quality
   - A "Feedback Analyst" agent periodically reviews accumulated feedback and synthesizes actionable recommendations
   - Feedback drives reforge decisions — if multiple agents report the same issue, auto-propose a team change

4. TEAM COMPOSITION BY FUNCTION, NOT JOB TITLE
   - Build teams around what needs to get done, not around role labels
   - A "Core Platform Team" (type system, scanner, builder), a "Runtime Team" (orchestrator, execution), an "Experience Team" (CLI, Genesis, UX)
   - Each team gets its own collaboration topology and can work independently
   - Cross-team bridges for shared concerns (types, testing, docs)

5. WORKFLOW REPLICATION
   - The system should be able to take any described workflow and generate a team to execute it
   - Workflows are defined as sequences of agent actions with handoffs
   - The Genesis agent should be able to generate custom workflows, not just select from templates

6. COMMUNICATION & INTEGRATION
   - Agents need richer communication: structured handoffs, shared knowledge bases, decision logs
   - Integration with external tools (Jira, GitHub, Confluence) should be native, not bolted on
   - Real-time cost dashboard during execution
   - Agent-to-agent messaging beyond simple delegation

TEAM STRUCTURE:
Build teams, not a flat list of agents. Suggested structure:

- Executive Team: CTO, VP Engineering, VP Product (Opus — strategic decisions only)
- Core Platform Team: 2-3 Sonnet architects + 5-10 Haiku coders (type system, scanners, builder)
- Runtime Team: 2 Sonnet architects + 5-8 Haiku coders (orchestrator, execution engine, cost tracking)
- Experience Team: 1 Sonnet architect + 3-5 Haiku coders (CLI, Genesis workflow, documentation)
- R&D - Cost Optimization: 1 Sonnet lead + 3 Haiku researchers (model routing, parallel execution, budget management)
- R&D - Agent Intelligence: 1 Sonnet lead + 3 Haiku researchers (learning loops, feedback analysis, self-improvement)
- R&D - Integration: 1 Sonnet lead + 2 Haiku researchers (external tools, communication protocols)
- QA Team: 1 Sonnet lead + 5 Haiku testers (testing, coverage, integration tests)
- DevOps: 1 Sonnet engineer + 2 Haiku workers (CI/CD, build, deployment)

COST CONSTRAINTS:
- Minimize Opus usage — strategic decisions only, never for execution
- Prefer many Haiku agents in parallel over few Sonnet agents in sequence
- Every agent must have a model justification — why this tier for this role
- Target: <20% of token spend on Opus, >50% on Haiku

MODEL SELECTION PHILOSOPHY:
- Opus: Only for decisions that shape the entire project (architecture, strategy, team design)
- Sonnet: For bounded but complex work (code review, security analysis, test design, team leads)
- Haiku: For everything else — file scanning, code writing from specs, research, linting, testing, parallel execution

OUTPUT:
Generate a comprehensive team manifest with:
- Team structure (not flat — organized by function)
- Each agent's model tier with cost justification
- Delegation graphs within and across teams
- Collaboration topology per team
- Feedback loop configuration — which agents submit feedback, how often, who reviews
- Estimated cost profile (% by model tier)
```

## Usage

After installing AgentForge as a Claude Code plugin and restarting:

```bash
# Run genesis with the v3 prompt
/genesis --domains software,business,research

# Or paste the prompt above when genesis asks for your idea
```

The Genesis agent will analyze the current codebase, understand the v2 architecture, and build a team optimized for v3 development with proper model routing and feedback loops.
