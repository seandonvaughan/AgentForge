# AgentForge v2: Universal Forge

**Design Spec | March 2026 | Status: Approved**

## 1. Overview

AgentForge v2 ("Universal Forge") expands AgentForge from a software-focused agent team builder into a universal platform that assembles optimized AI agent teams for any project type — software, business, marketing, research, and beyond.

### Key Changes from v1

1. **Domain Packs** — Agent templates organized into modular domain packs (software, business, marketing, product, research, sales, legal, hr, it) with a universal core layer.
2. **Genesis Agent** — An adaptive entry-point that guides users from idea to team, whether starting from scratch or from an existing codebase.
3. **Collaboration Templates** — Reusable topology patterns (hierarchy, flat, matrix, hub-and-spoke, custom) that define how agents relate across domains.
4. **Structured Skills** — Skills become first-class typed units with categories, gates, parameters, and composability.
5. **Project Brief** — A universal input format that replaces the code-only ProjectAssessment, supporting both codebase analysis and business document analysis.
6. **Meta-Agents** — Self-improving agents that create new templates and skills when no existing ones fit.

### Design Principles

- **Hybrid by default** — Works in repo-aware mode (code projects) and business mode (documents, goals, constraints), or both simultaneously.
- **Core + domains** — A small set of universal agents always present, domain-specific packs layered on top.
- **Adaptive collaboration** — The topology is a design choice per project, not hardcoded.
- **Backward compatible** — Existing v1 `.agentforge/` directories remain valid and can be upgraded.

## 2. System Architecture

### 2.1 Four-Layer Architecture

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
│   │scanners │ scanners │ skills    │ skills   │          │
│   └─────────┴──────────┴───────────┴──────────┘          │
│   + Research(4) Sales(4) Legal(4) HR(4) IT(6) = 56 total │
├──────────────────────────────────────────────────────────┤
│                    Layer 1: Core                           │
│   Universal agents (Genesis, PM, Researcher, File Reader, │
│   Meta-Architect) + universal skills + base scanner       │
└──────────────────────────────────────────────────────────┘
```

### 2.2 Core Layer (Always Present)

The core layer provides agents and skills that every team needs regardless of domain.

#### Core Agents

| Agent | Model | Role |
|-------|-------|------|
| Genesis | Opus | Adaptive idea-to-team workflow orchestrator |
| Project Manager | Sonnet | Cross-domain coordination, status tracking, timeline management |
| Researcher | Haiku | Web search, documentation lookup, competitive intel |
| File Reader | Haiku | File summarization, content parsing, extraction |
| Meta-Architect | Opus | Creates custom agent templates when no existing template fits |

#### Core Skills

| Category | Skills |
|----------|--------|
| Research | web_search, doc_lookup, api_reference |
| Analysis | summarize, compare, file_scan |
| Creation | file_write, report_generate |
| Review | verify_before_claim |
| Planning | brainstorm, task_decompose |
| Communication | status_report, escalate |

### 2.3 Domain Packs

Each domain pack is a self-contained module containing agent templates, skills, scanner logic, and collaboration patterns.

#### Directory Structure

```
templates/
  domains/
    core/
      domain.yaml
      agents/
        genesis.yaml
        project-manager.yaml
        researcher.yaml
        file-reader.yaml
        meta-architect.yaml
      skills/
        research/
          web_search.yaml
          doc_lookup.yaml
        analysis/
          summarize.yaml
          compare.yaml
        ...
    software/
      domain.yaml
      agents/
        architect.yaml
        coder.yaml
        security-auditor.yaml
        test-engineer.yaml
        devops-engineer.yaml
        documentation-writer.yaml
        code-explorer.yaml
        linter.yaml
        test-runner.yaml
        frontend-designer.yaml
        debugger.yaml
      skills/
        creation/
          code_write.yaml
          code_refactor.yaml
          test_generate.yaml
        review/
          code_review.yaml
          security_audit.yaml
          silent_failure_hunt.yaml
        ...
      collaboration/
        dev-team.yaml
    business/
      domain.yaml
      agents/
        ceo.yaml
        cto.yaml
        coo.yaml
        cfo.yaml
        business-analyst.yaml
        operations-manager.yaml
      skills/
        analysis/
          financial_analysis.yaml
          market_sizing.yaml
          competitive_analysis.yaml
          swot_analysis.yaml
        planning/
          strategic_planning.yaml
          budget_planning.yaml
          okr_creation.yaml
        creation/
          business_plan.yaml
          pitch_deck_outline.yaml
          executive_summary.yaml
        communication/
          board_update.yaml
          investor_update.yaml
      collaboration/
        executive-team.yaml
    marketing/
      ...
    product/
      ...
    research/
      ...
    sales/
      ...
    legal/
      ...
    hr/
      ...
    it/
      ...
```

#### Domain Manifest Schema (domain.yaml)

```yaml
name: software
version: "1.0"
description: >
  Software development domain — covers architecture, implementation,
  testing, security, DevOps, and documentation.

scanner:
  type: "codebase"                # codebase | document | hybrid
  activates_when:
    - file_patterns: ["*.ts", "*.py", "*.rs", "*.go", "*.java", "*.rb"]
    - directories: ["src/", "lib/", "app/"]
    - files: ["package.json", "Cargo.toml", "go.mod", "requirements.txt"]
  scanners:
    - file-scanner
    - git-analyzer
    - dependency-mapper
    - ci-auditor

