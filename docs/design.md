# AgentForge Technical Design Document

**Version 1.0 | March 2026**

## 1. Overview

AgentForge is a Claude Code plugin that analyzes a software project and automatically assembles an optimized team of AI agents tailored to that project's specific needs. It ships with a library of generic agent templates (coder, architect, security auditor, researcher, etc.) and uses deep project analysis to customize, combine, and configure these templates into a purpose-built team.

The generated team is saved as a project-level plugin in a `.agentforge/` directory, making it versioned alongside the codebase and specific to each project. A re-optimization loop ("reforge") allows the team to evolve as the project changes.

### Key Differentiator

AgentForge implements intelligent model routing, assigning the right AI model (Opus, Sonnet, or Haiku) to each agent based on task complexity. Expensive models like Opus handle only strategic decisions, while Haiku handles high-volume parallel work like web research and file scanning. Any agent on the team can delegate to shared utility agents, preventing token waste.

## 2. Problem Statement

Current multi-agent coding workflows suffer from three core issues:

1. **One-size-fits-all agents**: Generic assistants lack the specialized knowledge needed for security auditing, architecture review, or domain-specific coding patterns.
2. **No model cost optimization**: Most setups run every task through the same model, wasting expensive Opus tokens on tasks that Haiku could handle.
3. **No project awareness**: Agents start from scratch every session without understanding the project's structure, conventions, dependencies, or history.

AgentForge solves all three by analyzing the project deeply, building a specialized team with appropriate model assignments, and persisting the configuration within the project itself.

## 3. System Architecture

AgentForge is composed of three architectural layers.

### 3.1 Layer 1: The Forge Engine

The Forge Engine is the orchestration layer responsible for project analysis, team generation, and re-optimization. It runs on Opus for strategic decision-making but delegates data-gathering to cheaper models.

| Component | Model | Responsibility |
|-----------|-------|----------------|
| Project Scanner | Opus (orchestrator) | Coordinates analysis, synthesizes results, decides team composition |
| File Scanner | Haiku | Parallel scan of all source files; produces per-file summaries |
| Git Analyzer | Haiku | Parses commit history, identifies patterns, active areas, contributors |
| Dependency Mapper | Haiku | Maps package dependencies, detects version conflicts, security advisories |
| CI/Test Auditor | Sonnet | Analyzes CI config, test coverage, build pipelines |
| Reforge Analyzer | Opus | Diffs current state vs. last analysis, proposes team updates |

### 3.2 Layer 2: The Agent Template Library

AgentForge ships with generic agent templates that serve as starting points. During the forge process, these templates are customized based on project analysis. Templates define the agent's role, default model assignment, skills, delegation paths, and collaboration rules.

#### Default Agent Templates

| Agent | Default Model | Role | Delegates To |
|-------|---------------|------|--------------|
| Architect | Opus | System design, API contracts, dependency decisions | Coder, Researcher |
| Coder | Sonnet | Implementation, refactoring, code generation | Researcher, Linter, File Reader |
| Security Auditor | Sonnet | Vulnerability scanning, auth review, dependency audit | Researcher, File Reader |
| Test Engineer | Sonnet | Test generation, coverage analysis, fixture creation | File Reader, Test Runner |
| DevOps Engineer | Sonnet | CI/CD, infrastructure, deployment configs | Researcher, File Reader |
| Researcher | Haiku | Web search, documentation lookup, API reference | None (utility) |
| File Reader | Haiku | File summarization, content parsing, extraction | None (utility) |
| Linter | Haiku | Style checks, formatting, quick static analysis | None (utility) |
| Test Runner | Sonnet | Execute test suites, parse results, report failures | None (utility) |
| Documentation Writer | Sonnet | README generation, API docs, inline comments | Researcher, File Reader |

#### Template Schema

Each agent template is defined as a YAML file:

```yaml
# .agentforge/agents/coder.yaml
name: Coder
model: sonnet
version: 1.0

description: >
  Writes, refactors, and reviews code. Follows project
  conventions and patterns detected during forge analysis.

system_prompt: |
  You are a senior software engineer working on {project_name}.
  Tech stack: {detected_stack}
  Conventions: {detected_conventions}

skills:
  - code_write
  - code_review
  - refactor
  - explain_code

triggers:
  file_patterns: ["*.py", "*.ts", "*.js", "*.rs"]
  keywords: ["implement", "code", "write", "refactor"]

collaboration:
  reports_to: architect
  reviews_from: [security_auditor, architect]
  can_delegate_to: [researcher, linter, file_reader]
  parallel: true

context:
  max_files: 10
  auto_include: ["README.md", "CONTRIBUTING.md"]
  project_specific: []  # Populated during forge
```

