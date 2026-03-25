# AgentForge

**Universal Agent Team Builder**

AgentForge assembles optimized AI agent teams for any project type — software, business, marketing, research, and beyond. Sprint 1+2 are complete with 770+ tests. The system includes intelligent model routing that cuts costs by ~80% vs. running everything through Opus, a Genesis workflow for building teams from scratch, and runtime orchestration that keeps multi-agent workflows on track.

## What Works Today (Sprint 1+2 Complete)

### Commands

- **`genesis`** — Adaptive team-building workflow
  - Auto-interview for empty projects (or use `--interview` on existing projects)
  - Discovery phase detects project state
  - Approval gate before writing `.agentforge/` (use `--yes` to skip)
  - Supports domain selection: `--domains software,business`

- **`forge`** — Analyze a codebase and generate an agent team
  - Scans project structure, dependencies, and conventions
  - Generates customized agents with appropriate model assignments
  - Produces `.agentforge/team.yaml` with team manifest

- **`invoke --agent AGENT_NAME --task "TASK_DESCRIPTION"`** — Dispatch work to a specific agent
  - Loads agent from `.agentforge/agents/{agent}.yaml`
  - Wires to AgentForgeSession for multi-agent coordination
  - Control loop available via `--loop` flag (Sprint 2 feature)
  - Set `ANTHROPIC_API_KEY` to run against live Claude API

- **`rebuild --auto-apply --upgrade`** — Re-analyze project for changes
  - `--auto-apply` applies suggested team updates automatically
  - `--upgrade` migrates v1 team.yaml to v2 format

- **`reforge` subcommands** — Team tuning and proposal management
  - `reforge apply <proposal-id>` — Apply a structural reforge proposal
  - `reforge list` — Show pending proposals
  - `reforge rollback` — Revert to previous team version
  - `reforge status` — View reforge history

- **`cost-report`** — Analyze token spend
  - Scans `.agentforge/cost-entry-*.json` files
  - Summarizes model usage and costs per agent

### Features

- **Intelligent Model Routing** — Assigns Opus for strategy, Sonnet for implementation, Haiku for utility tasks. Saves ~80% vs. running all work through Opus.

- **Filesystem Integration** — Real dispatch for `filesystem:write_file` and `filesystem:read_file` actions. Agents can read/modify project files directly.

- **Control Loop** — Multi-turn agent coordination available via `invoke --loop` (in Sprint 2).

- **AgentForgeSession** — Structured communication layer for multi-agent workflows with cost tracking and progress ledger.

## Coming in v3.1+

- **Hard Activation Command** — Explicit `--reforge-requested` flow to trigger team re-evaluation
- **Peer-to-Peer Agent Communication** — Direct agent-to-agent messaging without escalation
- **$EDITOR Flow** — Interactive editing of proposals and team configs
- **Full MCP Integration** — Extended integration with Memory, Web, Shell, and Filesystem MCPs
- **Domain Packs** — 9 modular packs (Software, Business, Marketing, Product, Research, Sales, Legal, HR, IT) with 56+ agent templates
- **Collaboration Templates** — Topology patterns (hierarchy, flat, matrix, hub-and-spoke) and cross-domain bridges

## Project Structure

```
your-project/
  .agentforge/
    team.yaml              # Active team manifest
    forge.log              # Optimization history
    analysis/
      project-scan.json    # Latest scan results
    agents/
      architect.yaml       # Agent definition
      coder.yaml           # Agent definition
      ...
    reforge-proposals/     # Pending team updates
    cost-entry-*.json      # Token spend tracking
```

## Development

```bash
# Clone the repository
git clone https://github.com/seandonvaughan/AgentForge.git
cd AgentForge

# Install dependencies
npm install

# Build
npm run build

# Run tests (770+ tests, Sprint 1+2 complete)
npm test

# Development mode
npm run dev
```

## Tech Stack

- **Runtime**: TypeScript / Node.js 18+
- **Agent Configs**: YAML (human-readable, git-friendly)
- **CLI**: Commander.js
- **API**: Anthropic SDK (multi-model dispatch: Opus, Sonnet, Haiku)
- **Testing**: Vitest

## License

MIT
