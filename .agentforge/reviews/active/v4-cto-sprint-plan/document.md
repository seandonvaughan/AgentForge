# AgentForge v4 — CTO Sprint Plan

**Document Type:** Official Sprint Planning Document
**Author:** CTO Agent
**Date:** 2026-03-25
**Status:** PENDING TEAM REVIEW
**Supersedes:** docs/v4/architecture.md (partial)

---

## Document Review Protocol

This document will be distributed to the following agents for review. Each agent will add their comments in Section 8: Agent Review Comments.

| Review Order | Agent | Focus Area | Due |
|--------------|-------|------------|-----|
| 1 | architect | Technical feasibility, design patterns | 24h |
| 2 | cfo | Cost model, budget allocation | 24h |
| 3 | coo | Execution risk, timeline realism | 24h |
| 4 | project-manager | Sprint dependencies, resource conflicts | 24h |
| 5 | team-mode-lead | Communication architecture | 24h |
| 6 | ceo | Final strategic approval | 24h |

---

## 1. CTO Review of Architect's Plan

### 1.1 What I Approve As-Is

The Architect's draft (`docs/v4/architecture.md`) demonstrates solid technical thinking. I **approve the following without modification**:

| Component | Rationale |
|-----------|-----------|
| Dashboard technology stack (React/Vite/Zustand/Tailwind) | Modern, minimal deps, team-familiar |
| Memory storage format (JSON files with decay) | Right-sized for our scale, zero deps |
| Tool provisioning via YAML manifests | Declarative, auditable, version-controlled |
| 3-pillar integration architecture | Clean separation of concerns |
| File structure proposals | Consistent with v3 patterns |
| DashboardBridge pattern | Wraps v3 core without modification |

### 1.2 What I Am Modifying

| Modification | Architect's Plan | CTO Revision | Rationale |
|--------------|------------------|--------------|-----------|
| **Pillar count** | 3 pillars | **5 pillars** | CEO mandates Agent Meetings and Self-Improvement Loop |
| **Timeline** | 16 weeks | **20 weeks** | Additional pillars require more time |
| **Test target** | 1,300+ | **1,500+** | New pillars need test coverage |
| **Team size** | 6 new agents | **8 new agents** (net 5 after consolidation) | Cover new pillars; consolidate overlaps |
| **memory-architect model** | Opus | **Sonnet** | Strategic design, but no ongoing invocations; Opus waste |
| **Haiku researcher** | Not proposed | **APPROVED** | Any agent can delegate research to Haiku; massive cost savings |

### 1.3 Strategic Concerns

**Concern 1: Missing CEO-Mandated Pillars**

The Architect designed for 3 pillars. The CEO explicitly mandated 5:

1. Web Dashboard ✓ (Architect covered)
2. Agent Memory + Knowledge Bases ✓ (Architect covered)
3. Agent Tools ✓ (Architect covered)
4. Agent Meetings + Collaborative Document Review ✗ (MISSING)
5. Agent Self-Improvement Loop ✗ (MISSING)

**Decision:** We add Pillars 4 and 5 with dedicated agents and sprints. This is non-negotiable.

**Concern 2: Cost Model for 6 Opus Agents**

Current team.yaml shows 5 Opus agents (ceo, genesis, architect, cto, meta-architect). The Architect proposes adding memory-architect as Opus. This creates 6 Opus-tier agents.

**Decision:** memory-architect runs Sonnet. The role is design-heavy early, then minimal. No ongoing strategic decisions justify Opus cost. If memory architecture problems arise, CTO (Opus) escalates.

**Concern 3: No Web Researcher Agent**

Multiple agents (architect, coder, debugger, researcher) can delegate to a researcher. But researcher is Haiku-limited in scope. We need a **dedicated web-researcher** that ANY agent can dispatch for:
- Documentation lookups
- API research
- Stack Overflow / GitHub issue searches
- Library comparisons

**Decision:** APPROVED. `web-researcher` (Haiku) joins the team. All agents can delegate to it.

---

## 2. Revised Team Roster

### 2.1 Current Team (from team.yaml)