### 3.3 Layer 3: The Generated Team

The generated team lives in a `.agentforge/` directory at the project root:

```
your-project/
  .agentforge/
    team.yaml              # Active team manifest
    forge.log              # Optimization history
    analysis/
      project-scan.json    # Latest scan results
      scan-history/        # Previous scans for diffing
    agents/
      architect.yaml       # Customized from template
      coder.yaml
      security.yaml
      api-specialist.yaml  # Project-specific agent
    skills/
      project-conventions.yaml
      custom-lint-rules.yaml
    config/
      models.yaml          # Model routing overrides
      delegation.yaml      # Team collaboration graph
      costs.yaml           # Budget constraints
```

#### Team Manifest

The `team.yaml` file defines active agents, relationships, and the utility layer:

```yaml
name: my-project-team
forged_at: 2026-03-24T10:00:00Z
forged_by: agentforge v1.0
project_hash: abc123

agents:
  strategic:
    - architect
  implementation:
    - coder
    - api-specialist
  quality:
    - security
    - test-engineer
  utility:
    - researcher
    - file-reader
    - linter
    - test-runner

model_routing:
  opus: [architect]
  sonnet: [coder, api-specialist, security, test-engineer, test-runner]
  haiku: [researcher, file-reader, linter]

delegation_graph:
  architect: [coder, api-specialist, researcher]
  coder: [researcher, linter, file-reader, test-runner]
  security: [researcher, file-reader]
  test-engineer: [file-reader, test-runner]
  api-specialist: [researcher, file-reader, coder]
```

## 4. Core Workflows

### 4.1 Forge: Initial Team Generation

The forge workflow runs the full analysis-to-team pipeline:

1. **Project Scan**: Opus dispatches Haiku sub-agents to scan all source files, git history, dependencies, and CI configuration in parallel. Each sub-agent produces a structured summary.
2. **Synthesis**: Opus receives all summaries and produces a Project Assessment containing: detected tech stack, architectural patterns, security concerns, test coverage gaps, domain complexity areas, and team size recommendation.
3. **Team Composition**: Opus selects which agent templates to include, determines if any project-specific agents are needed, and assigns models based on task complexity.
4. **Customization**: Each selected template is customized with project-specific context: detected conventions are injected into system prompts, file patterns are updated, context files are populated, and delegation paths are wired.
5. **Output**: The `.agentforge/` directory is written with all agent configs, the team manifest, analysis results, and the forge log.

### 4.2 Reforge: Team Re-optimization

Reforge is the continuous improvement loop:

1. **Delta Detection**: Compare current project state against the last scan. Identify new files, changed dependencies, new CI steps, shifted coding patterns.
2. **Impact Assessment**: Opus evaluates which changes warrant team updates. Minor changes are noted but don't trigger re-composition.
3. **Team Diff**: Generate a proposed team update: new agents to add, agents to retire, model reassignments, skill updates, delegation path changes.
4. **Apply or Review**: Present the diff to the user for approval, or auto-apply if configured. All changes are logged in `forge.log`.

### 4.3 Runtime: Agent Execution

When agents are invoked during development:

1. **Task Routing**: Incoming requests are matched to agents via triggers (file patterns, keywords, explicit invocation).
2. **Model Dispatch**: Each agent's configured model is used for its API calls.
3. **Delegation**: When an agent needs information, it delegates to utility agents. A Coder (Sonnet) needing API docs delegates to Researcher (Haiku), which performs the search and returns a summary.
4. **Parallel Execution**: Independent tasks run concurrently. The orchestrator tracks dependencies and ensures results are available before dependent tasks start.
5. **Result Aggregation**: For complex tasks involving multiple agents, the orchestrator collects results and presents a unified output.

## 5. Model Routing Strategy

### 5.1 Model Tiers

| Tier | Model | Use For | Cost Profile |
|------|-------|---------|--------------|
| Strategic | Opus | Architecture decisions, team composition, complex reasoning, novel problem solving | Highest — reserved for deep reasoning |
| Implementation | Sonnet | Code generation, security analysis, test writing, code review, DevOps tasks | Medium — workhorse for bounded complex tasks |
| Utility | Haiku | Web search, file reading, linting, summarization, parallel scanning | Lowest — high volume, fast turnaround |

### 5.2 Delegation Economics

