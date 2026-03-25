# AgentForge

**Universal Agent Team Builder**

AgentForge assembles optimized AI agent teams for any project type — software, business, marketing, research, and beyond. It ships with 59 agent templates across 9 domain packs, an adaptive Genesis workflow that guides you from idea to team, and intelligent model routing that cuts costs by ~80% vs. running everything through Opus.

## Key Features

- **9 Domain Packs** — Modular agent packs for Software, Business, Marketing, Product, Research, Sales, Legal, HR, and IT. Mix and match domains per project.
- **Genesis Workflow** — Adaptive idea-to-team pipeline (Discovery → Context → Interview → Design → Forge). Works from a blank slate or an existing codebase.
- **Collaboration Templates** — Reusable topology patterns (hierarchy, flat, matrix, hub-and-spoke, custom) that define how agents relate across domains.
- **Intelligent Model Routing** — Assigns Opus, Sonnet, or Haiku to each agent based on task complexity. Saves ~80% vs. routing all work through Opus.
- **Runtime Orchestration** — Progress ledger, loop prevention, and an event bus keep multi-agent workflows on track.
- **59 Agent Templates** — Pre-built, customizable templates across all domains plus a universal core layer.
- **Versioned Configuration** — The generated team lives in `.agentforge/` at your project root, versioned alongside your code.
- **Continuous Re-optimization** — The `reforge` workflow detects project changes and proposes team updates.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    Layer 4: Genesis                        │
│   Adaptive idea-to-team workflow engine                   │
│   (Discovery → Context → Interview → Design → Forge)     │
├──────────────────────────────────────────────────────────┤
│                Layer 3: Collaboration                      │
│   Topology templates (hierarchy, flat, matrix,            │
│   hub-and-spoke, custom) + cross-domain bridges           │
├──────────────────────────────────────────────────────────┤
│                 Layer 2: Domain Packs                      │
│   ┌─────────┬──────────┬───────────┬──────────┐          │
│   │Software │ Business │ Marketing │ Product  │ ...      │
│   │11 agents│ 6 agents │ 7 agents  │ 5 agents │          │
│   └─────────┴──────────┴───────────┴──────────┘          │
│   + Research(4) Sales(4) Legal(4) HR(4) IT(6)            │
├──────────────────────────────────────────────────────────┤
│                    Layer 1: Core                           │
│   Universal agents (Genesis, PM, Researcher, File Reader, │
│   Meta-Architect) + universal skills + base scanner       │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install the plugin
claude plugin add agentforge

# Start from an idea or existing project (new in v2)
/genesis

# Analyze a codebase and generate a software team
/forge

# Check your team composition
/team

# Re-optimize after project changes
/reforge

# Delegate a task to the best agent
/delegate "Review the authentication flow for security issues"

# Invoke a specific agent
/ask architect "Should we split the API into microservices?"
```

## Domain Packs

| Domain | Agents | Primary Use |
|--------|--------|-------------|
| Software | 11 | Code, architecture, security, testing, DevOps |
| Business | 6 | Strategy, operations, finance, stakeholder management |
| Marketing | 7 | Brand, content, campaigns, analytics |
| Product | 5 | Roadmap, discovery, prioritization, specs |
| Research | 4 | Literature review, synthesis, methodology |
| Sales | 4 | Pipeline, proposals, competitive intel |
| Legal | 4 | Contracts, compliance, risk review |
| HR | 4 | Recruiting, onboarding, policy, org design |
| IT | 6 | Infrastructure, security, support, monitoring |
| Core | 5 | Genesis, PM, Researcher, File Reader, Meta-Architect |

Total: 56 domain agents + core layer = 59 agent templates across 87 YAML definitions.

## Generated Team Structure

```
your-project/
  .agentforge/
    team.yaml              # Active team manifest
    forge.log              # Optimization history
    analysis/
      project-scan.json    # Latest scan results
    agents/
      architect.yaml       # Opus — system design, API contracts
      coder.yaml           # Sonnet — implementation, refactoring
      security.yaml        # Sonnet — vulnerability scanning
      test-engineer.yaml   # Sonnet — test generation, coverage
      researcher.yaml      # Haiku — web search, doc lookup
      ...
    skills/
      project-conventions.yaml
    config/
      models.yaml          # Model routing overrides
      delegation.yaml      # Team collaboration graph