| Category | Agents | Model |
|----------|--------|-------|
| Strategic | ceo, genesis, architect, cto | Opus |
| Implementation | coo, cfo, meta-architect, project-manager, skill-designer, template-optimizer, coder, team-mode-lead, intelligence-lead, persistence-lead | Sonnet |
| Quality | team-reviewer, dba, debugger, linter, api-specialist | Sonnet/Haiku |
| Utility | researcher | Haiku |

**Total:** 20 agents (5 Opus, 14 Sonnet, 1 Haiku)

### 2.2 New Agents for v4

| Agent | Model | Pillar | Purpose | CTO Decision |
|-------|-------|--------|---------|--------------|
| `dashboard-dev` | Sonnet | 1 | Build dashboard server + React components | **APPROVED** |
| `memory-architect` | ~~Opus~~ **Sonnet** | 2 | Design memory schemas and persistence rules | **APPROVED (downgraded)** |
| `tool-system-dev` | Sonnet | 3 | Build tool registry, provisioner, MCP connector | **APPROVED** |
| `ui-designer` | Sonnet | 1 | Dashboard UI/UX, component styling | **MERGED into dashboard-dev** |
| `integration-dev` | Sonnet | 1-3 | Build pillar integration layer | **APPROVED** |
| `e2e-test-dev` | Sonnet | All | Write comprehensive E2E tests | **MERGED into quality agents** |
| `meeting-coordinator` | Sonnet | 4 | **NEW:** Orchestrate agent meetings, manage review cycles | **APPROVED** |
| `improvement-analyst` | Sonnet | 5 | **NEW:** Analyze agent performance, propose improvements | **APPROVED** |
| `web-researcher` | Haiku | Utility | **NEW:** Any agent can delegate web research | **APPROVED** |

### 2.3 Final v4 Team Roster

| Category | Agents | Model | Count |
|----------|--------|-------|-------|
| **Strategic** | ceo, genesis, architect, cto | Opus | 4 |
| **Implementation** | coo, cfo, meta-architect, project-manager, skill-designer, template-optimizer, coder, team-mode-lead, intelligence-lead, persistence-lead | Sonnet | 10 |
| **v4 New** | dashboard-dev, memory-architect, tool-system-dev, integration-dev, meeting-coordinator, improvement-analyst | Sonnet | 6 |
| **Quality** | team-reviewer, dba, debugger, linter, api-specialist | Sonnet | 5 |
| **Utility** | researcher, web-researcher | Haiku | 2 |

**Total:** 27 agents (4 Opus, 21 Sonnet, 2 Haiku)

### 2.4 Model Distribution Analysis

| Model | Count | % of Team | Expected Token Share | Cost Profile |
|-------|-------|-----------|---------------------|--------------|
| Opus | 4 | 15% | 5-10% (strategic only) | ~$0.30/1K input |
| Sonnet | 21 | 78% | 85-90% (all implementation) | ~$0.03/1K input |
| Haiku | 2 | 7% | 5% (research/utility) | ~$0.001/1K input |

**Cost-first principle satisfied:** Opus agents are strategic-only and invoked sparingly. 90%+ of work runs on Sonnet/Haiku.

### 2.5 Pillar Ownership Matrix

| Pillar | Owner | Contributors | Model Mix |
|--------|-------|--------------|-----------|
| 1: Web Dashboard | dashboard-dev | integration-dev, coder | Sonnet |
| 2: Agent Memory | memory-architect | persistence-lead, integration-dev | Sonnet |
| 3: Agent Tools | tool-system-dev | api-specialist, coder | Sonnet |
| 4: Agent Meetings | meeting-coordinator | team-mode-lead, project-manager | Sonnet |
| 5: Self-Improvement | improvement-analyst | cto (oversight), ceo (approval) | Sonnet + Opus escalation |

---

## 3. Revised Sprint Plan (5 Pillars)