Delegation creates significant cost savings. Consider a typical code implementation task:

| Step | Without AgentForge | With AgentForge |
|------|-------------------|-----------------|
| Research API docs | Sonnet searches web (expensive) | Haiku Researcher returns summary |
| Read related files | Sonnet reads 10 files (expensive) | Haiku File Reader summarizes relevant code |
| Write implementation | Sonnet generates code | Sonnet generates code (same) |
| Lint check | Sonnet reviews style (overkill) | Haiku Linter runs quick checks |
| Run tests | Sonnet parses test output | Sonnet Test Runner parses results |

By offloading retrieval and formatting tasks to Haiku, the Sonnet agent focuses exclusively on the reasoning-heavy implementation step. This typically reduces per-task cost by **40-60%** while maintaining or improving output quality.

## 6. Project Analysis Engine

The project scanner runs a deep, parallel analysis on first forge and incremental scans on reforge.

### 6.1 Analysis Dimensions

| Dimension | Sub-agent | What It Detects |
|-----------|-----------|-----------------|
| File structure | Haiku | Languages, frameworks, directory patterns, naming conventions |
| Git history | Haiku | Active areas, commit patterns, team size, branch strategy, churn rate |
| Dependencies | Haiku | Package managers, version constraints, known vulnerabilities |
| CI/CD | Sonnet | Build systems, test frameworks, deployment targets |
| Code patterns | Sonnet | Architecture style, API patterns, error handling |
| Test coverage | Sonnet | Test types present, coverage gaps, testing frameworks |
| Security posture | Sonnet | Auth mechanisms, secrets management, input validation |
| Documentation | Haiku | README quality, inline comments, API docs, changelog presence |

### 6.2 Analysis Output

The scanner produces a structured Project Assessment JSON:

```json
{
  "project": {
    "name": "my-project",
    "primary_language": "TypeScript",
    "languages": ["TypeScript", "Python", "SQL"],
    "frameworks": ["Next.js", "FastAPI", "PostgreSQL"],
    "architecture": "monorepo-microservices",
    "size": { "files": 342, "loc": 48000 }
  },
  "risk_areas": [
    { "area": "auth", "severity": "high", "reason": "Custom JWT impl" },
    { "area": "api", "severity": "medium", "reason": "No rate limiting" }
  ],
  "coverage_gaps": [
    { "area": "integration_tests", "coverage": 0.12 },
    { "area": "e2e_tests", "coverage": 0.0 }
  ],
  "recommended_team": {
    "required": ["architect", "coder", "security"],
    "recommended": ["test-engineer", "api-specialist"],
    "custom_agents": [
      { "name": "api-specialist", "reason": "Heavy API surface" }
    ]
  }
}
```

## 7. Skills System

Skills are reusable capabilities attached to any agent. They encapsulate specific actions, tools, or knowledge domains.

### 7.1 Skill Categories

| Category | Examples | Description |
|----------|----------|-------------|
| Code | code_write, code_review, refactor, explain_code | Core coding operations |
| Analysis | file_scan, dependency_check, coverage_report | Read-only analysis and reporting |
| Search | web_search, doc_lookup, api_reference | Information retrieval |
| Testing | test_generate, test_run, fixture_create | Test creation and execution |
| Security | vuln_scan, auth_review, secret_detect | Security analysis |
| DevOps | ci_config, deploy_check, env_validate | Infrastructure operations |
| Documentation | readme_gen, api_doc, changelog | Documentation generation |

### 7.2 Custom Skills

The forge process can generate project-specific skills based on detected patterns. For example, if the project uses a custom ORM, AgentForge may generate a `custom_orm_query` skill. Custom skills are stored in `.agentforge/skills/`.

## 8. CLI Interface

### 8.1 Commands

| Command | Description | Model Cost |
|---------|-------------|------------|
| `agentforge init` | Initialize AgentForge (creates `.agentforge/` scaffold) | None |
| `agentforge forge` | Full project analysis and team generation | High (Opus + parallel Haiku) |
| `agentforge reforge` | Re-analyze and update team | Medium (Opus + targeted scans) |
| `agentforge status` | Show team composition and last forge date | None |
| `agentforge team` | List active agents with roles and models | None |
| `agentforge invoke <agent>` | Directly invoke a specific agent | Varies |
| `agentforge delegate <task>` | Auto-route a task to the best agent | Varies |
| `agentforge cost-report` | Token usage and cost breakdown | None |
| `agentforge export` | Export team config | None |

### 8.2 Claude Code Integration