agents:
  strategic: [architect]
  implementation: [coder, devops-engineer, frontend-designer]
  quality: [security-auditor, test-engineer, test-runner, debugger]
  utility: [linter, documentation-writer, code-explorer]

default_collaboration: dev-team

signals:
  - codebase_present
  - programming_languages_detected
  - ci_config_detected
  - package_manager_detected
```

**Business Domain Example:**

```yaml
name: business
version: "1.0"
description: >
  Business operations domain — covers executive strategy,
  financial planning, operations, and business analysis.

scanner:
  type: "document"
  activates_when:
    - file_patterns: ["*.docx", "*.pdf", "*.pptx", "*.xlsx"]
    - directories: ["docs/", "plans/", "strategy/"]
    - files: ["business-plan.md", "pitch-deck.md", "financials.xlsx"]
  scanners:
    - document-analyzer
    - web-researcher
    - integration-detector

agents:
  strategic: [ceo, cto]
  implementation: [coo, cfo, business-analyst]
  utility: [operations-manager]

default_collaboration: executive-team

signals:
  - business_documents_present
  - financial_data_detected
  - strategy_documents_detected
  - organizational_docs_detected
```

#### Domain Activation

1. **Base scan** — Quick pass detects what exists (repo, docs, nothing).
2. **Signal matching** — Each domain's `activates_when` rules checked against scan results.
3. **Multi-domain selection** — Multiple domains activate simultaneously when signals match.
4. **Core always loads** — Researcher, File Reader, PM always available.
5. **Genesis confirms** — Presents detected domains to user, allows override.

## 3. Genesis Workflow

The Genesis agent is the new front door to AgentForge. It adapts its approach based on what exists.

### 3.1 Adaptive Entry Points

| Project State | Genesis Behavior |
|--------------|-----------------|
| Nothing exists | **Interview Mode** — Guided questions: goal, audience, constraints, domain |
| Documents only | **Analyze + Interview** — Read docs, research, then ask gap questions |
| Codebase only | **Full Scan + Interview** — Run dev scanners, analyze, fill gaps |
| Codebase + Docs | **Full Analysis** — Scan everything, minimal confirmation questions |

### 3.2 Genesis Pipeline (6 Phases)

**Phase 1 — Discovery**
Genesis detects what exists: repo? docs? config files? integration references? Runs base scanner to classify project state and activates relevant domain scanners.

**Phase 2 — Context Gathering**
Based on discovery:
- Runs activated domain scanners in parallel (file, git, deps, CI for code; document analysis for business docs)
- Does autonomous web research on domain/industry if business-mode signals found
- Taps integrations (Jira, Confluence, etc.) if references discovered in docs, configs, or code comments
- Reads git history, commit messages, code comments, TODOs for additional context

**Phase 3 — Interview**
Fills gaps adaptively:
- Nothing existed → full guided interview (goal, audience, constraints, domain, scale)
- Partial context → targeted questions about what's unclear
- Rich context → confirmation questions ("I see X, Y, Z — is that right?")
- Each answer refines understanding and may trigger additional research

**Phase 4 — Domain Selection & Research**
Based on everything gathered:
- Selects relevant domain packs (can be multiple)
- Identifies needed agents from those packs
- Researches domain-specific best practices for unfamiliar territory
- Produces a **Project Brief**

**Phase 5 — Team Design**
Using the Project Brief:
- Selects agent templates from relevant domain packs
- Generates custom agents if no template fits (via Meta-Architect)
- Selects and customizes collaboration template
- Assigns models (Opus for strategic, Sonnet for implementation, Haiku for utility)
- Builds delegation graph with cross-domain bridges
- Presents proposed team to user for review

**Phase 6 — Forge**
On user approval:
- Customizes each template with project context
- Writes `.agentforge/` directory
- Logs genesis event with full rationale
- Hands off to active team

### 3.3 Project Brief

The Project Brief is the universal input to team composition, replacing the code-only `ProjectAssessment`. It works for both dev and business projects.

```yaml
project:
  name: "Project X"
  type: "saas-product"
  stage: "early"                 # early | growth | mature | pivot

goals:
  primary: "Build an AI-powered analytics platform"
  secondary:
    - "Raise Series A"
    - "Launch beta by Q3"

domains:
  - software
  - business
  - marketing

constraints:
  budget: "bootstrapped"
  timeline: "6 months"
  team_size: "solo founder"

context:
  codebase:                      # from dev scanners (if repo exists)
    languages: ["TypeScript", "Python"]
    frameworks: ["Next.js", "FastAPI"]
    architecture: "monorepo"
    size: { files: 342, loc: 48000 }
    risk_areas: [...]
    coverage_gaps: [...]
  documents:                     # from document analysis
    - type: "business-plan"
      path: "docs/business-plan.md"
      summary: "..."
    - type: "prd"
      path: "docs/prd.md"
      summary: "..."
  research:                      # from autonomous web research
    market_size: "..."
    competitors: ["..."]
    industry_trends: ["..."]
  integrations:                  # discovered integration points
    - type: jira
      ref: "PROJECT-KEY"
    - type: confluence
      ref: "space-id"
