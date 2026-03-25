# AgentForge

**Adaptive Agent Team Builder for Claude Code**

AgentForge is a Claude Code plugin that analyzes your software project and automatically assembles an optimized team of AI agents tailored to your project's specific needs. It ships with a library of agent templates and uses deep project analysis to customize, combine, and configure them into a purpose-built team.

## Key Features

- **Intelligent Model Routing** — Assigns the right AI model (Opus, Sonnet, or Haiku) to each agent based on task complexity. Opus handles strategic decisions, Sonnet handles implementation, and Haiku handles high-volume parallel work. Reduces per-task cost by 40-60%.
- **Deep Project Analysis** — Scans your codebase, git history, dependencies, CI configuration, and code patterns to understand your project's unique needs.
- **Customized Agent Teams** — Generates a team of specialized agents (architect, coder, security auditor, test engineer, etc.) with project-specific context injected into each agent's configuration.
- **Delegation Economics** — Any agent can delegate to shared utility agents, preventing token waste. A Sonnet coder delegates research to a Haiku researcher instead of spending expensive tokens on retrieval.
- **Versioned Configuration** — The generated team lives in `.agentforge/` at your project root, versioned alongside your codebase.
- **Continuous Re-optimization** — The `reforge` workflow detects project changes and proposes team updates, keeping your agents in sync with your evolving codebase.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│                   AgentForge                         │
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌────────────┐ │
│  │  Forge    │───▶│   Template   │───▶│  Generated │ │
│  │  Engine   │    │   Library    │    │    Team    │ │
│  │  (Opus)   │    │  (10 agents) │    │ (.agentforge/)│
│  └──────────┘    └──────────────┘    └────────────┘ │
│       │                                     │        │
│       ▼                                     ▼        │
│  ┌──────────┐                        ┌────────────┐ │
│  │  Project  │                        │Orchestrator│ │
│  │  Scanner  │                        │  Runtime   │ │
│  │(Haiku+Son)│                        │            │ │
│  └──────────┘                        └────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install the plugin
claude plugin add agentforge

# Analyze your project and generate a team
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
      security.yaml        # Sonnet — vulnerability scanning, auth review
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

| Tier | Model | Use For | Cost |
|------|-------|---------|------|
| Strategic | Opus | Architecture decisions, team composition, complex reasoning | Highest |
| Implementation | Sonnet | Code generation, security analysis, test writing | Medium |
| Utility | Haiku | Web search, file reading, linting, summarization | Lowest |

## Default Agent Templates

| Agent | Model | Role |
|-------|-------|------|
| Architect | Opus | System design, API contracts, dependency decisions |
| Coder | Sonnet | Implementation, refactoring, code generation |
| Security Auditor | Sonnet | Vulnerability scanning, auth review |
| Test Engineer | Sonnet | Test generation, coverage analysis |
| DevOps Engineer | Sonnet | CI/CD, infrastructure, deployment |
| Documentation Writer | Sonnet | README generation, API docs |
| Researcher | Haiku | Web search, documentation lookup |
| File Reader | Haiku | File summarization, content parsing |
| Linter | Haiku | Style checks, formatting |
| Test Runner | Sonnet | Execute tests, parse results |

## Architecture

AgentForge is composed of three layers:

1. **Forge Engine** — Orchestrates project analysis and team generation (Opus + parallel Haiku scanners)
2. **Agent Template Library** — Generic agent templates customized during the forge process
3. **Generated Team** — Project-specific agent configurations stored in `.agentforge/`

For detailed architecture and design decisions, see [docs/design.md](docs/design.md).

## Development

```bash
# Clone the repository
git clone https://github.com/seandonvaughan/AgentForge.git
cd AgentForge

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

## Tech Stack

- **Runtime**: TypeScript / Node.js
- **Agent Configs**: YAML (human-readable, git-friendly)
- **Analysis Output**: JSON (structured, parseable, diffable)
- **CLI**: Commander.js
- **API**: Anthropic SDK (multi-model dispatch)

## Roadmap

- [x] Phase 1: Foundation — Plugin skeleton, CLI, YAML schema, template library
- [ ] Phase 2: Scanner — Parallel file scanner, git analyzer, dependency mapper
- [ ] Phase 3: Team Builder — Template customization, project-specific agents
- [ ] Phase 4: Orchestrator — Message passing, model dispatch, parallel execution
- [ ] Phase 5: Reforge — Delta detection, team diff, re-optimization loop

## License

MIT
