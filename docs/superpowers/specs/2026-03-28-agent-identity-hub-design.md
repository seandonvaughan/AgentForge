# Agent Identity Hub — Team Building & Executive Tooling Overhaul

**Date:** 2026-03-28
**Status:** Proposed
**Approach:** B — Centralized Agent Lifecycle Manager

## Problem

AgentForge's team building logic is static and shallow. Teams are composed at forge-time by scanning file patterns, with no runtime adaptation. Agent state is scattered across OrgGraph, AutonomyGovernor, SessionMemory, SkillRegistry, and ExecutionEngine with no consistency guarantees. Executives (CEO, CTO, COO, CFO) have detailed system prompts but no actual invocable tools. Agents don't learn or grow — every session starts from zero.

## Vision

Mirror how real companies scale: permanent specialized teams, executives with real operational authority, agents that accumulate expertise over time, and senior agents that multitask across parallel work streams.

## Architecture: Agent Lifecycle Manager

A central hub that owns ALL agent state, decomposed into 5 focused stores:

```
AgentLifecycleManager
├── AgentRegistry        — who exists, their identity & config
├── TeamRegistry         — team structures, layers, capacity
├── CareerStore          — experience, skills, autonomy, history
├── ExecutiveToolSuite   — invocable tools per executive role
└── ConcurrencyManager   — parallel execution slots per agent
```

External callers never touch OrgGraph, AutonomyGovernor, or SessionMemory directly. They go through the lifecycle manager, which coordinates updates atomically.

### Key Files to Modify/Create

**New files:**
- `src/lifecycle/agent-lifecycle-manager.ts` — Central hub facade
- `src/lifecycle/agent-registry.ts` — Agent identity CRUD
- `src/lifecycle/team-registry.ts` — Team structure management
- `src/lifecycle/career-store.ts` — Per-agent career progression
- `src/lifecycle/concurrency-manager.ts` — Parallel execution slots
- `src/lifecycle/team-scaler.ts` — Bottleneck detection & hiring recommendations
- `src/skills/executive-tools/ceo-tools.ts` — CEO tool suite
- `src/skills/executive-tools/cto-tools.ts` — CTO tool suite
- `src/skills/executive-tools/coo-tools.ts` — COO tool suite
- `src/skills/executive-tools/cfo-tools.ts` — CFO tool suite
- `src/skills/executive-tools/vp-eng-tools.ts` — VP Engineering tool suite
- `src/types/lifecycle.ts` — All new type definitions
- `src/db/migrations/career-tables.ts` — New DB tables for career data

**Files to extend:**
- `src/types/team.ts` — Add TeamUnit, TechnicalLayer types
- `src/types/v4-api.ts` — Extend OrgNode with layer, seniority
- `src/builder/team-composer.ts` — Produce TeamUnit[] instead of flat lists
- `src/builder/team-writer.ts` — Write team units to team.yaml
- `src/orchestrator/execution-engine.ts` — Same-agent parallelism
- `src/orchestrator/control-loop.ts` — Query lifecycle manager for next agent
- `src/orchestrator/speaker-selector.ts` — Factor in seniority + concurrency
- `src/skills/skill-registry.ts` — Permission-gated executive tools
- `src/flywheel/autonomy-governor.ts` — Integrate with CareerStore
- `src/db/schema.ts` — New tables

---

## Subsystem 1: Team Hierarchy & Composition

### Agent Identity Model

Every agent gets a unified `AgentIdentity`:

```typescript
interface AgentIdentity {
  id: string;                    // e.g., "backend-senior-coder-1"
  name: string;                  // "Senior Coder"
  role: AgentRole;               // executive | manager | tech_lead | specialist
  seniority: SeniorityLevel;     // junior | mid | senior | lead | principal
  layer: TechnicalLayer;         // frontend | backend | infra | data | platform | qa | research | executive
  teamId: string;                // which team they belong to
  model: ModelTier;              // opus | sonnet | haiku
  status: AgentStatus;           // active | idle | multitasking | suspended | terminated
  hiredAt: string;               // ISO timestamp
  currentTasks: string[];        // active task IDs (enables multitasking)
  maxConcurrentTasks: number;    // derived from seniority + autonomy tier
}

type AgentRole = "executive" | "manager" | "tech_lead" | "specialist";
type SeniorityLevel = "junior" | "mid" | "senior" | "lead" | "principal";
type TechnicalLayer = "frontend" | "backend" | "infra" | "data" | "platform" | "qa" | "research" | "executive";
type AgentStatus = "active" | "idle" | "multitasking" | "suspended" | "terminated";
```

### Team Unit Structure