```

## 4. Collaboration Templates

Collaboration templates are reusable topology patterns that define how agents relate. The Genesis agent selects and customizes one based on the project.

### 4.1 Template Types

**Hierarchy** — Single chain of command. Best for corporate initiatives, large teams.
```
         CEO
        / | \
     CTO  CMO  COO
      |    |    |
  Architect Content Ops-Mgr
      |
    Coder
```

**Flat** — All agents are peers, orchestrator coordinates. Best for small teams, startups.
```
  Coder <-> Designer <-> PM
    |           |         |
  Tester <-> Writer <-> Researcher
```

**Matrix** — Dual reporting lines (domain lead + project lead). Best for cross-functional projects.
```
           PM (project axis)
          / | \
    Coder  Designer  Marketer
       \    |     /
     Architect (domain axis)
```

**Hub-and-Spoke** — Central coordinator with independent domain teams. Best for multi-domain projects.
```
          ┌─── Software Team
   PM ────┤─── Marketing Team
          └─── Research Team
```

**Custom** — Genesis designs a bespoke topology when no standard pattern fits.

#### Topology Selection Heuristics

Genesis uses the following decision logic to select an initial topology:

| Condition | Selected Topology |
|-----------|-------------------|
| Single domain, <= 5 agents | Flat |
| Single domain, > 5 agents | Hierarchy |
| Multiple domains, independent workstreams | Hub-and-Spoke |
| Multiple domains, cross-functional with dual reporting | Matrix |
| User specifies corporate/org structure | Hierarchy |
| None of the above fits | Custom (Meta-Architect designs) |

The user can always override the selection during the Genesis interview.

#### Core Agents in Domain Topologies

Core agents (Researcher, File Reader, Project Manager) are available to all domain teams and may appear in domain-specific collaboration templates as utility-level participants. They are shared across domains — one Researcher instance serves all teams, not one per domain.

### 4.2 Collaboration Template Schema

```yaml
name: dev-team
type: hierarchy
description: >
  Standard software development team with architect
  leading implementation agents.

topology:
  root: architect
  levels:
    - agents: [architect]
      role: strategic
    - agents: [coder, security-auditor, test-engineer, devops-engineer]
      role: implementation
    - agents: [researcher, file-reader, linter, test-runner]
      role: utility

delegation_rules:
  direction: top-down              # top-down | peer | any
  cross_level: false               # can agents skip levels?
  peer_collaboration: true         # can same-level agents talk?
  review_flow: bottom-up           # who reviews whose work?

communication:
  patterns:
    - fan-out
    - pipeline
    - review-loop
  gates:
    - name: review-before-complete
      type: hard-gate
      rule: "No task is complete without review from reviews_from agents"
    - name: verify-before-claim
      type: hard-gate
      rule: "Run verification commands before claiming success"

escalation:
  max_retries: 3
  escalate_to: root
  human_escalation: true

loop_limits:
  review_cycle: 3
  delegation_depth: 5
  retry_same_agent: 2
  total_actions: 50
```

### 4.3 Cross-Domain Collaboration

When multiple domains activate, the Genesis agent produces a **merged topology**:

```yaml
# Generated in .agentforge/config/delegation.yaml
topology: hub-and-spoke
coordinator: project-manager

teams:
  software:
    lead: architect
    members: [coder, test-engineer, devops-engineer]
    utilities: [researcher, file-reader, linter]
    internal_topology: hierarchy

  marketing:
    lead: cmo
    members: [content-strategist, seo-specialist]
    utilities: [researcher]
    internal_topology: flat

bridges:
  - from: architect
    to: cmo
    reason: "Technical constraints affect marketing messaging"
  - from: cto
    to: architect
    reason: "Technology strategy drives architecture decisions"
  - from: project-manager
    to: [architect, cmo, cto]
    reason: "Coordinator needs visibility into all domains"

shared_utilities:
  - researcher
  - file-reader
```

### 4.4 Built-In Patterns (from Superpowers Research)

Every collaboration template includes:

- **Iron Laws** — Non-negotiable rules per topology (e.g., "No code ships without security review").
- **Gate Functions** — Pre/post checks at transition points (review-before-complete, verify-before-claim).
- **Escalation Paths** — 3 retries → escalate to lead → escalate to human.
- **Two-Stage Review** — Spec compliance check, then quality check (separate concerns).
- **Confidence-Based Filtering** — Agents use 0-100 confidence scores, only report findings at >= 80.

## 5. Skill Architecture

### 5.1 Skill Schema

Skills become first-class structured units:

```yaml
name: web_search
version: "1.0"
category: research
domain: core
model_preference: haiku

description: >
  Search the web for information, documentation, articles,
  and references relevant to a task.

parameters:
  - name: query
    type: string
    required: true
  - name: depth
    type: enum [quick, thorough, exhaustive]
    default: thorough

gates:
  pre: []
  post:
    - "Results must include source URLs"
    - "Summary must be under 500 words"

composable_with:
  - doc_lookup
  - summarize
  - competitive_analysis