```

## Model Routing

Intelligent routing assigns the cheapest model capable of each task. Typical savings are ~80% compared to running all work through Opus.

| Tier | Model | Use For | Cost |
|------|-------|---------|------|
| Strategic | Opus | Architecture decisions, Genesis orchestration, complex reasoning | Highest — reserved for deep reasoning |
| Implementation | Sonnet | Code generation, security analysis, test writing, coordination | Medium — workhorse for bounded tasks |
| Utility | Haiku | Web search, file reading, summarization, parallel scanning | Lowest — high volume, fast |

Delegation compounds the savings: a Sonnet coder needing API docs delegates to a Haiku researcher rather than spending Sonnet tokens on retrieval.

## Architecture

AgentForge v2 is built on four layers:

1. **Core** — Universal agents and skills present in every team regardless of domain
2. **Domain Packs** — Self-contained modules (agents, skills, scanners) for each domain
3. **Collaboration** — Topology templates and cross-domain bridges that define how agents relate
4. **Genesis** — Adaptive workflow engine that guides any project from idea to a running team

For detailed architecture and design decisions, see [docs/design.md](docs/design.md) (v1) and [docs/superpowers/specs/2026-03-25-universal-forge-design.md](docs/superpowers/specs/2026-03-25-universal-forge-design.md) (v2).

## Development

```bash
# Clone the repository
git clone https://github.com/seandonvaughan/AgentForge.git
cd AgentForge

# Install dependencies
npm install

# Build
npm run build

# Run tests (517 tests across 64 source files)
npm test

# Development mode
npm run dev
```

## Tech Stack

- **Runtime**: TypeScript / Node.js 18+
- **Agent Configs**: YAML (87 templates, human-readable, git-friendly)
- **Analysis Output**: JSON (structured, parseable, diffable)
- **CLI**: Commander.js
- **API**: Anthropic SDK (multi-model dispatch: Opus, Sonnet, Haiku)

## Roadmap

**v1 — Software Forge (complete)**

- [x] Phase 1: Foundation — Plugin skeleton, CLI, YAML schema, template library
- [x] Phase 2: Scanner — Parallel file scanner, git analyzer, dependency mapper
- [x] Phase 3: Team Builder — Template customization, project-specific agents
- [x] Phase 4: Orchestrator — Message passing, model dispatch, parallel execution
- [x] Phase 5: Reforge — Delta detection, team diff, re-optimization loop

**v2 — Universal Forge (complete)**

- [x] Phase 6: Domain Packs — 9 domain modules with 56 agent templates
- [x] Phase 7: Genesis Workflow — Adaptive idea-to-team pipeline
- [x] Phase 8: Collaboration Templates — Topology patterns and cross-domain bridges
- [x] Phase 9: Runtime Orchestration — Progress ledger, loop prevention, event bus
- [x] Phase 10: Meta-Architect — Self-improving agent that creates custom templates

**v3 — Intelligent Forge (upcoming)**

- [ ] Phase 11: Learning Engine — Track accepted vs. modified suggestions to improve forge decisions
- [ ] Phase 12: Cross-project Intelligence — Learn patterns across projects (opt-in)
- [ ] Phase 13: Real-time Dashboard — Agent activity, token spend, and task throughput
- [ ] Phase 14: Team Marketplace — Community-contributed templates for common archetypes
- [ ] Phase 15: Automated Reforge — Git hook and CI integration triggers

## License

MIT