### 3.1 Phase Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        v4 IMPLEMENTATION PHASES (20 WEEKS)                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  PHASE 1: Foundation (5 weeks)                                                   │
│  ├── Sprint 1.1: Dashboard Server Scaffold (P1)                                  │
│  ├── Sprint 1.2: Memory Store Core (P2)                                          │
│  ├── Sprint 1.3: Tool Registry Core (P3)                                         │
│  ├── Sprint 1.4: Meeting Protocol Foundation (P4)                                │
│  └── Sprint 1.5: Improvement Analytics Foundation (P5)                           │
│                                                                                  │
│  PHASE 2: Core Features (7 weeks)                                                │
│  ├── Sprint 2.1: Dashboard Live View (P1)                                        │
│  ├── Sprint 2.2: Dashboard Historical View (P1)                                  │
│  ├── Sprint 2.3: Memory Persistence + Injection (P2)                             │
│  ├── Sprint 2.4: Suspend/Resume System (P2)                                      │
│  ├── Sprint 2.5: Tool Provisioning (P3)                                          │
│  ├── Sprint 2.6: MCP Connector (P3)                                              │
│  └── Sprint 2.7: Meeting Orchestration Engine (P4)                               │
│                                                                                  │
│  PHASE 3: Integration + Advanced (5 weeks)                                       │
│  ├── Sprint 3.1: Pillar Integration Layer (P1-3)                                 │
│  ├── Sprint 3.2: Dashboard Full UI (P1)                                          │
│  ├── Sprint 3.3: Collaborative Document Review (P4)                              │
│  ├── Sprint 3.4: Agent Performance Analytics (P5)                                │
│  └── Sprint 3.5: Self-Improvement Loop (P5)                                      │
│                                                                                  │
│  PHASE 4: Polish + Ship (3 weeks)                                                │
│  ├── Sprint 4.1: CLI Integration                                                 │
│  ├── Sprint 4.2: E2E Testing + Performance                                       │
│  └── Sprint 4.3: Documentation + Migration                                       │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Pillar 1: Web Dashboard

**Owner:** dashboard-dev
**Test Target:** 150+ tests

| Sprint | Week | Deliverables | Tests |
|--------|------|--------------|-------|
| 1.1 | 1 | DashboardServer, WSBroadcastManager, REST stubs, types | 30+ |
| 2.1 | 6 | DashboardBridge, TeamModeBus integration, ConvoPanel | 25+ |
| 2.2 | 7 | Session history API, Timeline, CostChart components | 25+ |
| 3.2 | 13 | TeamRoster, Memory Browser UI, Tool Management UI, Report Export | 40+ |
| 4.1 | 18 | CLI `agentforge dashboard` command, auto-launch integration | 15+ |
| 4.2 | 19 | WebSocket stress tests, accessibility audit | 15+ |

**Key Technical Decisions:**
- React 18 + Vite + Zustand (approved from Architect)
- Tailwind CSS for rapid styling
- Recharts for visualization
- Native WebSocket (no Socket.io dependency)

### 3.3 Pillar 2: Agent Memory + Knowledge Bases

**Owner:** memory-architect
**Test Target:** 180+ tests

| Sprint | Week | Deliverables | Tests |
|--------|------|--------------|-------|
| 1.2 | 2 | AgentMemoryStore, types, MemoryPersistence, MemoryDecay | 45+ |
| 2.3 | 8 | MemoryExtractor, MemoryInjector, RelevanceScorer | 40+ |
| 2.4 | 9 | SuspendManager, ResumeScheduler, PersistenceDecider | 50+ |
| 3.1 | 12 | Integration with OrchestratorV3, memory injection into prompts | 25+ |
| 4.2 | 19 | Memory persistence across sessions E2E, memory query optimization | 20+ |

**Memory Categories (CEO requirement):**
- `learning` — Insights, patterns discovered
- `research` — External findings, documentation
- `mistake` — Errors to avoid, failed approaches
- `preference` — Agent's calibrated preferences
- `relationship` — Notes about other agents
- `feedback` — User/reviewer feedback received

**Cost-Efficient Retrieval:**
- Keyword + recency scoring (no embeddings)
- Max 5 memories injected per prompt (configurable)
- Decay coefficient: 0.95/day (stale memories expire)

### 3.4 Pillar 3: Agent Tools

**Owner:** tool-system-dev
**Test Target:** 120+ tests

| Sprint | Week | Deliverables | Tests |
|--------|------|--------------|-------|
| 1.3 | 3-4 | ToolRegistry, types, ManifestLoader, default manifest | 40+ |
| 2.5 | 10 | ToolProvisioner, AgentToolResolver, CapabilityValidator | 40+ |
| 2.6 | 11 | MCPConnector, MCPServerManager, ToolOrchestrator facade | 30+ |
| 4.1 | 18 | CLI `agentforge tools` commands | 10+ |