```

### 5.2 Skill Categories

| Category | Description | Examples |
|----------|-------------|---------|
| **research** | Information gathering and synthesis | web_search, doc_lookup, competitive_analysis, market_research, patent_search |
| **analysis** | Evaluating and reasoning about information | financial_analysis, risk_assessment, data_analysis, sentiment_analysis |
| **creation** | Producing artifacts | code_write, content_write, design_spec, presentation_build, report_generate |
| **review** | Quality assurance and validation | code_review, compliance_check, brand_review, legal_review, security_audit |
| **planning** | Strategy and roadmap creation | strategic_planning, sprint_planning, campaign_planning, resource_planning, brainstorm |
| **communication** | Inter-agent and human interaction | status_report, stakeholder_update, meeting_notes, escalate |

### 5.3 Skill Inheritance

- **Core skills** — Available to all agents regardless of domain.
- **Domain skills** — Available to agents within that domain.
- **Cross-domain access** — An agent can use another domain's skills if the delegation graph connects them.

## 6. Complete Agent Roster

### 6.1 Core (5 agents)

| Agent | Model | Role |
|-------|-------|------|
| Genesis | Opus | Adaptive idea-to-team workflow orchestrator |
| Project Manager | Sonnet | Cross-domain coordination, status tracking, timeline management |
| Researcher | Haiku | Web search, documentation lookup, competitive intel |
| File Reader | Haiku | File summarization, content parsing, extraction |
| Meta-Architect | Opus | Creates custom agent templates when no existing template fits |

### 6.2 Software Domain (11 agents)

| Agent | Model | Role |
|-------|-------|------|
| Architect | Opus | System design, API contracts, architecture decisions |
| Coder | Sonnet | Implementation, refactoring, code generation |
| Security Auditor | Sonnet | Vulnerability scanning, auth review, dependency audit |
| Test Engineer | Sonnet | Test generation, coverage analysis, TDD enforcement |
| DevOps Engineer | Sonnet | CI/CD, infrastructure, deployment configs |
| Documentation Writer | Sonnet | README, API docs, inline comments, changelogs |
| Code Explorer | Sonnet | Traces execution paths, maps architecture layers |
| Linter | Haiku | Style checks, formatting, static analysis |
| Test Runner | Sonnet | Execute test suites, parse results, report failures |
| Frontend Designer | Sonnet | UI/UX implementation, component design |
| Debugger | Sonnet | Systematic root-cause debugging, four-phase process |

### 6.3 Business Domain (6 agents)

| Agent | Model | Role |
|-------|-------|------|
| CEO | Opus | Vision, strategy, final decisions, stakeholder alignment |
| CTO | Opus | Technology strategy, build-vs-buy, R&D investment |
| COO | Sonnet | Operations, process optimization, resource allocation |
| CFO | Sonnet | Financial modeling, budgeting, unit economics, fundraising |
| Business Analyst | Sonnet | Requirements gathering, process mapping, gap analysis |
| Operations Manager | Haiku | Workflow optimization, reporting, operational metrics |

### 6.4 Marketing Domain (7 agents)

| Agent | Model | Role |
|-------|-------|------|
| CMO | Opus | Marketing strategy, brand direction, channel prioritization |
| Content Strategist | Sonnet | Content planning, editorial calendar, messaging hierarchy |
| SEO Specialist | Sonnet | Keyword strategy, technical SEO, content optimization |
| Brand Manager | Sonnet | Brand voice, visual identity guidelines, consistency |
| Growth Hacker | Sonnet | Acquisition experiments, funnel optimization, viral loops |
| Social Media Manager | Haiku | Platform-specific content, scheduling, engagement |
| Copywriter | Sonnet | Ad copy, landing pages, email campaigns, CTAs |

### 6.5 Product Domain (5 agents)

| Agent | Model | Role |
|-------|-------|------|
| Product Manager | Opus | Product strategy, roadmap, prioritization |
| UX Designer | Sonnet | Wireframes, user flows, interaction design, usability |
| UX Researcher | Sonnet | User interviews, persona creation, journey mapping |
| Product Analyst | Sonnet | Metrics definition, A/B test design, funnel analysis |
| Product Marketing Manager | Sonnet | Positioning, launch plans, competitive differentiation |

### 6.6 Research Domain (4 agents)

| Agent | Model | Role |
|-------|-------|------|
| Research Lead | Opus | Research direction, methodology selection, synthesis |
| Data Scientist | Sonnet | Statistical analysis, model design, experiment design |
| ML Engineer | Sonnet | Model training, pipeline building, evaluation |
| Research Analyst | Haiku | Literature review, data collection, citation management |

### 6.7 Sales Domain (4 agents)

| Agent | Model | Role |
|-------|-------|------|
| Sales Director | Opus | Sales strategy, pipeline management, forecasting |
| Account Executive | Sonnet | Deal strategy, proposal writing, objection handling |
| Sales Engineer | Sonnet | Technical demos, POC design, integration planning |
| BDR | Haiku | Prospecting research, outreach drafting, lead qualification |

### 6.8 Legal Domain (4 agents)

| Agent | Model | Role |
|-------|-------|------|
| General Counsel | Opus | Legal strategy, risk assessment, regulatory guidance |
| Compliance Officer | Sonnet | Regulatory compliance, audit prep, policy enforcement |
| Contract Analyst | Sonnet | Contract review, term negotiation, risk flagging |
| IP Specialist | Sonnet | Patent analysis, trademark review, IP strategy |

### 6.9 HR Domain (4 agents)

| Agent | Model | Role |
|-------|-------|------|
| HR Director | Opus | People strategy, org design, culture development |
| Recruiter | Sonnet | Job descriptions, sourcing strategy, candidate screening |
| L&D Specialist | Sonnet | Training design, skill gap analysis, onboarding |
| Compensation Analyst | Sonnet | Benchmarking, comp structure, equity planning |

### 6.10 IT Domain (6 agents)

| Agent | Model | Role |
|-------|-------|------|
| IT Director | Opus | IT strategy, vendor selection, infrastructure planning |
| Systems Administrator | Sonnet | Server management, monitoring, incident response |
| Network Engineer | Sonnet | Network architecture, security, performance |
| DBA | Sonnet | Database design, query optimization, backup strategy |
| Cloud Architect | Sonnet | Cloud infrastructure, migration, cost optimization |
| Help Desk Lead | Haiku | Issue triage, knowledge base maintenance, escalation |

**Total: 61 agents** (5 core + 56 across 9 domains).

### 6.11 Meta-Agent Subsystem

The following agents serve as the self-improving layer. Meta-Architect is defined in Core (Section 6.1) and also participates here. The remaining 3 are additional system-level agents stored in `templates/domains/core/agents/`.

| Agent | Model | Role | Defined In |
|-------|-------|------|------------|
| Meta-Architect | Opus | Creates new agent templates when no existing template fits | Core (6.1) |
| Skill Designer | Sonnet | Creates domain-specific skills from project patterns | Core |
| Team Reviewer | Sonnet | Reviews generated teams for gaps and misconfigurations | Core |
| Template Optimizer | Sonnet | Improves agent prompts based on usage feedback | Core |

Including Skill Designer, Team Reviewer, and Template Optimizer, the **grand total is 64 unique agents**.

## 7. Updated Type System

### 7.1 Inherited Types (Unchanged from v1)

The following types are defined in v1 (`src/types/`) and remain unchanged:

```typescript
// Model tier assignment
type ModelTier = 'opus' | 'sonnet' | 'haiku';