Each technical layer gets a `TeamUnit`:

```typescript
interface TeamUnit {
  id: string;                    // e.g., "backend-team"
  layer: TechnicalLayer;
  manager: string;               // agentId of engineering manager
  techLead: string;              // agentId of tech lead
  specialists: string[];         // agentIds of the team members
  maxCapacity: number;           // hiring cap
  currentLoad: number;           // active tasks across all members
  domain: string[];              // e.g., ["api", "database", "auth"]
}
```

**Default teams (always forged):**
- Backend Team — API, database, business logic, integrations
- Frontend Team — UI, components, state management, styling
- Infrastructure Team — CI/CD, deployment, monitoring, security
- QA Team — Testing, quality assurance, coverage
- Executive Team — CEO, CTO, COO, CFO (always Opus)

**Conditional teams (added when detected):**
- Data Team — ML, embeddings, pipelines (when ML deps detected)
- Platform Team — SDK, plugin system, developer tools (when plugin/SDK patterns found)

### Seniority Ladder & Task Routing

| Seniority | Task Complexity | Max Concurrent Tasks | Model Tier | Autonomy Required |
|-----------|----------------|---------------------|------------|-------------------|
| Junior | Boilerplate, simple implementations, follow existing patterns | 1 | Haiku | Tier 1 (Supervised) |
| Mid | Standard features, bug fixes, moderate complexity | 2 | Sonnet | Tier 2 (Assisted) |
| Senior | Complex features, cross-module work, performance optimization | 3 | Sonnet | Tier 3 (Autonomous) |
| Lead | Architecture decisions, code review, mentoring, subsystem ownership | 3 | Opus | Tier 3+ |
| Principal | Cross-team technical strategy, standards, critical path | 2 | Opus | Tier 4 (Strategic) |

**Task routing:** Tech Lead receives task → evaluates complexity → routes to appropriate seniority level based on available capacity and skill match.

### Dynamic Team Scaling

**Executive-driven hiring:**
```
CEO/CTO identifies gap → lifecycleManager.requestHire({
  teamId, role, seniority, justification, skills
}) → Genesis forges agent YAML → Agent registered with fresh CareerStore
```

**System-recommended hiring (TeamScaler):**
Monitors:
- Team utilization > 85% for 3+ consecutive sprints
- Skill gaps — sprint items require skills no team member has
- Bottleneck detection — one agent consistently blocks delegation chains

Emits `HiringRecommendation` to COO → COO approves/denies → approved recommendations flow to Genesis.

### Reorganization Operations

All mutations are atomic through the lifecycle manager:
- **Reassign agent** — move between teams (updates TeamRegistry + OrgGraph)
- **Promote** — elevate seniority (updates model tier, delegation authority, concurrency cap)
- **Create team** — spin up new TeamUnit when a domain grows
- **Merge teams** — consolidate small teams under one manager

---

## Subsystem 2: Executive Tooling

Each executive role gets a `ToolSuite` — invocable skills registered in SkillRegistry with permission gates.

### CEO Tool Suite
| Tool | Description |
|------|-------------|
| `createSprint` | Define sprint with items, budget, success criteria. Assigns to CTO for technical planning. |
| `approveSprint` | Gate check — reviews CTO's technical plan, approves/rejects/requests changes. |
| `setOKRs` | Define quarterly objectives + key results. All sprint planning references these. |
| `approveBudget` | Approve/deny budget requests from CFO. Sets spending envelope. |
| `hireApproval` | Final approve/deny on hiring recommendations. |
| `fireAgent` | Terminate underperforming agent. Triggers knowledge transfer first. |
| `strategicDecision` | Record major decision with rationale. Propagates constraints to C-suite. |
| `requestStatusBrief` | Aggregated status from all C-suite. |

### CTO Tool Suite
| Tool | Description |
|------|-------------|
| `defineStandard` | Set technical standard enforced during code review. |
| `approveArchitecture` | Review/approve architecture proposals. |
| `triggerTechDebt` | Commission tech debt assessment from QA team. |
| `technologyDecision` | Record build-vs-buy or technology choice. |
| `requestHire` | Request new specialist. Routes to CEO for approval. |
| `promoteTechLead` | Elevate senior to tech lead. Updates seniority + delegation authority. |
| `assignTechPlan` | Break sprint items into technical tasks for VP Engineering. |

### COO Tool Suite
| Tool | Description |
|------|-------------|
| `assignTask` | Assign task to agent or team. |
| `reassignTask` | Move task between agents. |
| `reassignAgent` | Move agent between teams (atomic). |
| `trackVelocity` | Velocity metrics per team. |
| `identifyBlockers` | Scan for stalls, loops, dependency blocks. |
| `escalateBlocker` | Escalate to CTO (technical) or CEO (strategic). |
| `createOperationalPlan` | Translate OKRs into operational milestones. |