When installed as a Claude Code plugin, AgentForge registers slash commands:

```bash
/forge              # Run initial forge
/reforge            # Re-optimize team
/team               # Show team status
/ask architect ...  # Direct agent invocation
/delegate ...       # Auto-routed task
```

## 9. Agent Collaboration Protocol

Agents communicate through structured message-passing managed by the orchestrator.

### 9.1 Message Format

```json
{
  "id": "msg-001",
  "from": "coder",
  "to": "researcher",
  "type": "delegate",
  "task": "Find the React 19 useFormStatus API reference",
  "priority": "normal",
  "context": {
    "parent_task": "task-042",
    "files_in_scope": ["src/components/Form.tsx"],
    "deadline": "before parent completes"
  },
  "response_format": "summary"
}
```

### 9.2 Collaboration Patterns

- **Fan-out**: One agent delegates sub-tasks to multiple utility agents in parallel.
- **Pipeline**: Tasks flow through a chain of agents sequentially.
- **Review Loop**: An agent's output is reviewed by another agent, with feedback cycling until approval.
- **Broadcast**: The orchestrator notifies all relevant agents of a context change.

## 10. Implementation Plan

### 10.1 Phase Breakdown

| Phase | Deliverables | Effort |
|-------|-------------|--------|
| Phase 1: Foundation | Plugin skeleton, CLI entry points, YAML schema, template library (10 agents), project directory structure | 1-2 weeks |
| Phase 2: Scanner | Parallel file scanner, git analyzer, dependency mapper, CI auditor, Opus synthesizer, Project Assessment output | 2-3 weeks |
| Phase 3: Team Builder | Template customization engine, project-specific agent generation, team manifest writer, model routing config | 1-2 weeks |
| Phase 4: Orchestrator | Message-passing runtime, model-per-agent dispatch, parallel execution manager, delegation routing, result aggregation | 2-3 weeks |
| Phase 5: Reforge | Delta detection, impact assessment, team diff generation, apply/review workflow, forge.log tracking | 1-2 weeks |

### 10.2 Technical Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Plugin runtime | TypeScript / Node.js | Claude Code plugin ecosystem compatibility |
| Agent configs | YAML | Human-readable, git-friendly |
| Analysis output | JSON | Structured, parseable, diffable |
| CLI framework | Commander.js | Mature, well-documented |
| API integration | Anthropic SDK | Direct model access with model selection |
| Parallel execution | Promise.allSettled | Native concurrency for sub-agent dispatch |

### 10.3 Dependencies

- Claude Code plugin API (slash command registration and context access)
- Anthropic API (multi-model dispatch: Opus, Sonnet, Haiku)
- Node.js 18+ (runtime)
- git CLI (repository analysis)
- Project package manager CLIs (npm, pip, cargo, etc.)

## 11. Extensibility

### 11.1 Custom Agent Templates

Users can create custom templates by adding YAML files to `.agentforge/agents/`. These follow the same schema as built-in templates and are available during the forge process.

### 11.2 Plugin Hooks

AgentForge exposes hooks at key workflow points:

- **pre-forge**: Run custom analysis before the main scan
- **post-forge**: Execute actions after team generation
- **pre-delegate**: Intercept and modify delegation requests
- **post-task**: Process agent outputs before returning to the user

### 11.3 Shared Team Templates

Organizations can create and share team templates for common project archetypes (e.g., "Next.js SaaS", "Python ML Pipeline", "Rust CLI Tool").

## 12. Security Considerations

- **Agent Isolation**: Each agent operates within its defined scope. A Researcher cannot modify code; a Coder cannot change CI configuration unless granted that skill.
- **Secret Handling**: The scanner detects but never stores secrets. Secret patterns are recorded as risk findings, not values.
- **Audit Trail**: All agent actions, delegations, and decisions are logged in `forge.log`.
- **Sandboxing**: Utility agents operate in a sandboxed context preventing tool misuse.
- **Permission Model**: Dangerous operations require explicit user approval regardless of agent delegation.

## 13. Future Considerations

- **Learning from feedback**: Track which agent suggestions are accepted vs. modified to improve future forge decisions.
- **Cross-project intelligence**: Learn patterns across projects (with user consent) to improve initial team recommendations.
- **Real-time monitoring**: Dashboard showing agent activity, token spend, and task throughput.
- **Team sharing marketplace**: Community-contributed templates for specific tech stacks.
- **Automated reforge triggers**: Git hooks or CI integration that triggers reforge on significant PRs.