// Agent category for team organization
type AgentCategory = 'strategic' | 'implementation' | 'quality' | 'utility';

// Agent trigger configuration
interface AgentTriggers {
  file_patterns: string[];
  keywords: string[];
}

// Agent collaboration rules
interface AgentCollaboration {
  reports_to: string | null;
  reviews_from: string[];
  can_delegate_to: string[];
  parallel: boolean;
}

// Agent context window configuration
interface AgentContext {
  max_files: number;
  auto_include: string[];
  project_specific: string[];
}

// Model-to-agent routing
interface ModelRouting {
  opus: string[];
  sonnet: string[];
  haiku: string[];
}

// Agent-to-delegate mapping
type DelegationGraph = Record<string, string[]>;

// Project info from codebase scanners
interface ProjectInfo {
  name: string;
  primary_language: string;
  languages: string[];
  frameworks: string[];
  architecture: string;
  size: { files: number; loc: number };
}
```

### 7.2 New Types

```typescript
// Domain identification
type DomainId = 'core' | 'software' | 'business' | 'marketing' |
                'product' | 'research' | 'sales' | 'legal' |
                'hr' | 'it' | string;

// Structured skill (replaces free-form strings)
interface Skill {
  name: string;
  version: string;
  category: SkillCategory;
  domain: DomainId;
  model_preference: ModelTier;
  description: string;
  parameters: SkillParameter[];
  gates: { pre: string[]; post: string[] };
  composable_with: string[];
}

type SkillCategory = 'research' | 'analysis' | 'creation' |
                     'review' | 'planning' | 'communication';

interface SkillParameter {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
}

// Domain pack manifest
interface DomainPack {
  name: DomainId;
  version: string;
  description: string;
  scanner: DomainScanner;
  agents: Record<AgentCategory, string[]>;
  default_collaboration: string;
  signals: string[];
}

interface DomainScanner {
  type: 'codebase' | 'document' | 'hybrid';
  activates_when: ActivationRule[];
  scanners: string[];
}

interface ActivationRule {
  file_patterns?: string[];
  directories?: string[];
  files?: string[];
}

// Collaboration template
interface CollaborationTemplate {
  name: string;
  type: 'hierarchy' | 'flat' | 'matrix' | 'hub-and-spoke' | 'custom';
  description: string;
  topology: TopologyDefinition;
  delegation_rules: DelegationRules;
  communication: CommunicationConfig;
  escalation: EscalationConfig;
  loop_limits: LoopLimits;
}

interface TopologyDefinition {
  root: string | null;
  levels: { agents: string[]; role: string }[];
}

interface DelegationRules {
  direction: 'top-down' | 'peer' | 'any';
  cross_level: boolean;
  peer_collaboration: boolean;
  review_flow: 'bottom-up' | 'top-down' | 'peer';
}

interface CommunicationConfig {
  patterns: string[];
  gates: GateDefinition[];
}

interface GateDefinition {
  name: string;
  type: 'hard-gate' | 'soft-gate';
  rule: string;
}

interface EscalationConfig {
  max_retries: number;
  escalate_to: string;
  human_escalation: boolean;
}

// Project Brief (universal input — replaces ProjectAssessment)
interface ProjectBrief {
  project: {
    name: string;
    type: string;
    stage: 'early' | 'growth' | 'mature' | 'pivot';
  };
  goals: {
    primary: string;
    secondary: string[];
  };
  domains: DomainId[];
  constraints: Record<string, string>;
  context: {
    codebase?: ProjectInfo;
    documents?: DocumentAnalysis[];
    research?: ResearchFindings;
    integrations?: IntegrationRef[];
  };
}

interface DocumentAnalysis {
  type: string;
  path: string;
  summary: string;
}