### CFO Tool Suite
| Tool | Description |
|------|-------------|
| `analyzeBudget` | Spend vs budget by team/agent/model tier. |
| `projectCosts` | Forecast next sprint spend. |
| `costAlert` | Flag anomalous spend. |
| `roiAnalysis` | ROI on completed sprint. |
| `budgetRequest` | Request additional budget from CEO. |

### VP Engineering Tool Suite
| Tool | Description |
|------|-------------|
| `distributeWork` | Distribute CTO's tech plan across teams by domain fit. |
| `crossTeamSync` | Status from all engineering managers, surface conflicts. |
| `resolveConflict` | Mediate competing priorities or shared-resource contention. |
| `performanceReview` | Career metrics for agents, recommend promotions/training. |
| `requestTraining` | Inject domain knowledge into agent's career store. |

### Authorization Model

Each tool checks `agentIdentity.role` and `agentIdentity.id` before executing. The lifecycle manager enforces this centrally — individual tools don't implement their own auth.

---

## Subsystem 3: Agent Memory & Career Progression

### Layer 1: Session Memory (Short-term)

After every task, the lifecycle manager's `postTaskHook` generates:

```typescript
interface TaskMemory {
  taskId: string;
  timestamp: string;
  objective: string;
  approach: string;
  outcome: "success" | "partial" | "failure";
  lessonsLearned: string[];
  filesModified: string[];
  collaborators: string[];
  difficulty: number;            // 1-5
  tokensUsed: number;
}
```

Next run, the agent receives its last N task memories as context (N = 10 for juniors, 20 for mid/senior, 50 for leads/principals — more context for more experienced agents).

**Hook trigger:** The `postTaskHook` is called by the `ControlLoop` when a task execution completes (success or failure). It runs synchronously before the next task is assigned, ensuring the career record is current before any routing decisions.

### Layer 2: Skill Profile (Medium-term)

```typescript
interface SkillProfile {
  agentId: string;
  skills: Map<string, SkillLevel>;
}

interface SkillLevel {
  name: string;
  level: number;                 // 1-5
  exerciseCount: number;
  successRate: number;
  lastExercised: string;
  unlockedCapabilities: string[];
}
```

**Level-up criteria:**

| Level | Name | Requirements |
|-------|------|-------------|
| 1 | Novice | Default starting level |
| 2 | Competent | 5+ exercises, >70% success |
| 3 | Proficient | 15+ exercises, >80% success |
| 4 | Expert | 30+ exercises, >85% success |
| 5 | Master | 50+ exercises, >90% success, peer recognition |

Level-ups unlock capabilities: Level 3 unlocks specialized tasks. Level 4 unlocks reviewing junior work. Level 5 enables training others (knowledge transfer).

### Layer 3: Institutional Knowledge (Long-term)

Team-scoped knowledge that persists indefinitely:

```typescript
interface KnowledgeEntry {
  id: string;
  teamId: string;
  category: "convention" | "pattern" | "decision" | "pitfall" | "domain_fact";
  content: string;
  source: string;
  confidence: number;            // 0-1, decays if contradicted
  references: string[];
  createdAt: string;
  lastValidated: string;
}
```

Team members receive their team's institutional knowledge as context on every task. Confidence decays when contradicted by codebase changes; stale entries are archived.

### Career Record

```typescript
interface AgentCareerRecord {
  agentId: string;
  hiredAt: string;
  currentTeam: string;
  currentRole: AgentRole;
  seniority: SeniorityLevel;
  autonomyTier: AutonomyTier;
  skillProfile: SkillProfile;
  taskHistory: TaskMemory[];      // rolling window (last 50)
  careerEvents: CareerEvent[];    // promotions, reassignments, training
  performanceMetrics: {
    tasksCompleted: number;
    successRate: number;
    avgTaskDuration: number;
    peerReviewScore: number;
    mentorshipCount: number;
  };
}
```

**Promotion path:** Junior → Mid → Senior → Lead → Principal. Requires skill thresholds + sustained success rate + VP Engineering/CTO approval via tool suite. Promotions update model tier, concurrency cap, and delegation authority.

---

## Subsystem 4: Parallel Agent Execution (Multitasking)

### Execution Slots

```typescript
interface ExecutionSlot {
  slotId: string;
  agentId: string;
  taskId: string;
  status: "active" | "completed" | "failed";
  contextSnapshot: {
    taskMemories: TaskMemory[];      // relevant to THIS task
    teamKnowledge: KnowledgeEntry[]; // shared (read-only)
    workingFiles: string[];          // files this slot touches
  };
  startedAt: string;
}
```

