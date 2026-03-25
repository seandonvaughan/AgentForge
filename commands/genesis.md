---
description: Start from an idea and build an optimized agent team
argument-hint: Optional project description, path to brief, --yes, or --interview
---

# AgentForge Genesis

You are running the AgentForge Genesis workflow — the adaptive idea-to-team pipeline.

## What Genesis Does

Genesis analyzes your project (or starts from scratch) and builds an optimized team of AI agents tailored to your specific needs. It assigns the right model tier (Opus/Sonnet/Haiku) to each agent based on task complexity.

## Workflow

1. **Discovery** — Detect what exists (codebase, docs, nothing). If `discoveryState === "empty"`, auto-trigger the interview.
2. **Context Gathering** — Scan files, git history, dependencies, documents
3. **Interview** — Ask targeted questions to fill gaps. For Research projects, ask 3 additional questions: research modality, output artifact, data sensitivity.
4. **Domain Selection** — Activate relevant domain packs (software, business, research, etc.)
5. **Team Design** — Select agents, assign models, build collaboration topology and populate `manifest.collaboration`
6. **Approval Gate** — Show a formatted team summary table (agents grouped by tier, model, roles, estimated cost savings). Prompt `y` to accept or `n` to cancel. If `--yes` flag is set, skip the gate.
7. **Forge** — Only if approved: write the team configuration to `.agentforge/` including `config/topology.yaml`

## Flags

- `--yes` — Skip the approval gate (CI/automation use)
- `--interview` — Force interview regardless of discovery state

## Your Task

If the user provided a description or brief, use it as the starting point. Otherwise, begin with Discovery by examining the current working directory.

Available domain packs: software, business, marketing, product, research, sales, legal, hr, it.

The agent templates are in `templates/domains/` — read them to understand what agents are available.

Key principle: **Minimize Opus usage.** Prefer many Haiku agents in parallel over few Opus agents. Only use Opus for strategic decisions that shape the entire project.