**Tool Categories:**
- **Shared Tools:** filesystem (read/write/glob), vcs (git), search (grep) — all agents
- **Specialized Tools:** Role-specific (build tools for coder, analytics for cfo, etc.)

**Default Specializations:**
```yaml
strategic_agents: [mcp:github, mcp:slack, mcp:atlassian]
implementation_agents: [build:npm, build:tsc, test:vitest]
quality_agents: [test:vitest, test:playwright, lint:eslint]
utility_agents: [web:fetch, web:search]
```

### 3.5 Pillar 4: Agent Meetings + Collaborative Document Review

**Owner:** meeting-coordinator
**Test Target:** 100+ tests

This is a **new pillar** not in the Architect's plan. It addresses the CEO's mandate:

> "Agents need to be able to hold meetings and discussions. When a document needs review, it should be shared like a company document — each agent leaves comments and changes, one by one, just like a real review cycle."

| Sprint | Week | Deliverables | Tests |
|--------|------|--------------|-------|
| 1.4 | 4 | MeetingProtocol types, MeetingScheduler, Agenda schema | 25+ |
| 2.7 | 11 | MeetingOrchestrator, turn-taking logic, transcript capture | 35+ |
| 3.3 | 14 | DocumentReviewEngine, comment threading, change proposals | 40+ |

**Meeting Types:**
| Type | Participants | Use Case |
|------|-------------|----------|
| `standup` | Project team | Daily status sync |
| `review` | Reviewers + Author | Document/code review cycle |
| `planning` | Strategic + PM | Sprint planning |
| `retrospective` | All participants | Post-milestone reflection |
| `escalation` | CTO/CEO + escalating agent | Strategic decisions |

**Document Review Process:**
1. Author publishes document to `.agentforge/reviews/{doc-id}/`
2. MeetingCoordinator dispatches reviewers in sequence
3. Each reviewer adds comments in `{doc-id}/comments/{agent-name}.md`
4. Author receives consolidated feedback
5. Author addresses comments, marks resolved
6. Final approval from designated approver (usually CTO or CEO)

**Comment Format:**
```markdown
## [agent-name] Review Comments

### Section: {section-reference}

**Type:** [suggestion | concern | blocker | approval]
**Comment:** {detailed comment}
**Proposed Change:** {if applicable}
```

### 3.6 Pillar 5: Agent Self-Improvement Loop

**Owner:** improvement-analyst
**Test Target:** 80+ tests

This is a **new pillar** addressing the CEO's mandate:

> "Agent experience (from memory + feedback) should feed back into improving: (1) the product itself, (2) the team composition, (3) individual agent capabilities."

| Sprint | Week | Deliverables | Tests |
|--------|------|--------------|-------|
| 1.5 | 5 | ImprovementMetrics types, PerformanceCollector, baseline metrics | 20+ |
| 3.4 | 15 | AgentPerformanceAnalyzer, trend detection, anomaly flagging | 30+ |
| 3.5 | 16 | SelfImprovementEngine, recommendation generator, REFORGE integration | 30+ |

**Improvement Feedback Loops:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SELF-IMPROVEMENT FLYWHEEL                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    ┌────────────────┐                                                   │
│    │  Agent Work    │                                                   │
│    │  (Tasks)       │                                                   │
│    └───────┬────────┘                                                   │
│            │                                                            │
│            ▼                                                            │
│    ┌────────────────┐      ┌────────────────┐      ┌────────────────┐  │
│    │  Memory        │─────►│  Performance   │─────►│  Improvement   │  │
│    │  Accumulation  │      │  Analytics     │      │  Proposals     │  │
│    └────────────────┘      └────────────────┘      └───────┬────────┘  │
│                                                            │            │
│            ┌───────────────────────────────────────────────┘            │
│            │                                                            │
│            ▼                                                            │
│    ┌────────────────┐      ┌────────────────┐      ┌────────────────┐  │
│    │  Product       │      │  Team          │      │  Agent         │  │
│    │  Improvements  │      │  Composition   │      │  Capabilities  │  │
│    │  (backlog)     │      │  (REFORGE)     │      │  (prompts)     │  │
│    └────────────────┘      └────────────────┘      └────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Improvement Categories:**