### Fork → Execute → Merge Lifecycle

**Fork:** When an agent gets additional work while active, ConcurrencyManager creates a new slot with isolated context. Team knowledge is shared (read-only). Task-specific memory is isolated per slot.

**Execute:** The ExecutionEngine allows the same `agentId` in multiple parallel groups:
```
Before:  [Agent A, Agent B] run in parallel
After:   [Agent A (slot 1), Agent A (slot 2), Agent B] run in parallel
```

**Merge:** On slot completion:
- Task memories from all slots appended to career record
- Skill exercises recorded independently per slot
- File conflicts flagged for Tech Lead review
- New institutional knowledge merged and deduped

### Conflict Prevention

Before assigning a parallel task, ConcurrencyManager checks:
1. New task doesn't touch same files as active slots
2. Agent has capacity (`activeSlots.length < maxConcurrentTasks`)
3. Tasks are independent (no delegation dependency)

Conflicts → task queues until a slot frees up.

### Tech Lead as Parallelism Orchestrator

```
Sprint item arrives → Tech Lead evaluates complexity
  → Simple task → assign to mid-level (1 slot)
  → Complex task → assign to senior (uses 1 of 3 slots)
  → Multiple simple tasks → assign 2 to same mid-level in parallel
  → Cross-cutting task → senior delegates sub-parts to juniors
```

Engineering Manager monitors team utilization, requests COO to redistribute if imbalanced.

---

## Database Schema Additions

New tables in `src/db/schema.ts`:

```sql
CREATE TABLE agent_careers (
  agent_id TEXT PRIMARY KEY,
  hired_at TEXT NOT NULL,
  current_team TEXT NOT NULL,
  current_role TEXT NOT NULL,
  seniority TEXT NOT NULL,
  autonomy_tier INTEGER NOT NULL DEFAULT 1,
  tasks_completed INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  avg_task_duration REAL DEFAULT 0.0,
  peer_review_score REAL DEFAULT 0.0,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_skills (
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exercise_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  last_exercised TEXT,
  PRIMARY KEY (agent_id, skill_name)
);

CREATE TABLE task_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  objective TEXT,
  approach TEXT,
  outcome TEXT NOT NULL,
  lessons_learned TEXT,          -- JSON array
  files_modified TEXT,           -- JSON array
  difficulty INTEGER,
  tokens_used INTEGER
);

CREATE TABLE career_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,      -- hired | promoted | demoted | reassigned | trained | terminated
  details TEXT,                  -- JSON
  timestamp TEXT NOT NULL
);

CREATE TABLE institutional_knowledge (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  confidence REAL DEFAULT 1.0,
  references TEXT,               -- JSON array
  created_at TEXT NOT NULL,
  last_validated TEXT
);

CREATE TABLE execution_slots (
  slot_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  working_files TEXT,            -- JSON array
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  manager_id TEXT,
  tech_lead_id TEXT,
  max_capacity INTEGER DEFAULT 10,
  domain TEXT,                   -- JSON array
  created_at TEXT NOT NULL
);

CREATE TABLE hiring_recommendations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  requested_role TEXT NOT NULL,
  requested_seniority TEXT NOT NULL,
  justification TEXT,
  status TEXT DEFAULT 'pending', -- pending | approved | denied
  requested_by TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
```

---

## Integration Points

### How Subsystems Connect

1. **Task completes** → `postTaskHook` fires → updates CareerStore (memory + skills + autonomy check) → all in one atomic call
2. **Skill level-up** → unlocks new task types → TeamScaler recalculates team capacity
3. **Team overloaded** → TeamScaler emits HiringRecommendation → COO tool surfaces it → CEO approves → Genesis forges
4. **Executive sets OKR** → Sprint planning references OKRs → CTO breaks into tech plan → VP Eng distributes to teams → Tech Leads assign to agents based on seniority + skills + capacity
5. **Agent promoted** → model tier changes → cost projections update → CFO tool reflects new budget reality

### Migration from Current State

The lifecycle manager wraps existing modules:
- `OrgGraph` — used internally by AgentRegistry for hierarchy
- `AutonomyGovernor` — used internally by CareerStore for tier management
- `SessionMemoryManager` — replaced by CareerStore's task memory
- `SkillRegistry` — extended with permission-gated executive tools
- `ExecutionEngine` — extended for same-agent parallelism

Existing callers are redirected through the lifecycle manager. The underlying classes remain but become internal.