interface ResearchFindings {
  market_size?: string;
  competitors?: string[];
  industry_trends?: string[];
  [key: string]: unknown;
}

interface IntegrationRef {
  type: string;
  ref: string;
}

// Cross-domain team configuration
interface CrossDomainTeam {
  topology: string;
  coordinator: string;
  teams: Record<string, DomainTeam>;
  bridges: Bridge[];
  shared_utilities: string[];
}

interface DomainTeam {
  lead: string;
  members: string[];
  utilities: string[];
  internal_topology: string;
}

interface Bridge {
  from: string;
  to: string | string[];
  reason: string;
}

// Runtime orchestration (Section 11)
interface ProgressLedger {
  task_id: string;
  objective: string;
  facts: {
    given: string[];
    to_look_up: string[];
    to_derive: string[];
    educated_guesses: string[];
  };
  plan: string[];
  steps_completed: string[];
  current_step: string | null;
  is_request_satisfied: boolean;
  is_in_loop: boolean;
  is_progress_being_made: boolean;
  confidence: number;
  next_speaker: string | null;
  instruction: string;
}

interface LoopLimits {
  review_cycle: number;
  delegation_depth: number;
  retry_same_agent: number;
  total_actions: number;
}

interface TeamEvent {
  type: string;
  source: string;
  payload: unknown;
  notify: string[];
}

interface Handoff {
  from: string;
  to: string;
  artifact: {
    type: 'code' | 'document' | 'analysis' | 'plan' | 'review' | 'data';
    summary: string;
    location: string;
    confidence: number;
  };
  open_questions: string[];
  constraints: string[];
  status: 'complete' | 'partial' | 'needs_review';
}
```

### 7.3 Updated Types (Backward Compatible)

```typescript
// AgentTemplate gains domain awareness (new fields optional)
interface AgentTemplate {
  name: string;
  model: ModelTier;
  version: string;
  domain?: DomainId;              // NEW — defaults to 'software'
  description: string;
  system_prompt: string;
  skills: string[];
  triggers: AgentTriggers;
  collaboration: AgentCollaboration;
  context: AgentContext;
  iron_laws?: string[];           // NEW — non-negotiable rules
  gates?: {                       // NEW — pre/post execution checks
    pre: string[];
    post: string[];
  };
  subscriptions?: string[];       // NEW — event types this agent listens for
}

// TeamAgents becomes extensible
interface TeamAgents {
  strategic: string[];
  implementation: string[];
  quality: string[];
  utility: string[];
  [category: string]: string[];   // NEW — custom categories
}

// TeamManifest gains domain and collaboration info
interface TeamManifest {
  name: string;
  forged_at: string;
  forged_by: string;
  project_hash: string;
  project_brief?: ProjectBrief;           // NEW
  domains?: DomainId[];                   // NEW
  agents: TeamAgents;
  model_routing: ModelRouting;
  delegation_graph: DelegationGraph;
  collaboration?: CollaborationTemplate;  // NEW
}
```

## 8. Scanner Evolution

### 8.1 Existing Scanners (Software Domain)

These move under the software domain pack but remain unchanged:

| Scanner | Model | What It Detects |
|---------|-------|-----------------|
| File Scanner | Haiku | Languages, frameworks, directory patterns, naming conventions |
| Git Analyzer | Haiku | Active areas, commit patterns, contributors, branch strategy |
| Dependency Mapper | Haiku | Package managers, version constraints, known vulnerabilities |
| CI Auditor | Sonnet | Build systems, test frameworks, deployment targets |

### 8.2 New Scanners

| Scanner | Model | Domain | What It Detects |
|---------|-------|--------|-----------------|
| Document Analyzer | Sonnet | Core | Document types (business plans, PRDs, contracts), structure, key entities, goals |
| Integration Detector | Haiku | Core | References to external tools (Jira, Confluence, Slack, Linear) in docs, configs, code comments |
| Web Researcher | Haiku | Core | Market data, competitor info, industry trends via autonomous web search |
| Code Comment Miner | Haiku | Software | TODOs, FIXMEs, decision records, architecture notes embedded in code |

### 8.3 Domain Scanner Strategy

Non-software domains (business, marketing, product, research, sales, legal, HR, IT) rely on the Core scanners (Document Analyzer, Integration Detector, Web Researcher) as their primary scanning infrastructure. Domain-specific scanner logic is implemented as analysis rules within the Document Analyzer — for example, the legal domain configures the Document Analyzer to look for contract structures, regulatory references, and compliance patterns. Domain-specific scanners may be added in later phases as needed.

### 8.4 Pluggable Scanner Architecture

Scanner-related types (see below) are part of the overall type system defined in Section 7.

```typescript
interface DomainScannerPlugin {
  name: string;
  domain: DomainId;
  model: ModelTier;
  scan(projectRoot: string): Promise<ScanOutput>;
}