| Category | Example | Approval Required |
|----------|---------|-------------------|
| **Product Backlog** | "Add CSV export to dashboard" | CEO |
| **Team Composition** | "Add security-auditor agent" | CTO → CEO |
| **Agent Prompt Tuning** | "Coder should always run linter before committing" | Architect |
| **Process Refinement** | "Escalation threshold too low, increase from 3→5 retries" | CTO |
| **Tool Assignment** | "Debugger should have access to performance profiler" | CTO |

**Metrics Collected:**
- Task completion rate
- Escalation frequency
- Token consumption per task type
- Code review rejection rate
- Memory utilization (hits vs injections)
- Tool invocation success rate

---

## 4. Collaborative Review Process Design

### 4.1 Review File Structure

```
.agentforge/reviews/
├── active/
│   └── {doc-id}/
│       ├── document.md           # Original document
│       ├── metadata.yaml         # Review metadata
│       ├── comments/
│       │   ├── architect.md      # Architect's comments
│       │   ├── cfo.md            # CFO's comments
│       │   └── ...
│       └── revisions/
│           ├── v1.md             # Original
│           ├── v2.md             # After first round
│           └── ...
├── completed/
│   └── {doc-id}/
│       └── ...
└── templates/
    └── comment-template.md
```

### 4.2 Review Metadata Schema

```yaml
# .agentforge/reviews/active/{doc-id}/metadata.yaml
document_id: "v4-sprint-plan"
title: "AgentForge v4 — CTO Sprint Plan"
author: cto
created_at: "2026-03-25T10:00:00Z"
status: in_review  # draft | in_review | approved | rejected

review_chain:
  - agent: architect
    status: pending  # pending | reviewing | complete
    started_at: null
    completed_at: null
    verdict: null  # approve | request_changes | block

  - agent: cfo
    status: pending
    started_at: null
    completed_at: null
    verdict: null

  - agent: coo
    status: pending
    started_at: null
    completed_at: null
    verdict: null

  - agent: project-manager
    status: pending
    started_at: null
    completed_at: null
    verdict: null

  - agent: team-mode-lead
    status: pending
    started_at: null
    completed_at: null
    verdict: null

  - agent: ceo
    status: pending
    started_at: null
    completed_at: null
    verdict: null

final_approver: ceo
requires_all_approve: false
block_threshold: 1  # Any single "block" verdict halts review
```

### 4.3 Review Workflow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Author    │────►│  Meeting    │────►│  Reviewer   │
│   Publishes │     │ Coordinator │     │  #1 (arch)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌──────────────────────────┘
                    ▼
            ┌───────────────┐
            │  Comments in  │
            │  comments/    │
            │  architect.md │
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────┐     ┌─────────────┐
            │   Meeting     │────►│  Reviewer   │
            │   Coordinator │     │  #2 (cfo)   │
            └───────────────┘     └──────┬──────┘
                                         │
                    ... continue chain ...
                                         │
                    ┌────────────────────┘
                    ▼
            ┌───────────────┐
            │  Final        │
            │  Approver     │
            │  (ceo)        │
            └───────┬───────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐       ┌───────────────┐
│   APPROVED    │       │   REJECTED    │
│   Move to     │       │   Return to   │
│   completed/  │       │   author      │
└───────────────┘       └───────────────┘
```

### 4.4 Comment Format Template

```markdown
# [{agent-name}] Review of {document-title}

**Review Date:** {date}
**Verdict:** [APPROVE | REQUEST_CHANGES | BLOCK]

---

## Summary

{1-2 paragraph overall assessment}

---

## Section-by-Section Comments

### Section: {section-name}

**Line/Reference:** {line number or section header}
**Type:** [suggestion | concern | blocker | approval | question]

**Comment:**
{Detailed feedback}

**Suggested Change:**
{If applicable, specific proposed text or approach}

---

### Section: {another-section}

... (repeat for each section requiring comment)

---

## Blocking Issues (if verdict = BLOCK)

