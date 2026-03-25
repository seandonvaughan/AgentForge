---
description: Start from an idea and build an optimized agent team
argument-hint: Optional project description or path to brief
---

# AgentForge Genesis

You are running the AgentForge Genesis workflow — the adaptive idea-to-team pipeline.

## What Genesis Does

Genesis analyzes your project (or starts from scratch) and builds an optimized team of AI agents tailored to your specific needs. It assigns the right model tier (Opus/Sonnet/Haiku) to each agent based on task complexity.

## Workflow

1. **Discovery** — Detect what exists (codebase, docs, nothing)
2. **Context Gathering** — Scan files, git history, dependencies, documents
3. **Interview** — Ask targeted questions to fill gaps in understanding
4. **Domain Selection** — Activate relevant domain packs (software, business, marketing, etc.)
5. **Team Design** — Select agents, assign models, build collaboration topology
6. **Forge** — Write the team configuration to `.agentforge/`

## Your Task

If the user provided a description or brief, use it as the starting point. Otherwise, begin with Discovery by examining the current working directory.

Available domain packs: software, business, marketing, product, research, sales, legal, hr, it.

The agent templates are in `templates/domains/` — read them to understand what agents are available.

Key principle: **Minimize Opus usage.** Prefer many Haiku agents in parallel over few Opus agents. Only use Opus for strategic decisions that shape the entire project.

After designing the team, present it to the user for approval before writing to `.agentforge/`.