interface ScanOutput {
  scanner: string;
  domain: DomainId;
  signals: string[];                    // activation signals detected
  data: Record<string, unknown>;        // scanner-specific structured output
}
```

The base scanner orchestrator discovers and runs all registered scanners in parallel via `Promise.allSettled`, then feeds results to the Genesis agent for synthesis.

## 9. Migration Path

The expansion is backward-compatible with v1:

| v1 Component | v2 Migration |
|-------------|-------------|
| `templates/agents/*.yaml` | Move to `templates/domains/software/agents/` |
| `AgentTemplate` type | Gains optional `domain`, `iron_laws`, `gates` fields |
| `TeamManifest` type | Gains optional `domains`, `collaboration`, `project_brief` fields |
| `composeTeam()` | Becomes software domain's composition logic |
| Existing scanners | Become software domain's scanner pack |
| `forgeTeam()` | Calls Genesis workflow, which delegates to domain composition |
| Existing `.agentforge/` dirs | Remain valid; `reforge` upgrades to v2 format |

## 10. Implementation Roadmap

| Phase | Deliverables | Dependencies |
|-------|-------------|-------------|
| **Phase A: Restructure** | Move existing templates into `templates/domains/software/`, add `domain.yaml` manifests, create core domain with universal agents, add new types (all changes are additive — new optional fields only, no data migration required, v1 consumers continue to work unchanged) | Existing codebase |
| **Phase B: Genesis Agent** | Adaptive entry-point workflow (discovery → context → interview → domain selection → team design → forge), Project Brief system | Phase A |
| **Phase C: Domain Packs (Business + Product)** | Business and product domain packs with templates, skills, document analyzer scanner, collaboration templates | Phase A |
| **Phase D: Collaboration Engine** | Collaboration template system, topology selection, cross-domain bridge builder, merged delegation graphs, progress ledger with stall/loop detection, delegation primitives (delegate_work / ask_coworker), loop counters, broadcast event system, structured handoff protocol, shared context manager | Phases A, C |
| **Phase E: Skill System v2** | Structured skill schema, skill registry, gates, composability, core + domain-specific skills | Phase A |
| **Phase F: Remaining Domains** | Marketing, Research, Sales, Legal, HR, IT domain packs (parallelizable — each pack is independent) | Phase C (pattern established) |
| **Phase G: Meta-Agents** | Meta-Architect, Skill Designer, Team Reviewer, Template Optimizer | Phase E |
| **Phase H: Integration Layer** | Document scanner, integration discovery (Jira/Confluence/etc.), external research pipeline | Phase B |

### Critical Path

Phases A → B → C → D form the critical path. Phase E can run in parallel with C/D. Phase F is highly parallelizable once the domain pack pattern is established in Phase C.

### Dependency Graph

```
Phase A ──┬──▶ Phase B ──▶ Phase H
          │
          ├──▶ Phase C ──┬──▶ Phase D
          │              │
          │              └──▶ Phase F (parallelizable)
          │
          └──▶ Phase E ──▶ Phase G
```

## 11. Runtime Orchestration

### 11.1 Progress Ledger (from AutoGen Magentic-One)

The orchestrator maintains a **progress ledger** — a structured state tracker that monitors team execution and prevents stalls, loops, and wasted work. The ledger is evaluated after every agent action.

```typescript
interface ProgressLedger {
  task_id: string;
  objective: string;

  // Fact tracking
  facts: {
    given: string[];              // Known facts from the task/context
    to_look_up: string[];         // Facts that need research
    to_derive: string[];          // Facts that need computation/reasoning
    educated_guesses: string[];   // Uncertain but useful assumptions
  };

  // Progress tracking
  plan: string[];                 // Current step-by-step plan
  steps_completed: string[];      // What's been done
  current_step: string | null;    // What's in progress

  // Health checks (evaluated after every agent action)
  is_request_satisfied: boolean;  // Is the objective met?
  is_in_loop: boolean;            // Are we repeating the same actions?
  is_progress_being_made: boolean; // Are we moving forward?
  confidence: number;             // 0-1 confidence in current approach

  // Routing
  next_speaker: string | null;    // Which agent should act next
  instruction: string;            // What to tell the next agent
}
```

When `is_in_loop` is true or `is_progress_being_made` is false for 3 consecutive checks, the orchestrator:
1. Re-evaluates the plan
2. Tries a different agent or approach
3. Escalates to a higher-tier agent (e.g., Sonnet → Opus)
4. Escalates to human if all else fails

### 11.2 Delegation Primitives (from CrewAI)

Two battle-tested delegation primitives are injected into every agent that has `can_delegate_to` configured:

```typescript
interface DelegationPrimitives {
  // Delegate a complete task to a coworker
  delegate_work: {
    task: string;         // What needs to be done
    context: string;      // Relevant background/constraints
    coworker: string;     // Target agent name
    response_format: 'summary' | 'full' | 'structured';
  };

  // Ask a coworker a question without delegating the full task
  ask_coworker: {
    question: string;     // What you need to know
    context: string;      // Why you need it
    coworker: string;     // Target agent name
  };
}
```

The key distinction: `delegate_work` hands off responsibility (the delegate owns the outcome), while `ask_coworker` requests information (the asker retains ownership). This prevents ambiguity about who is responsible for what.

These primitives are automatically available to any agent whose `collaboration.can_delegate_to` list is non-empty. The orchestrator validates that the target coworker is in the delegation graph before executing.

### 11.3 Loop Prevention (from ChatDev)

Every collaboration template includes **loop counters** at key iteration points to prevent infinite cycles:

```yaml
loop_limits:
  review_cycle: 3          # max review-fix-review iterations before escalation
  delegation_depth: 5      # max nested delegation chain length
  retry_same_agent: 2      # max retries with same agent on same task
  total_actions: 50         # max total agent actions per top-level task
```

When a limit is hit, the orchestrator:
1. Logs the loop with full context to `forge.log`
2. Escalates to the next level (agent lead → domain lead → coordinator → human)
3. Never silently continues

Loop counters are configurable per collaboration template and can be overridden in `.agentforge/config/delegation.yaml`.

### 11.4 Shared Context & Memory

Agents working together need shared understanding. The orchestrator manages three levels of context:

**Task Context** — Scoped to a single task. The orchestrator constructs exactly what each agent needs (subagent context isolation). Agents never inherit the full session history of other agents.

**Team Context** — Shared across the team for the current session. Includes:
- Project Brief (goals, constraints, domains)
- Decisions made by strategic agents (architecture choices, strategy decisions)
- Artifacts produced (code, docs, plans)
- Current progress ledger state

**Project Context** — Persistent across sessions. Stored in `.agentforge/`:
- `analysis/project-scan.json` — Latest scan results
- `forge.log` — All team decisions and rationale
- `config/decisions.yaml` — Key decisions with rationale, made by strategic agents, that downstream agents should respect

When an agent is invoked, the orchestrator assembles its context from these three levels based on the agent's `context.max_files` and `context.auto_include` settings.

### 11.5 Broadcast & Event System

Beyond point-to-point delegation, the orchestrator supports broadcasts for events that affect multiple agents:

```typescript
interface TeamEvent {
  type: 'dependency_change' | 'architecture_decision' | 'security_alert' |
        'constraint_change' | 'milestone_reached' | 'context_update';
  source: string;           // Agent that triggered the event
  payload: unknown;          // Event-specific data
  notify: string[];          // Agents to notify (or '*' for all)
}
```

Example events:
- A Security Auditor discovers a vulnerability → broadcasts `security_alert` to Coder, DevOps, Architect
- An Architect makes an API design decision → broadcasts `architecture_decision` to all implementation agents
- A CMO changes brand guidelines → broadcasts `context_update` to Content Strategist, Copywriter, Social Media Manager

Agents declare which event types they subscribe to in their template:

```yaml
# In agent template YAML
subscriptions:
  - architecture_decision
  - security_alert
  - dependency_change
```

### 11.6 Handoff Protocol

When one agent completes work and another needs to continue (pipeline pattern), the handoff includes structured metadata:

```typescript
interface Handoff {
  from: string;
  to: string;
  artifact: {
    type: 'code' | 'document' | 'analysis' | 'plan' | 'review' | 'data';
    summary: string;          // What was produced
    location: string;         // Where the artifact lives (file path, etc.)
    confidence: number;       // 0-1 how confident the producing agent is
  };
  open_questions: string[];   // Things the next agent should address
  constraints: string[];      // Decisions already made that must be respected
  status: 'complete' | 'partial' | 'needs_review';
}
```

This prevents the "context loss" problem where an agent in a pipeline doesn't understand what the previous agent intended or what decisions were already made.

## 12. Key Architectural Patterns (Summary)

The following patterns from Anthropic's built-in agents, the Superpowers plugin, and open-source frameworks are adopted throughout the system:

1. **Iron Laws** — Non-negotiable rules stated emphatically, with no-exception framing and rationalization prevention tables.
2. **Hard Gates** — Explicit blocks that prevent proceeding without meeting conditions (review-before-complete, verify-before-claim).
3. **Confidence-Based Filtering** — Agents score findings 0-100 and only report at >= 80 to reduce noise.
4. **Two-Stage Review** — Spec compliance (did they build the right thing?) separate from quality (did they build it well?).
5. **Subagent Context Isolation** — Controllers construct exactly what subagents need; subagents never inherit session history.
6. **Escalation Paths with Bounds** — 3 retries → escalate to lead → escalate to human. No infinite loops.
7. **Background Watchdog Pattern** — Agents that run proactively, only reporting when actionable issues found.
8. **Meta-Agent Pattern** — Agents that create and validate other agents for self-improving systems.
9. **Phased Workflows** — Different agent types dispatched at each phase of a workflow (discovery → explore → implement → review).
10. **Verification-Before-Claim** — Run verification commands and read output before claiming success. Evidence before assertions.
11. **Progress Ledger** (AutoGen Magentic-One) — Structured state tracking with stall/loop detection and automatic re-planning.
12. **Delegation Primitives** (CrewAI) — `delegate_work` vs `ask_coworker` distinction for clear responsibility ownership.
13. **Loop Counters** (ChatDev) — Configurable iteration limits at every cycle point to prevent infinite loops.
14. **Broadcast Events** — Pub-sub system for notifying multiple agents of cross-cutting changes.
15. **Structured Handoffs** — Artifact metadata, open questions, and constraint propagation between pipeline stages.

## 13. Security Considerations

All v1 security principles carry forward, plus:

- **Domain isolation** — Agents in one domain cannot access another domain's tools unless the delegation graph explicitly bridges them.
- **Business document handling** — Document analyzer extracts structure and summaries, never stores raw sensitive content (financials, contracts) in scan results.
- **Integration credentials** — Integration references (Jira, Confluence) are stored as references, not credentials. Authentication is delegated to the user's existing tool configuration.
- **Meta-agent constraints** — Meta-Architect can create agent templates but cannot bypass the permission model. Generated agents inherit the same sandbox restrictions.
- **Audit trail** — All cross-domain delegations, meta-agent template creations, and Genesis decisions are logged in `forge.log`.