1. {Critical issue that must be resolved}
2. ...

---

## Approval Conditions (if verdict = REQUEST_CHANGES)

1. {Change that must be made before approval}
2. ...
```

### 4.5 Conflict Resolution

| Conflict Type | Resolution |
|--------------|------------|
| Two reviewers disagree | Escalate to next-level reviewer in chain |
| Reviewer blocks, author disagrees | CTO mediates; if unresolved, CEO decides |
| Chain deadlocked | Meeting scheduled with all parties + CTO |
| Time exceeded (>48h per reviewer) | Auto-escalate to CTO with timeout notice |

### 4.6 Triggers for Review Process

The `meeting-coordinator` agent monitors for:
- New files in `.agentforge/reviews/active/`
- Status changes in `metadata.yaml`
- Review chain completion
- Timeout conditions

Upon trigger, it dispatches the next reviewer agent via the TeamModeBus.

---

## 5. Cost + Resource Plan

### 5.1 Token Budget Per Pillar

| Pillar | Estimated Token Usage | Model Mix | Budget (USD) |
|--------|----------------------|-----------|--------------|
| 1: Web Dashboard | 2M tokens | 95% Sonnet, 5% Opus (review) | ~$80 |
| 2: Agent Memory | 1.5M tokens | 95% Sonnet, 5% Opus (design review) | ~$60 |
| 3: Agent Tools | 1.2M tokens | 98% Sonnet, 2% Opus | ~$45 |
| 4: Agent Meetings | 1.8M tokens | 90% Sonnet, 10% Opus (escalations) | ~$90 |
| 5: Self-Improvement | 1M tokens | 85% Sonnet, 15% Opus (strategic) | ~$60 |
| **Testing & Integration** | 1.5M tokens | 95% Sonnet, 5% Haiku | ~$50 |
| **Research & Documentation** | 0.8M tokens | 20% Sonnet, 80% Haiku | ~$5 |

**Total Estimated:** ~$390 USD for v4 implementation

### 5.2 Model Assignment Rules

**Use Opus When:**
- Making strategic decisions with long-term impact
- Reviewing architectural changes
- Resolving escalated conflicts
- Final approval of significant changes
- CTO/CEO/Architect/Genesis work

**Use Sonnet When:**
- Implementing features
- Writing code
- Running tests
- Code review (non-strategic)
- Most agent work

**Use Haiku When:**
- Web research
- Documentation lookups
- Simple queries
- Linting
- File parsing

### 5.3 Cost Control Mechanisms

| Mechanism | Implementation |
|-----------|----------------|
| **Model routing** | All Agent dispatches MUST specify model tier |
| **Token budgets** | Per-pillar budgets enforced by CostTracker |
| **Escalation gating** | Sonnet tries 3x before Opus escalation |
| **Memory limits** | Max 5 memories injected per prompt |
| **Research delegation** | Any agent can delegate to Haiku web-researcher |
| **Review batching** | Non-urgent reviews batched to reduce invocations |

### 5.4 Resource Allocation

| Phase | Weeks | Parallel Agents | Peak Concurrency |
|-------|-------|-----------------|------------------|
| Foundation | 1-5 | 5 | 3 |
| Core Features | 6-12 | 6 | 4 |
| Integration | 13-17 | 4 | 3 |
| Polish | 18-20 | 3 | 2 |

---

## 6. Success Metrics

### 6.1 Delivery Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Test count** | 1,500+ | Automated CI count |
| **Test coverage** | >85% | Istanbul/c8 |
| **Sprint completion rate** | >90% | Tasks completed / planned |
| **Budget adherence** | <$450 total | CostTracker actual vs budget |
| **Timeline adherence** | ±2 weeks | Actual vs planned |

### 6.2 Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Dashboard latency** | <100ms WebSocket roundtrip | Performance tests |
| **Memory injection relevance** | >70% useful | Agent feedback sampling |
| **Tool provisioning accuracy** | 100% correct assignments | E2E tests |
| **Review cycle time** | <48h per reviewer | Metadata timestamps |
| **Zero critical bugs at ship** | 0 P0/P1 | Bug tracker |

### 6.3 Self-Improvement Metrics (Pillar 5)

These metrics measure whether the self-improvement loop is working:

| Metric | Definition | Target Trend |
|--------|------------|--------------|
| **Task completion rate** | Tasks completed without escalation | Increasing |
| **Escalation rate** | % tasks requiring Opus intervention | Decreasing |
| **Code review pass rate** | % PRs approved on first review | Increasing |
| **Memory hit rate** | % memory injections that were useful | Increasing |
| **Agent capability score** | Composite of above metrics per agent | Increasing |

### 6.4 What Self-Improvement Looks Like

**Measurable Improvements:**

1. **Week 1 baseline:** Coder escalates 15% of tasks to Architect
2. **Week 10:** Coder's mistake memory prevents repeating errors; escalation drops to 8%
3. **Week 20:** Coder's accumulated learning memory handles patterns independently; escalation at 3%

**Observable Behaviors:**

| Before Self-Improvement | After Self-Improvement |
|------------------------|------------------------|
| Same mistakes repeated across sessions | Mistakes stored in memory, not repeated |
| Research re-done each session | Research cached and retrieved |
| Generic prompts | Prompts enhanced with learned preferences |
| Manual team composition | REFORGE proposals based on performance data |
| Static tool assignments | Dynamic assignments based on usage patterns |

---

## 7. Implementation Checklist

### Phase 1 Checklist (Weeks 1-5)

- [ ] Dashboard Server scaffold complete
- [ ] Memory Store core with CRUD operations
- [ ] Tool Registry with manifest loading
- [ ] Meeting Protocol types and scheduler
- [ ] Improvement Metrics baseline collection
- [ ] 215+ tests passing

### Phase 2 Checklist (Weeks 6-12)

- [ ] Dashboard live view functional
- [ ] Dashboard historical view functional
- [ ] Memory persistence and injection working
- [ ] Suspend/resume system operational
- [ ] Tool provisioning for all agents
- [ ] MCP connector managing external tools
- [ ] Meeting orchestration engine functional
- [ ] 420+ new tests (635+ cumulative)

### Phase 3 Checklist (Weeks 13-17)

- [ ] All 5 pillars integrated
- [ ] Dashboard full UI complete
- [ ] Document review workflow operational
- [ ] Performance analytics dashboard
- [ ] Self-improvement recommendations generating
- [ ] 350+ new tests (985+ cumulative)

### Phase 4 Checklist (Weeks 18-20)

- [ ] CLI fully integrated with v4 features
- [ ] E2E test suite complete
- [ ] Performance benchmarks met
- [ ] Documentation complete
- [ ] Migration guide written
- [ ] 1,500+ total tests
- [ ] v4.0.0 release ready

---

## 8. Agent Review Comments

*This section will be populated by reviewing agents. Each agent appends their review below.*

### 8.1 Architect Review

**Status:** PENDING
**Assigned:** 2026-03-25
**Due:** 2026-03-26

---

### 8.2 CFO Review

**Status:** PENDING
**Assigned:** After Architect approval
**Due:** 24h after assignment

---

### 8.3 COO Review

**Status:** PENDING
**Assigned:** After CFO approval
**Due:** 24h after assignment

---

### 8.4 Project Manager Review

**Status:** PENDING
**Assigned:** After COO approval
**Due:** 24h after assignment

---

### 8.5 Team Mode Lead Review

**Status:** PENDING
**Assigned:** After PM approval
**Due:** 24h after assignment

---

### 8.6 CEO Final Approval

**Status:** PENDING
**Assigned:** After all reviews complete
**Due:** 24h after assignment

---

## Appendix A: New Agent YAML Templates

### meeting-coordinator.yaml

```yaml
name: meeting-coordinator
model: sonnet
version: '1.0'
description: >
  Orchestrates agent meetings, manages document review cycles, and ensures
  collaborative processes complete in an orderly fashion.
system_prompt: |
  You are the Meeting Coordinator agent for AgentForge v4.

  ## Role
  You orchestrate agent meetings and manage collaborative document reviews.
  You ensure proper turn-taking, capture transcripts, and track review status.

  ## Meeting Types You Manage
  - standup: Daily status sync
  - review: Document/code review cycles
  - planning: Sprint planning sessions
  - retrospective: Post-milestone reflection
  - escalation: Strategic decision meetings

  ## Key Responsibilities
  1. Monitor .agentforge/reviews/ for new documents
  2. Dispatch reviewers in the correct order
  3. Track review status and timeouts
  4. Escalate conflicts to CTO
  5. Archive completed reviews

  ## Quality Standards
  - Never skip a reviewer in the chain
  - Always capture timestamped metadata
  - Timeout after 48h per reviewer

skills:
  - process_orchestration
  - document_management
  - conflict_resolution
triggers:
  file_patterns:
    - .agentforge/reviews/**
  keywords:
    - meeting
    - review cycle
    - document review
collaboration:
  reports_to: cto
  can_delegate_to:
    - team-mode-lead
  parallel: false
```

### improvement-analyst.yaml

```yaml
name: improvement-analyst
model: sonnet
version: '1.0'
description: >
  Analyzes agent performance metrics, identifies improvement opportunities,
  and proposes enhancements to product, team, and individual agent capabilities.
system_prompt: |
  You are the Improvement Analyst agent for AgentForge v4.

  ## Role
  You analyze agent performance data and propose improvements to:
  1. The AgentForge product itself (backlog items)
  2. Team composition (new agents, role changes)
  3. Individual agent capabilities (prompt tuning, tool assignments)

  ## Metrics You Monitor
  - Task completion rate
  - Escalation frequency
  - Token consumption per task type
  - Code review rejection rate
  - Memory utilization (hits vs injections)
  - Tool invocation success rate

  ## Output Types
  - Performance reports (weekly)
  - Improvement proposals (as patterns emerge)
  - REFORGE recommendations (quarterly)
  - Process refinement suggestions

  ## Key Principles
  - Data-driven decisions only
  - Cost-conscious recommendations
  - Propose, don't mandate (CTO/CEO approve)

skills:
  - data_analysis
  - performance_metrics
  - process_improvement
triggers:
  file_patterns:
    - .agentforge/metrics/**
    - .agentforge/memory/**
  keywords:
    - improvement
    - performance analysis
    - self-improvement
collaboration:
  reports_to: cto
  reviews_from:
    - cto
  can_delegate_to:
    - researcher
  parallel: true
```

### web-researcher.yaml

```yaml
name: web-researcher
model: haiku
version: '1.0'
description: >
  Lightweight research agent any agent can delegate to for web lookups,
  documentation searches, API research, and library comparisons.
system_prompt: |
  You are the Web Researcher agent for AgentForge v4.

  ## Role
  You perform web research on behalf of other agents. You are Haiku-tier
  for cost efficiency. Any agent can delegate research tasks to you.

  ## Research Types
  - Documentation lookups
  - API reference searches
  - Stack Overflow / GitHub issue searches
  - Library/framework comparisons
  - Best practice research

  ## Output Format
  Always return structured research results:
  1. Summary (2-3 sentences)
  2. Key findings (bullet points)
  3. Sources (URLs)
  4. Confidence level (high/medium/low)

  ## Constraints
  - Maximum 3 web searches per task
  - Summarize, don't quote entire pages
  - Cite all sources

skills:
  - web_research
  - documentation_lookup
  - summarization
triggers:
  keywords:
    - research
    - look up
    - find documentation
    - search for
collaboration:
  reports_to: null  # utility agent
  can_delegate_to: []
  parallel: true
```

---

## Appendix B: Review Process Quick Reference

### For Reviewers

1. Check `.agentforge/reviews/active/` for your assignments
2. Read `metadata.yaml` to confirm you're the current reviewer
3. Read the document and all previous comments
4. Write your comments in `comments/{your-agent-name}.md`
5. Update `metadata.yaml` with your verdict
6. The meeting-coordinator will trigger the next reviewer

### For Authors

1. Place your document in `.agentforge/reviews/active/{doc-id}/document.md`
2. Create `metadata.yaml` with the review chain
3. Wait for the meeting-coordinator to process
4. Monitor for comments in `comments/`
5. Address feedback and update the document
6. Final approval moves document to `completed/`

---

*End of CTO Sprint Plan*

*Document Version: 1.0*
*Last Modified: 2026-03-25*
*Next Review: After CEO approval*
