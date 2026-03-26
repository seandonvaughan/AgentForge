---

# AgentForge v4 Architecture Document

**Version:** 4.0.0-DRAFT  
**Author:** Lead Architect Agent  
**Date:** 2026-03-25  
**Status:** Greenfield Design

---

## 1. Executive Summary

AgentForge v4 transforms the CLI-first agent orchestration system into a **full-stack platform** with three interconnected pillars:

1. **Web Dashboard** — A real-time web interface for monitoring, directing, and reporting on agent team activity
2. **Agent Memory + Session Persistence** — Per-agent persistent memory with intelligent suspend/resume semantics
3. **Agent Tools** — Shared and specialized tool provisioning modeled after organizational tool allocation

### Key Outcomes

| Metric | v0.3.2 Baseline | v4 Target |
|--------|-----------------|-----------|
| Primary UI | CLI-only | Web + CLI |
| Agent memory retention | Session-scoped | Cross-session persistent |
| Tool assignment | Implicit (all tools) | Explicit (shared + specialized) |
| Session resume capability | Manual hibernate | Intelligent suspend/await |
| Observability | FeedRenderer (text) | Real-time dashboard + charts |

### Architecture Principles

1. **Composition over modification** — Existing v3 components (OrchestratorV3, MessageBus, KnowledgeStore) are wrapped, not rewritten
2. **Zero external dependencies for core** — Dashboard uses minimal vendored deps; core remains npm-lean
3. **Backward compatibility** — CLI remains fully functional; dashboard is additive
4. **Cost transparency** — All pillars feed into unified cost accounting

---

## 2. Technical Architecture

### 2.1 High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AgentForge v4                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐        │
│  │   WEB DASHBOARD  │   │  AGENT MEMORY    │   │   AGENT TOOLS    │        │
│  │     (Pillar 1)   │   │   (Pillar 2)     │   │    (Pillar 3)    │        │
│  │                  │   │                  │   │                  │        │
│  │  React SPA       │   │  MemoryStore     │   │  ToolRegistry    │        │
│  │  WebSocket API   │   │  SuspendManager  │   │  ToolProvisioner │        │
│  │  REST API        │   │  ResumeScheduler │   │  MCPConnector    │        │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘        │
│           │                      │                      │                  │
│           └──────────────────────┼──────────────────────┘                  │
│                                  │                                         │
│                    ┌─────────────▼─────────────┐                           │
│                    │    INTEGRATION LAYER      │                           │
│                    │    (DashboardBridge)      │                           │
│                    └─────────────┬─────────────┘                           │
│                                  │                                         │
│  ┌───────────────────────────────▼───────────────────────────────────┐     │
│  │                    EXISTING v3 CORE                                │     │
│  │  ┌─────────────┐ ┌──────────────┐ ┌────────────┐ ┌─────────────┐  │     │
│  │  │AgentForge   │ │ TeamModeBus  │ │ Knowledge  │ │ DecisionLog │  │     │
│  │  │Session      │ │              │ │ Store      │ │             │  │     │
│  │  └─────────────┘ └──────────────┘ └────────────┘ └─────────────┘  │     │
│  │  ┌─────────────┐ ┌──────────────┐ ┌────────────┐ ┌─────────────┐  │     │
│  │  │Orchestrator │ │ CostTracker  │ │ Session    │ │ FeedRenderer│  │     │
│  │  │V3           │ │              │ │ Serializer │ │             │  │     │
│  │  └─────────────┘ └──────────────┘ └────────────┘ └─────────────┘  │     │
│  └───────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐     │
│  │                    PERSISTENCE LAYER                               │     │
│  │  .agentforge/                                                      │     │
│  │  ├── agents/           (YAML definitions)                         │     │
│  │  ├── sessions/         (hibernated sessions)                      │     │
│  │  ├── knowledge/        (project + entity scopes)                  │     │
│  │  ├── memory/           (NEW: per-agent persistent memory)         │     │
│  │  ├── tools/            (NEW: tool manifests + configs)            │     │
│  │  └── dashboard/        (NEW: dashboard state + exports)           │     │
│  └───────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 PILLAR 1: Web Dashboard

#### 2.2.1 Purpose

Replace plain-text FeedRenderer output with a rich, real-time web interface showing:

- Live agent conversation threads
- Message flow visualization
- Cost dashboards with drill-down
- Session timelines
- Team roster with status indicators
- Exportable reports

#### 2.2.2 Component Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        DASHBOARD FRONTEND                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │ ConvoPanel │ │ CostChart  │ │ TeamRoster │ │ Timeline   │      │
│  │            │ │            │ │            │ │            │      │
│  └──────┬─────┘ └──────┬─────┘ └──────┬─────┘ └──────┬─────┘      │
│         │              │              │              │             │
│         └──────────────┴──────────────┴──────────────┘             │
│                              │                                     │
│                    ┌─────────▼─────────┐                           │
│                    │   DashboardStore  │  (Zustand/Jotai)          │
│                    └─────────┬─────────┘                           │
│                              │                                     │
├──────────────────────────────┼─────────────────────────────────────┤
│                              │ WebSocket + REST                    │
├──────────────────────────────┼─────────────────────────────────────┤
│                        DASHBOARD SERVER                            │
│                    ┌─────────▼─────────┐                           │
│                    │   DashboardServer │                           │
│                    └─────────┬─────────┘                           │
│         ┌────────────────────┼────────────────────┐                │
│         │                    │                    │                │
│  ┌──────▼──────┐ ┌───────────▼──────┐ ┌──────────▼───────┐        │
│  │ WSBroadcast │ │ RESTController   │ │ ReportGenerator  │        │
│  │ Manager     │ │                  │ │                  │        │
│  └─────────────┘ └──────────────────┘ └──────────────────┘        │
└────────────────────────────────────────────────────────────────────┘
```

#### 2.2.3 Data Models

```typescript
// src/dashboard/types.ts

/** Real-time event pushed to dashboard clients */
interface DashboardEvent {
  type: 'message' | 'cost' | 'agent_status' | 'session_state' | 'milestone';
  timestamp: string;
  payload: unknown;
}

/** Conversation thread visible in ConvoPanel */
interface ConversationThread {
  threadId: string;
  participants: string[];          // agent addresses
  messages: DashboardMessage[];
  startedAt: string;
  lastActivityAt: string;
  status: 'active' | 'awaiting' | 'complete';
}

/** Enhanced message for dashboard display */
interface DashboardMessage {
  id: string;
  from: string;
  to: string;
  type: TeamModeMessageType;
  content: string;
  contentPreview: string;          // truncated for list view
  renderedContent?: string;        // markdown -> HTML
  priority: MessagePriority;
  timestamp: string;
  costUsd?: number;
  modelUsed?: ModelTier;
  duration?: number;               // ms
  attachments?: MessageAttachment[];
}

/** Agent status for roster display */
interface AgentDashboardStatus {
  address: string;
  name: string;
  model: ModelTier;
  state: 'idle' | 'working' | 'awaiting' | 'suspended';
  currentTask?: string;
  totalCostThisSession: number;
  invocationCount: number;
  lastActiveAt?: string;
}

/** Cost breakdown for charts */
interface CostSnapshot {
  timestamp: string;
  totalUsd: number;
  byModel: Record<ModelTier, number>;
  byAgent: Record<string, number>;
  budgetRemainingUsd: number;
}

/** Timeline event for session replay */
interface TimelineEvent {
  timestamp: string;
  type: 'task_start' | 'task_complete' | 'escalation' | 'cost_milestone' | 
        'agent_suspend' | 'agent_resume' | 'session_state_change';
  actor: string;
  summary: string;
  details?: Record<string, unknown>;
}
```

#### 2.2.4 API Design

**WebSocket Protocol (ws://localhost:3847/ws)**

```typescript
// Client -> Server
type ClientMessage = 
  | { type: 'subscribe'; channels: ('messages' | 'costs' | 'status')[] }
  | { type: 'send_task'; to: string; content: string }
  | { type: 'request_history'; threadId?: string; limit?: number }

// Server -> Client  
type ServerMessage =
  | { type: 'event'; event: DashboardEvent }
  | { type: 'history'; messages: DashboardMessage[] }
  | { type: 'snapshot'; state: DashboardSnapshot }
  | { type: 'error'; code: string; message: string }
```

**REST API (http://localhost:3847/api)**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List all sessions (active + hibernated) |
| `/api/sessions/:id` | GET | Get session details |
| `/api/sessions/:id/messages` | GET | Paginated message history |
| `/api/sessions/:id/costs` | GET | Cost breakdown |
| `/api/agents` | GET | List all registered agents |
| `/api/agents/:name/status` | GET | Agent current status |
| `/api/agents/:name/memory` | GET | Agent memory entries (Pillar 2) |
| `/api/tools` | GET | List all tools (Pillar 3) |
| `/api/reports/export` | POST | Generate exportable report |
| `/api/commands` | POST | Send command to active session |

#### 2.2.5 Key Components

```typescript
// src/dashboard/server/DashboardServer.ts
export class DashboardServer {
  constructor(
    port: number,
    sessionBridge: DashboardBridge,
  );
  
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Called by DashboardBridge when events occur
  broadcast(event: DashboardEvent): void;
}

// src/dashboard/server/DashboardBridge.ts
export class DashboardBridge {
  constructor(
    session: AgentForgeSession,
    server: DashboardServer,
  );
  
  // Hooks into existing event streams
  attachToSession(): void;
  detachFromSession(): void;
  
  // Translates v3 events to dashboard events
  private handleTeamModeMessage(msg: TeamModeMessage): void;
  private handleCostUpdate(cost: CostSnapshot): void;
  private handleAgentStatusChange(status: AgentDashboardStatus): void;
}

// src/dashboard/server/ReportGenerator.ts
export class ReportGenerator {
  generateSessionReport(sessionId: string, format: 'pdf' | 'html' | 'json'): Promise<Buffer>;
  generateCostReport(range: DateRange): Promise<CostReport>;
  generateAgentPerformanceReport(agentName: string): Promise<AgentReport>;
}
```

#### 2.2.6 Frontend Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React 18 | Ecosystem, developer familiarity |
| Build | Vite | Fast, modern, zero-config |
| State | Zustand | Minimal, no boilerplate |
| Styling | Tailwind CSS | Rapid iteration, consistent design |
| Charts | Recharts | React-native, composable |
| WebSocket | Native | No additional deps |
| Icons | Lucide | Tree-shakeable, consistent |

**Directory Structure:**

```
src/dashboard/
├── client/
│   ├── App.tsx
│   ├── main.tsx
│   ├── store/
│   │   ├── dashboardStore.ts
│   │   └── websocketStore.ts
│   ├── components/
│   │   ├── ConvoPanel/
│   │   ├── CostChart/
│   │   ├── TeamRoster/
│   │   ├── Timeline/
│   │   └── common/
│   ├── hooks/
│   └── utils/
├── server/
│   ├── DashboardServer.ts
│   ├── DashboardBridge.ts
│   ├── RESTController.ts
│   ├── WSBroadcastManager.ts
│   └── ReportGenerator.ts
└── types.ts
```

---

### 2.3 PILLAR 2: Agent Memory + Session Persistence

#### 2.3.1 Purpose

Enable agents to:

1. **Accumulate knowledge** across sessions (learnings, research results, mistakes to avoid)
2. **Suspend** when awaiting another agent's output
3. **Resume** intelligently when dependencies resolve
4. **Persist vs. close** with clear heuristics

#### 2.3.2 Memory Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      AGENT MEMORY SYSTEM                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    MemoryManager                             │   │
│  │  (orchestrates all memory operations)                        │   │
│  └───────────────────────────┬─────────────────────────────────┘   │
│                              │                                     │
│     ┌────────────────────────┼────────────────────────┐            │
│     │                        │                        │            │
│     ▼                        ▼                        ▼            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│  │ AgentMemory  │   │ Suspend      │   │ ResumeScheduler      │   │
│  │ Store        │   │ Manager      │   │                      │   │
│  │              │   │              │   │ ┌──────────────────┐ │   │
│  │ ┌──────────┐ │   │ ┌──────────┐ │   │ │ DependencyGraph  │ │   │
│  │ │Learnings │ │   │ │Suspended │ │   │ └──────────────────┘ │   │
│  │ └──────────┘ │   │ │Tasks     │ │   │ ┌──────────────────┐ │   │
│  │ ┌──────────┐ │   │ └──────────┘ │   │ │ WakeConditions   │ │   │
│  │ │Research  │ │   │ ┌──────────┐ │   │ └──────────────────┘ │   │
│  │ └──────────┘ │   │ │Checkpts  │ │   └──────────────────────┘   │
│  │ ┌──────────┐ │   │ └──────────┘ │                               │
│  │ │Mistakes  │ │   └──────────────┘                               │
│  │ └──────────┘ │                                                  │
│  └──────────────┘                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 2.3.3 Data Models

```typescript
// src/memory/types.ts

/** Categories of agent memory */
type MemoryCategory = 
  | 'learning'      // insights, patterns discovered
  | 'research'      // external findings, documentation
  | 'mistake'       // errors to avoid, failed approaches
  | 'preference'    // agent's calibrated preferences
  | 'relationship'  // notes about other agents
  | 'context';      // project-specific context

/** A single memory entry */
interface AgentMemoryEntry {
  id: string;
  agentName: string;
  category: MemoryCategory;
  content: string;
  source: MemorySource;           // how this memory was created
  confidence: number;             // 0-1, decays over time
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  tags: string[];
  expiresAt?: string;             // optional TTL
  supersedes?: string;            // id of entry this replaces
}

/** How a memory was created */
interface MemorySource {
  type: 'explicit' | 'inferred' | 'delegated' | 'reforge';
  sessionId: string;
  taskContext?: string;
}

/** A suspended task awaiting resumption */
interface SuspendedTask {
  id: string;
  agentName: string;
  originalTask: string;
  suspendedAt: string;
  checkpoint: TaskCheckpoint;
  wakeConditions: WakeCondition[];
  priority: MessagePriority;
  maxWaitMs?: number;             // timeout after which task escalates
}

/** State snapshot when task was suspended */
interface TaskCheckpoint {
  progressSummary: string;
  completedSteps: string[];
  remainingSteps: string[];
  intermediateResults: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
}

/** Condition that triggers task resumption */
interface WakeCondition {
  type: 'agent_complete' | 'message_received' | 'time_elapsed' | 'manual';
  params: Record<string, unknown>;
  satisfied: boolean;
  satisfiedAt?: string;
}

/** Persistence vs close decision */
interface PersistenceDecision {
  action: 'persist' | 'close' | 'suspend';
  reason: PersistenceReason;
  confidence: number;
}

type PersistenceReason =
  | 'task_complete'           // -> close
  | 'awaiting_dependency'     // -> suspend
  | 'valuable_state'          // -> persist (learnings acquired)
  | 'timeout'                 // -> close with escalation
  | 'error'                   // -> persist (for debugging)
  | 'budget_exhausted'        // -> close with summary
  | 'user_requested';         // -> depends on request
```

#### 2.3.4 Persistence Heuristics

The **PersistenceDecider** applies these rules to determine agent fate:

```typescript
// src/memory/PersistenceDecider.ts

interface PersistenceContext {
  taskStatus: 'complete' | 'partial' | 'blocked' | 'error';
  hasUnresolvedDependencies: boolean;
  memoryEntriesCreated: number;
  estimatedResumeValue: number;   // 0-1
  budgetRemaining: number;
  timeSinceLastActivity: number;
}

const PERSISTENCE_RULES: PersistenceRule[] = [
  // Rule 1: Complete tasks close
  {
    condition: (ctx) => ctx.taskStatus === 'complete',
    decision: { action: 'close', reason: 'task_complete' },
    priority: 100,
  },
  
  // Rule 2: Blocked on dependency -> suspend with wake conditions
  {
    condition: (ctx) => 
      ctx.hasUnresolvedDependencies && ctx.estimatedResumeValue > 0.5,
    decision: { action: 'suspend', reason: 'awaiting_dependency' },
    priority: 90,
  },
  
  // Rule 3: Created valuable memories -> persist
  {
    condition: (ctx) => 
      ctx.memoryEntriesCreated > 2 && ctx.taskStatus === 'partial',
    decision: { action: 'persist', reason: 'valuable_state' },
    priority: 80,
  },
  
  // Rule 4: Budget exhausted -> close with summary
  {
    condition: (ctx) => ctx.budgetRemaining <= 0,
    decision: { action: 'close', reason: 'budget_exhausted' },
    priority: 70,
  },
  
  // Rule 5: Stale (no activity 30min+) -> close
  {
    condition: (ctx) => ctx.timeSinceLastActivity > 30 * 60 * 1000,
    decision: { action: 'close', reason: 'timeout' },
    priority: 60,
  },
  
  // Rule 6: Error state -> persist for debugging
  {
    condition: (ctx) => ctx.taskStatus === 'error',
    decision: { action: 'persist', reason: 'error' },
    priority: 50,
  },
  
  // Default: close
  {
    condition: () => true,
    decision: { action: 'close', reason: 'task_complete' },
    priority: 0,
  },
];
```

#### 2.3.5 Key Components

```typescript
// src/memory/AgentMemoryStore.ts
export class AgentMemoryStore {
  constructor(projectRoot: string);
  
  // CRUD operations
  async addMemory(entry: Omit<AgentMemoryEntry, 'id' | 'createdAt'>): Promise<string>;
  async getMemory(id: string): Promise<AgentMemoryEntry | null>;
  async queryMemories(agentName: string, filter?: MemoryFilter): Promise<AgentMemoryEntry[]>;
  async updateMemory(id: string, updates: Partial<AgentMemoryEntry>): Promise<void>;
  async deleteMemory(id: string): Promise<void>;
  
  // Memory retrieval for agent context
  async getRelevantMemories(agentName: string, task: string, limit?: number): Promise<AgentMemoryEntry[]>;
  
  // Memory decay
  async applyDecay(): Promise<number>; // returns count of expired entries
}

// src/memory/SuspendManager.ts
export class SuspendManager {
  constructor(
    memoryStore: AgentMemoryStore,
    messageBus: MessageBus,
  );
  
  async suspendTask(task: SuspendedTask): Promise<string>;
  async getSuspendedTasks(agentName?: string): Promise<SuspendedTask[]>;
  async checkWakeConditions(): Promise<SuspendedTask[]>; // returns tasks ready to resume
  async resumeTask(taskId: string): Promise<void>;
  async cancelSuspendedTask(taskId: string, reason: string): Promise<void>;
}

// src/memory/ResumeScheduler.ts
export class ResumeScheduler {
  constructor(
    suspendManager: SuspendManager,
    orchestrator: OrchestratorV3,
  );
  
  // Called on session start to check for resumable tasks
  async scanAndResume(): Promise<number>; // returns count of resumed tasks
  
  // Register wake condition listeners
  registerWakeListener(condition: WakeCondition, callback: () => void): void;
  
  // Build dependency graph for optimal resume ordering
  buildDependencyGraph(): DependencyGraph;
}

// src/memory/PersistenceDecider.ts
export class PersistenceDecider {
  decide(context: PersistenceContext): PersistenceDecision;
  
  // Hook into agent lifecycle
  onAgentTaskComplete(agentName: string, result: V3RunResult): PersistenceDecision;
  onAgentError(agentName: string, error: Error): PersistenceDecision;
  onSessionEnd(): Map<string, PersistenceDecision>;
}

// src/memory/MemoryManager.ts (facade)
export class MemoryManager {
  readonly store: AgentMemoryStore;
  readonly suspendManager: SuspendManager;
  readonly resumeScheduler: ResumeScheduler;
  readonly persistenceDecider: PersistenceDecider;
  
  static async create(projectRoot: string, session: AgentForgeSession): Promise<MemoryManager>;
  
  // High-level operations
  async injectMemoriesIntoPrompt(agentName: string, task: string): Promise<string>;
  async extractAndStoreMemories(agentName: string, output: string): Promise<number>;
  async handleAgentComplete(agentName: string, result: V3RunResult): Promise<void>;
}
```

#### 2.3.6 File Structure

```
.agentforge/memory/
├── agents/
│   ├── cto/
│   │   ├── learnings.json
│   │   ├── research.json
│   │   ├── mistakes.json
│   │   └── preferences.json
│   ├── architect/
│   │   └── ...
│   └── .../
├── suspended/
│   ├── task-{id}.json
│   └── .../
└── index.json               # memory index for fast queries
```

---

### 2.4 PILLAR 3: Agent Tools

#### 2.4.1 Purpose

Model tool allocation like a company:

- **Shared tools** — All agents have access (Git, file system, common MCP servers)
- **Specialized tools** — Role-specific tools assigned per agent

#### 2.4.2 Tool Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      AGENT TOOLS SYSTEM                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    ToolOrchestrator                          │   │
│  │  (central coordination of all tool operations)               │   │
│  └───────────────────────────┬─────────────────────────────────┘   │
│                              │                                     │
│     ┌────────────────────────┼────────────────────────┐            │
│     │                        │                        │            │
│     ▼                        ▼                        ▼            │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐   │
│  │ ToolRegistry │   │ Tool         │   │ MCPConnector         │   │
│  │              │   │ Provisioner  │   │                      │   │
│  │ ┌──────────┐ │   │              │   │ ┌──────────────────┐ │   │
│  │ │SharedPool│ │   │ ┌──────────┐ │   │ │ ServerManager    │ │   │
│  │ └──────────┘ │   │ │AgentTool │ │   │ └──────────────────┘ │   │
│  │ ┌──────────┐ │   │ │Resolver  │ │   │ ┌──────────────────┐ │   │
│  │ │Specialized│ │   │ └──────────┘ │   │ │ ToolAdapter      │ │   │
│  │ │ByRole    │ │   │ ┌──────────┐ │   │ └──────────────────┘ │   │
│  │ └──────────┘ │   │ │Capability│ │   └──────────────────────┘   │
│  │ ┌──────────┐ │   │ │Validator │ │                               │
│  │ │Manifests │ │   │ └──────────┘ │                               │
│  │ └──────────┘ │   └──────────────┘                               │
│  └──────────────┘                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 2.4.3 Data Models

```typescript
// src/tools/types.ts

/** Tool categories */
type ToolCategory = 
  | 'filesystem'    // read, write, glob
  | 'vcs'           // git operations
  | 'build'         // npm, make, etc.
  | 'test'          // test runners
  | 'deploy'        // deployment tools
  | 'integration'   // external services
  | 'mcp'           // MCP servers
  | 'custom';       // user-defined

/** A registered tool */
interface ToolDefinition {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  scope: 'shared' | 'specialized';
  
  // For specialized tools
  assignedTo?: string[];          // agent names
  
  // Invocation
  type: 'builtin' | 'script' | 'mcp' | 'skill' | 'plugin';
  config: ToolConfig;
  
  // Constraints
  permissions?: ToolPermission[];
  costPerInvocation?: number;     // estimated USD
  rateLimit?: { calls: number; perSeconds: number };
}

/** Tool configuration varies by type */
type ToolConfig = 
  | { type: 'builtin'; name: string }
  | { type: 'script'; command: string; args?: string[]; cwd?: string }
  | { type: 'mcp'; serverKey: string; toolName: string }
  | { type: 'skill'; skillId: string }
  | { type: 'plugin'; pluginId: string; commandId: string };

/** Permission scopes for tools */
interface ToolPermission {
  resource: string;               // glob pattern or resource name
  actions: ('read' | 'write' | 'execute' | 'delete')[];
}

/** Tool allocation for an agent */
interface AgentToolAllocation {
  agentName: string;
  sharedTools: string[];          // tool IDs from shared pool
  specializedTools: string[];     // tool IDs assigned to this agent
  deniedTools: string[];          // explicitly blocked tools
  effectiveTools: ToolDefinition[]; // computed: shared + specialized - denied
}

/** Tool manifest (persisted) */
interface ToolManifest {
  version: string;
  sharedTools: ToolDefinition[];
  specializations: Record<string, string[]>; // agentName -> toolIds
  mcpServers: McpServerConfig[];
}
```

#### 2.4.4 Default Tool Assignments

```yaml
# .agentforge/tools/manifest.yaml

version: "1.0"

shared_tools:
  - id: "fs:read"
    name: "Read File"
    category: "filesystem"
    type: "builtin"
    
  - id: "fs:write"
    name: "Write File"
    category: "filesystem"
    type: "builtin"
    
  - id: "fs:glob"
    name: "Glob Search"
    category: "filesystem"
    type: "builtin"
    
  - id: "vcs:git"
    name: "Git Operations"
    category: "vcs"
    type: "builtin"
    
  - id: "search:grep"
    name: "Grep Search"
    category: "filesystem"
    type: "builtin"

specializations:
  # Strategic agents get external integration tools
  cto:
    - "mcp:github"
    - "mcp:slack"
    - "mcp:atlassian"
    
  cfo:
    - "mcp:sheets"
    - "script:cost-analyzer"
    
  # Implementation agents get build/test tools
  coder:
    - "build:npm"
    - "build:tsc"
    - "test:vitest"
    - "lint:eslint"
    
  architect:
    - "mcp:github"
    - "script:dependency-graph"
    
  # QA agents get testing tools
  end-to-end-tester:
    - "test:vitest"
    - "test:playwright"
    - "mcp:browser"
    
  security-vulnerability-tester:
    - "script:npm-audit"
    - "script:snyk"
    - "mcp:github"  # for security advisories
```

#### 2.4.5 Key Components

```typescript
// src/tools/ToolRegistry.ts
export class ToolRegistry {
  constructor(projectRoot: string);
  
  async loadManifest(): Promise<ToolManifest>;
  async saveManifest(manifest: ToolManifest): Promise<void>;
  
  // Tool registration
  registerTool(tool: ToolDefinition): void;
  unregisterTool(toolId: string): void;
  
  // Queries
  getSharedTools(): ToolDefinition[];
  getSpecializedTools(agentName: string): ToolDefinition[];
  getToolById(toolId: string): ToolDefinition | null;
  getAllTools(): ToolDefinition[];
}

// src/tools/ToolProvisioner.ts
export class ToolProvisioner {
  constructor(
    registry: ToolRegistry,
    mcpConnector: MCPConnector,
  );
  
  // Compute effective tools for an agent
  resolveToolsForAgent(agentName: string): AgentToolAllocation;
  
  // Validate agent can use a tool
  canAgentUseTool(agentName: string, toolId: string): boolean;
  
  // Provision tools into agent context
  provisionForAgent(agentName: string): ProvisionedToolSet;
}

// src/tools/MCPConnector.ts
export class MCPConnector {
  constructor(projectRoot: string);
  
  // Server lifecycle
  async startServer(serverKey: string): Promise<void>;
  async stopServer(serverKey: string): Promise<void>;
  async restartServer(serverKey: string): Promise<void>;
  
  // Tool discovery
  async discoverTools(serverKey: string): Promise<ToolDefinition[]>;
  
  // Tool invocation
  async invokeTool(serverKey: string, toolName: string, params: unknown): Promise<unknown>;
  
  // Health
  getServerStatus(serverKey: string): 'running' | 'stopped' | 'error';
}

// src/tools/ToolOrchestrator.ts (facade)
export class ToolOrchestrator {
  readonly registry: ToolRegistry;
  readonly provisioner: ToolProvisioner;
  readonly mcpConnector: MCPConnector;
  
  static async create(projectRoot: string): Promise<ToolOrchestrator>;
  
  // High-level operations
  async getToolsForAgent(agentName: string): Promise<ProvisionedToolSet>;
  async invokeToolForAgent(
    agentName: string, 
    toolId: string, 
    params: unknown
  ): Promise<ToolInvocationResult>;
  
  // Tool management CLI
  async addSharedTool(tool: ToolDefinition): Promise<void>;
  async assignToolToAgent(toolId: string, agentName: string): Promise<void>;
  async revokeToolFromAgent(toolId: string, agentName: string): Promise<void>;
}
```

#### 2.4.6 File Structure

```
.agentforge/tools/
├── manifest.yaml            # tool definitions and assignments
├── scripts/
│   ├── cost-analyzer.sh
│   ├── dependency-graph.sh
│   └── npm-audit.sh
├── mcp/
│   └── config.json          # generated MCP config (existing)
└── plugins/
    └── custom-plugin/
        └── ...
```

---

## 3. Integration Points Between Pillars

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      PILLAR INTEGRATION MAP                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                         ┌─────────────┐                                │
│                         │  Dashboard  │                                │
│                         │  (Pillar 1) │                                │
│                         └──────┬──────┘                                │
│                                │                                       │
│              ┌─────────────────┼─────────────────┐                    │
│              │                 │                 │                    │
│              ▼                 ▼                 ▼                    │
│    ┌───────────────┐ ┌───────────────┐ ┌───────────────┐             │
│    │ Memory View   │ │ Tool Usage    │ │ Session       │             │
│    │ UI Component  │ │ UI Component  │ │ Control       │             │
│    └───────┬───────┘ └───────┬───────┘ └───────┬───────┘             │
│            │                 │                 │                       │
│            │     ┌───────────┴───────────┐     │                       │
│            │     │                       │     │                       │
│            ▼     ▼                       ▼     ▼                       │
│    ┌─────────────────┐             ┌─────────────────┐                │
│    │     Memory      │◄───────────►│      Tools      │                │
│    │   (Pillar 2)    │             │   (Pillar 3)    │                │
│    └────────┬────────┘             └────────┬────────┘                │
│             │                               │                          │
│             │  ┌───────────────────────────┐│                          │
│             │  │                           ││                          │
│             └──┤  Tool invocations create  ├┘                          │
│                │  memories; memories       │                           │
│                │  inform tool selection    │                           │
│                └───────────────────────────┘                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Dashboard ↔ Memory Integration

| Integration Point | Direction | Description |
|------------------|-----------|-------------|
| Memory Browser | Dashboard → Memory | View/search agent memories in UI |
| Memory Timeline | Memory → Dashboard | Memory creation events on timeline |
| Suspend/Resume UI | Dashboard ↔ Memory | Visual control over suspended tasks |
| Memory Injection | Memory → Dashboard | Show injected memories in message context |

**Key API:**

```typescript
// REST endpoints
GET  /api/agents/:name/memory?category=&limit=
POST /api/agents/:name/memory/search { query: string }
GET  /api/suspended-tasks
POST /api/suspended-tasks/:id/resume
POST /api/suspended-tasks/:id/cancel
```

### 3.2 Dashboard ↔ Tools Integration

| Integration Point | Direction | Description |
|------------------|-----------|-------------|
| Tool Inventory | Tools → Dashboard | Display available tools per agent |
| Tool Usage Stats | Tools → Dashboard | Chart tool invocations and costs |
| Tool Assignment | Dashboard → Tools | UI for assigning/revoking tools |
| MCP Server Status | Tools → Dashboard | Real-time MCP server health |

**Key API:**

```typescript
// REST endpoints
GET  /api/tools
GET  /api/tools/:id
GET  /api/agents/:name/tools
POST /api/agents/:name/tools/:toolId/assign
DELETE /api/agents/:name/tools/:toolId/revoke
GET  /api/mcp-servers
POST /api/mcp-servers/:key/restart
```

### 3.3 Memory ↔ Tools Integration

| Integration Point | Direction | Description |
|------------------|-----------|-------------|
| Tool Usage Memories | Tools → Memory | Record tool invocations as memories |
| Tool Preference Learning | Memory → Tools | Use past tool success to inform selection |
| Suspended Tool State | Memory + Tools | Persist tool state when suspending |

**Implementation:**

```typescript
// In ToolOrchestrator
async invokeToolForAgent(agentName: string, toolId: string, params: unknown): Promise<ToolInvocationResult> {
  const result = await this.executeToolInternal(toolId, params);
  
  // Record tool invocation as memory
  await this.memoryManager.store.addMemory({
    agentName,
    category: 'learning',
    content: `Used tool ${toolId}: ${result.success ? 'succeeded' : 'failed'}. ${result.summary}`,
    source: { type: 'inferred', sessionId: this.sessionId },
    confidence: 0.7,
    tags: ['tool-usage', toolId],
  });
  
  return result;
}
```

---

## 4. Phased Implementation Plan

### Phase Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        v4 IMPLEMENTATION PHASES                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PHASE 1: Foundation (4 weeks)                                              │
│  ├── Sprint 1.1: Dashboard Server Scaffold                                  │
│  ├── Sprint 1.2: Memory Store Core                                          │
│  └── Sprint 1.3: Tool Registry Core                                         │
│                                                                             │
│  PHASE 2: Core Features (6 weeks)                                           │
│  ├── Sprint 2.1: Dashboard Live View                                        │
│  ├── Sprint 2.2: Dashboard Historical View                                  │
│  ├── Sprint 2.3: Memory Persistence + Injection                             │
│  ├── Sprint 2.4: Suspend/Resume System                                      │
│  ├── Sprint 2.5: Tool Provisioning                                          │
│  └── Sprint 2.6: MCP Connector                                              │
│                                                                             │
│  PHASE 3: Integration (4 weeks)                                             │
│  ├── Sprint 3.1: Pillar Integration Layer                                   │
│  ├── Sprint 3.2: Dashboard Full UI                                          │
│  ├── Sprint 3.3: CLI Integration                                            │
│  └── Sprint 3.4: E2E Testing                                                │
│                                                                             │
│  PHASE 4: Polish (2 weeks)                                                  │
│  ├── Sprint 4.1: Performance + UX                                           │
│  └── Sprint 4.2: Documentation + Migration                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Sprint Plan

#### Phase 1: Foundation (4 weeks)

**Sprint 1.1: Dashboard Server Scaffold (Week 1)**

| Task | Description | Files |
|------|-------------|-------|
| 1.1.1 | Create `src/dashboard/` directory structure | - |
| 1.1.2 | Implement `DashboardServer` with HTTP server | `src/dashboard/server/DashboardServer.ts` |
| 1.1.3 | Implement `WSBroadcastManager` | `src/dashboard/server/WSBroadcastManager.ts` |
| 1.1.4 | Implement `RESTController` with stub endpoints | `src/dashboard/server/RESTController.ts` |
| 1.1.5 | Add dashboard types | `src/dashboard/types.ts` |
| 1.1.6 | Add CLI command `agentforge dashboard` | `src/cli/commands/dashboard.ts` |
| 1.1.7 | Write tests (target: 30+ tests) | `tests/dashboard/` |

**Sprint 1.2: Memory Store Core (Week 2)**

| Task | Description | Files |
|------|-------------|-------|
| 1.2.1 | Create `src/memory/` directory structure | - |
| 1.2.2 | Implement `AgentMemoryStore` | `src/memory/AgentMemoryStore.ts` |
| 1.2.3 | Add memory types | `src/memory/types.ts` |
| 1.2.4 | Implement memory file I/O | `src/memory/MemoryPersistence.ts` |
| 1.2.5 | Add memory decay logic | `src/memory/MemoryDecay.ts` |
| 1.2.6 | Write tests (target: 40+ tests) | `tests/memory/` |

**Sprint 1.3: Tool Registry Core (Week 3-4)**

| Task | Description | Files |
|------|-------------|-------|
| 1.3.1 | Create `src/tools/` directory structure | - |
| 1.3.2 | Implement `ToolRegistry` | `src/tools/ToolRegistry.ts` |
| 1.3.3 | Add tool types | `src/tools/types.ts` |
| 1.3.4 | Implement YAML manifest loader | `src/tools/ManifestLoader.ts` |
| 1.3.5 | Create default manifest template | `.agentforge/tools/manifest.yaml` |
| 1.3.6 | Write tests (target: 35+ tests) | `tests/tools/` |

#### Phase 2: Core Features (6 weeks)

**Sprint 2.1: Dashboard Live View (Week 5)**

| Task | Description | Files |
|------|-------------|-------|
| 2.1.1 | Implement `DashboardBridge` | `src/dashboard/server/DashboardBridge.ts` |
| 2.1.2 | Connect to `TeamModeBus` events | - |
| 2.1.3 | Connect to `CostTracker` events | - |
| 2.1.4 | Implement live WebSocket broadcast | - |
| 2.1.5 | Create React SPA skeleton | `src/dashboard/client/` |
| 2.1.6 | Implement `ConvoPanel` component | `src/dashboard/client/components/ConvoPanel/` |
| 2.1.7 | Write tests (target: 25+ tests) | `tests/dashboard/` |

**Sprint 2.2: Dashboard Historical View (Week 6)**

| Task | Description | Files |
|------|-------------|-------|
| 2.2.1 | Implement session history REST endpoints | `src/dashboard/server/RESTController.ts` |
| 2.2.2 | Implement `Timeline` component | `src/dashboard/client/components/Timeline/` |
| 2.2.3 | Implement `CostChart` component | `src/dashboard/client/components/CostChart/` |
| 2.2.4 | Implement session replay | - |
| 2.2.5 | Write tests (target: 20+ tests) | - |

**Sprint 2.3: Memory Persistence + Injection (Week 7)**

| Task | Description | Files |
|------|-------------|-------|
| 2.3.1 | Implement memory extraction from agent output | `src/memory/MemoryExtractor.ts` |
| 2.3.2 | Implement memory injection into prompts | `src/memory/MemoryInjector.ts` |
| 2.3.3 | Integrate with `OrchestratorV3.runAgent()` | - |
| 2.3.4 | Add memory relevance scoring | `src/memory/RelevanceScorer.ts` |
| 2.3.5 | Write tests (target: 35+ tests) | - |

**Sprint 2.4: Suspend/Resume System (Week 8)**

| Task | Description | Files |
|------|-------------|-------|
| 2.4.1 | Implement `SuspendManager` | `src/memory/SuspendManager.ts` |
| 2.4.2 | Implement `ResumeScheduler` | `src/memory/ResumeScheduler.ts` |
| 2.4.3 | Implement `PersistenceDecider` | `src/memory/PersistenceDecider.ts` |
| 2.4.4 | Implement `MemoryManager` facade | `src/memory/MemoryManager.ts` |
| 2.4.5 | Integrate with session lifecycle | - |
| 2.4.6 | Write tests (target: 45+ tests) | - |

**Sprint 2.5: Tool Provisioning (Week 9)**

| Task | Description | Files |
|------|-------------|-------|
| 2.5.1 | Implement `ToolProvisioner` | `src/tools/ToolProvisioner.ts` |
| 2.5.2 | Implement `AgentToolResolver` | `src/tools/AgentToolResolver.ts` |
| 2.5.3 | Implement `CapabilityValidator` | `src/tools/CapabilityValidator.ts` |
| 2.5.4 | Integrate with agent templates | - |
| 2.5.5 | Add CLI commands for tool management | `src/cli/commands/tools.ts` |
| 2.5.6 | Write tests (target: 40+ tests) | - |

**Sprint 2.6: MCP Connector (Week 10)**

| Task | Description | Files |
|------|-------------|-------|
| 2.6.1 | Implement `MCPConnector` | `src/tools/MCPConnector.ts` |
| 2.6.2 | Implement MCP server lifecycle management | `src/tools/MCPServerManager.ts` |
| 2.6.3 | Implement tool discovery from MCP servers | - |
| 2.6.4 | Implement `ToolOrchestrator` facade | `src/tools/ToolOrchestrator.ts` |
| 2.6.5 | Write tests (target: 30+ tests) | - |

#### Phase 3: Integration (4 weeks)

**Sprint 3.1: Pillar Integration Layer (Week 11)**

| Task | Description | Files |
|------|-------------|-------|
| 3.1.1 | Implement Dashboard ↔ Memory integration | - |
| 3.1.2 | Implement Dashboard ↔ Tools integration | - |
| 3.1.3 | Implement Memory ↔ Tools integration | - |
| 3.1.4 | Create `V4Session` factory (wraps v3 session) | `src/v4/V4Session.ts` |
| 3.1.5 | Write integration tests (target: 30+ tests) | - |

**Sprint 3.2: Dashboard Full UI (Week 12)**

| Task | Description | Files |
|------|-------------|-------|
| 3.2.1 | Implement `TeamRoster` component | `src/dashboard/client/components/TeamRoster/` |
| 3.2.2 | Implement memory browser UI | - |
| 3.2.3 | Implement tool management UI | - |
| 3.2.4 | Implement report export | `src/dashboard/server/ReportGenerator.ts` |
| 3.2.5 | Style polish (Tailwind) | - |
| 3.2.6 | Write E2E tests (target: 15+ tests) | - |

**Sprint 3.3: CLI Integration (Week 13)**

| Task | Description | Files |
|------|-------------|-------|
| 3.3.1 | Update `agentforge team` to use V4Session | - |
| 3.3.2 | Add `agentforge memory` commands | `src/cli/commands/memory.ts` |
| 3.3.3 | Add `agentforge tools` commands | `src/cli/commands/tools.ts` |
| 3.3.4 | Ensure CLI ↔ Dashboard coexistence | - |
| 3.3.5 | Write CLI tests (target: 25+ tests) | - |

**Sprint 3.4: E2E Testing (Week 14)**

| Task | Description | Files |
|------|-------------|-------|
| 3.4.1 | Full session workflow tests | - |
| 3.4.2 | Memory persistence across sessions | - |
| 3.4.3 | Tool provisioning validation | - |
| 3.4.4 | Dashboard WebSocket stress tests | - |
| 3.4.5 | Write E2E tests (target: 30+ tests) | - |

#### Phase 4: Polish (2 weeks)

**Sprint 4.1: Performance + UX (Week 15)**

| Task | Description | Files |
|------|-------------|-------|
| 4.1.1 | Profile and optimize hot paths | - |
| 4.1.2 | Add loading states and error boundaries | - |
| 4.1.3 | Memory query optimization | - |
| 4.1.4 | WebSocket reconnection handling | - |
| 4.1.5 | Accessibility audit | - |

**Sprint 4.2: Documentation + Migration (Week 16)**

| Task | Description | Files |
|------|-------------|-------|
| 4.2.1 | Write v4 architecture documentation | `docs/v4/` |
| 4.2.2 | Write migration guide from v3 | `docs/v4/migration.md` |
| 4.2.3 | Write dashboard user guide | `docs/v4/dashboard.md` |
| 4.2.4 | Update README | - |
| 4.2.5 | Release prep (CHANGELOG, version bump) | - |

### Test Coverage Targets

| Phase | New Tests | Cumulative Total |
|-------|-----------|------------------|
| Foundation | 105+ | 1,016+ |
| Core Features | 195+ | 1,211+ |
| Integration | 100+ | 1,311+ |
| Polish | 20+ | 1,331+ |

**Final target: 1,300+ tests (up from 911 in v3.2)**

---

## 5. Team Extensions

### 5.1 New Agents Required

| Agent Name | Model | Category | Purpose |
|------------|-------|----------|---------|
| `dashboard-dev` | Sonnet | Implementation | Build dashboard server + React components |
| `memory-architect` | Opus | Strategic | Design memory schemas and persistence rules |
| `tool-system-dev` | Sonnet | Implementation | Build tool registry, provisioner, MCP connector |
| `ui-designer` | Sonnet | Implementation | Dashboard UI/UX, component styling |
| `integration-dev` | Sonnet | Implementation | Build pillar integration layer |
| `e2e-test-dev` | Sonnet | Quality | Write comprehensive E2E tests |

### 5.2 Existing Agent Upgrades

| Agent | Upgrade | Rationale |
|-------|---------|-----------|
| `architect` | Add memory injection for design decisions | Persist architectural patterns across sessions |
| `cto` | Add tool provisioning oversight | Control which tools strategic agents access |
| `coder` | Add memory for code patterns | Remember coding conventions learned |
| `debugger` | Add mistake memory | Remember what didn't work |
| `researcher` | Add research memory | Persist findings across sessions |
| `team-mode-lead` | Add dashboard awareness | Route dashboard commands |
| `persistence-lead` | Add memory management skills | Own memory lifecycle |

### 5.3 New Agent YAML Templates

```yaml
# .agentforge/agents/dashboard-dev.yaml
name: dashboard-dev
model: sonnet
version: '1.0'
description: >
  Builds the v4 web dashboard including server-side components (DashboardServer,
  DashboardBridge, REST/WebSocket APIs) and client-side React components
  (ConvoPanel, CostChart, TeamRoster, Timeline).
system_prompt: |
  You are the Dashboard Developer agent for AgentForge v4.
  
  ## Role
  You build the web dashboard that provides real-time visibility into agent team
  activity. You write TypeScript for the server (Node.js) and React for the client.
  
  ## Your Position in the Organization
  - You report to: The Architect for design decisions
  - You collaborate with: ui-designer for component styling
  - You delegate to: No one (you implement directly)
  
  ## Technical Stack
  - Server: Node.js, native http/ws modules
  - Client: React 18, Vite, Zustand, Tailwind CSS, Recharts
  - Protocol: WebSocket for live updates, REST for queries
  
  ## Quality Standards
  - All components must have unit tests
  - WebSocket handlers must be resilient to disconnection
  - React components must handle loading/error states
  - Accessibility: WCAG 2.1 AA minimum
  
skills:
  - react_development
  - websocket_programming
  - rest_api_design
  - typescript
triggers:
  file_patterns:
    - src/dashboard/**
    - tests/dashboard/**
  keywords:
    - dashboard
    - web ui
    - websocket
    - react
collaboration:
  reports_to: architect
  reviews_from:
    - architect
    - ui-designer
  can_delegate_to: []
  parallel: true
context:
  max_files: 25
  auto_include:
    - src/dashboard/types.ts
```

```yaml
# .agentforge/agents/memory-architect.yaml
name: memory-architect
model: opus
version: '1.0'
description: >
  Designs the agent memory system including persistence schemas, memory decay
  algorithms, suspend/resume semantics, and persistence vs close heuristics.
system_prompt: |
  You are the Memory Architect agent for AgentForge v4.
  
  ## Role
  You design the persistent memory system that allows agents to accumulate
  knowledge across sessions. This is a strategic architecture role — you
  define data models, algorithms, and policies; implementation is delegated.
  
  ## Key Challenges You Own
  1. Memory decay: How confidence decays over time
  2. Memory relevance: How to select which memories to inject
  3. Suspend/resume: When to suspend vs close an agent
  4. Memory categories: What types of knowledge to persist
  5. Memory conflicts: How to resolve contradictory memories
  
  ## Design Principles
  - Memory should be queryable by relevance, not just recency
  - Suspension is expensive — only suspend when resume value is high
  - Memories should have sources for auditability
  - Decay prevents stale knowledge from polluting context
  
skills:
  - data_modeling
  - algorithm_design
  - system_architecture
triggers:
  file_patterns:
    - src/memory/**
    - docs/v4/memory*
  keywords:
    - memory system
    - agent memory
    - suspend resume
    - persistence
collaboration:
  reports_to: cto
  reviews_from:
    - cto
    - lead-architect
  can_delegate_to:
    - tool-system-dev
  parallel: false
context:
  max_files: 20
  auto_include:
    - src/memory/types.ts
    - src/orchestrator/knowledge-store.ts
```

---

## 6. Key Technical Decisions and Trade-offs

### 6.1 Dashboard Technology Stack

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Server Framework | Native Node.js http | Express, Fastify, Hono | Zero dependencies, full control, v3 pattern |
| WebSocket | Native ws | Socket.io | Simpler, no deps, sufficient for use case |
| Frontend Framework | React | Vue, Svelte, Solid | Team familiarity, ecosystem, hiring |
| Build Tool | Vite | Webpack, Parcel | Fast, modern, minimal config |
| State Management | Zustand | Redux, MobX, Jotai | Minimal boilerplate, TypeScript-first |
| Styling | Tailwind CSS | CSS Modules, styled-components | Rapid iteration, consistent design |
| Charts | Recharts | D3, Chart.js, Nivo | React-native, composable, TypeScript |

**Trade-off:** Choosing React adds a build step and client-side complexity but provides the richest component ecosystem and developer familiarity.

### 6.2 Memory Storage Format

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Storage Format | JSON files | SQLite, LevelDB, Redis | Zero deps, human-readable, git-friendly |
| Memory Index | In-memory + JSON | Full-text search, Vector DB | Sufficient for expected scale (100s memories/agent) |
| Relevance Scoring | Keyword + recency | Embeddings, BM25 | Simpler, no ML dependencies |

**Trade-off:** JSON files don't scale to millions of memories, but expected scale is <1000 memories per agent. If scale grows, migration to SQLite is straightforward.

### 6.3 Tool Provisioning Model

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Tool Assignment | YAML manifest | Database, env vars, per-run | Declarative, auditable, version-controlled |
| MCP Integration | Process spawning | In-process, HTTP | Standard MCP pattern, isolation |
| Tool Permissions | Whitelist per agent | Global allow, capability tokens | Least privilege, auditability |

**Trade-off:** YAML manifests require restart to apply changes, but changes are infrequent and auditability is more important than hot-reload.

### 6.4 Session Model

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| V4Session | Wrapper around AgentForgeSession | Replace AgentForgeSession | Preserves v3 investment, composition over modification |
| Dashboard Server | Separate process | In-CLI process | Can run dashboard without active session |
| Memory Manager | Per-session singleton | Global singleton | Session isolation, clean teardown |

**Trade-off:** Running dashboard as separate process adds startup complexity but allows dashboard to persist across CLI sessions.

---

## 7. Risk Register

| ID | Risk | Probability | Impact | Mitigation | Owner |
|----|------|-------------|--------|------------|-------|
| R1 | Dashboard adds significant bundle size | Medium | Medium | Lazy-load dashboard deps, tree-shake aggressively | dashboard-dev |
| R2 | Memory injection bloats prompts | High | High | Hard limit on injected tokens (2000), relevance cutoff | memory-architect |
| R3 | Suspend/resume creates orphan tasks | Medium | High | Automatic expiry (24h default), dashboard visibility | memory-architect |
| R4 | MCP server crashes destabilize system | Medium | High | Process isolation, automatic restart, graceful degradation | tool-system-dev |
| R5 | WebSocket connections leak on error | Medium | Medium | Connection pooling, heartbeats, explicit cleanup | dashboard-dev |
| R6 | Memory decay deletes valuable knowledge | Low | High | Decay never deletes, only reduces confidence; manual delete only | memory-architect |
| R7 | Tool permission escalation | Low | Critical | Strict whitelist, no dynamic tool addition without review | tool-system-dev |
| R8 | Dashboard shows stale data | Medium | Medium | Server-push for all mutations, WebSocket reconnect refresh | dashboard-dev |
| R9 | Cross-pillar integration complexity | High | Medium | Clear interface contracts, integration tests, facade pattern | integration-dev |
| R10 | v3→v4 migration breaks existing workflows | Medium | High | V4Session wraps v3, CLI backward compat, migration guide | architect |

### Risk Monitoring Checkpoints

| Checkpoint | Sprint | Risks Validated |
|------------|--------|-----------------|
| Dashboard MVP | 2.1 | R1, R5, R8 |
| Memory Core | 2.3 | R2, R6 |
| Suspend/Resume | 2.4 | R3 |
| MCP Integration | 2.6 | R4 |
| Full Integration | 3.1 | R9, R10 |
| Tool Provisioning | 2.5 | R7 |

---

## Appendix A: Directory Structure (Final State)

```
agentforge/
├── src/
│   ├── index.ts
│   ├── cli/
│   │   └── commands/
│   │       ├── dashboard.ts        # NEW
│   │       ├── memory.ts           # NEW
│   │       ├── tools.ts            # NEW
│   │       └── ... (existing)
│   ├── dashboard/                  # NEW (Pillar 1)
│   │   ├── types.ts
│   │   ├── client/
│   │   │   ├── App.tsx
│   │   │   ├── main.tsx
│   │   │   ├── store/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── utils/
│   │   └── server/
│   │       ├── DashboardServer.ts
│   │       ├── DashboardBridge.ts
│   │       ├── RESTController.ts
│   │       ├── WSBroadcastManager.ts
│   │       └── ReportGenerator.ts
│   ├── memory/                     # NEW (Pillar 2)
│   │   ├── types.ts
│   │   ├── AgentMemoryStore.ts
│   │   ├── MemoryPersistence.ts
│   │   ├── MemoryDecay.ts
│   │   ├── MemoryExtractor.ts
│   │   ├── MemoryInjector.ts
│   │   ├── RelevanceScorer.ts
│   │   ├── SuspendManager.ts
│   │   ├── ResumeScheduler.ts
│   │   ├── PersistenceDecider.ts
│   │   ├── MemoryManager.ts
│   │   └── index.ts
│   ├── tools/                      # NEW (Pillar 3)
│   │   ├── types.ts
│   │   ├── ToolRegistry.ts
│   │   ├── ManifestLoader.ts
│   │   ├── ToolProvisioner.ts
│   │   ├── AgentToolResolver.ts
│   │   ├── CapabilityValidator.ts
│   │   ├── MCPConnector.ts
│   │   ├── MCPServerManager.ts
│   │   ├── ToolOrchestrator.ts
│   │   └── index.ts
│   ├── v4/                         # NEW (Integration)
│   │   ├── V4Session.ts
│   │   └── index.ts
│   ├── orchestrator/               # Existing (modified)
│   ├── types/                      # Existing (extended)
│   └── ... (other existing)
├── tests/
│   ├── dashboard/                  # NEW
│   ├── memory/                     # NEW
│   ├── tools/                      # NEW
│   ├── v4/                         # NEW
│   └── ... (existing)
├── .agentforge/
│   ├── agents/
│   │   ├── dashboard-dev.yaml      # NEW
│   │   ├── memory-architect.yaml   # NEW
│   │   ├── tool-system-dev.yaml    # NEW
│   │   ├── ui-designer.yaml        # NEW
│   │   ├── integration-dev.yaml    # NEW
│   │   ├── e2e-test-dev.yaml       # NEW
│   │   └── ... (existing)
│   ├── memory/                     # NEW
│   │   ├── agents/
│   │   │   └── {agent-name}/
│   │   │       └── {category}.json
│   │   ├── suspended/
│   │   │   └── task-{id}.json
│   │   └── index.json
│   ├── tools/                      # NEW
│   │   ├── manifest.yaml
│   │   ├── scripts/
│   │   └── plugins/
│   ├── dashboard/                  # NEW
│   │   └── exports/
│   ├── sessions/                   # Existing
│   └── knowledge/                  # Existing
└── docs/
    └── v4/                         # NEW
        ├── architecture.md
        ├── dashboard.md
        ├── memory.md
        ├── tools.md
        └── migration.md
```

---

## Appendix B: Dependency Analysis

### New Dependencies (Dashboard Client Only)

| Package | Purpose | Size (gzip) |
|---------|---------|-------------|
| react | UI framework | 44kb |
| react-dom | DOM renderer | 130kb |
| zustand | State management | 3kb |
| recharts | Charts | 150kb |
| lucide-react | Icons | tree-shaken |

**Total client bundle (estimated):** ~400kb gzip

### Core Remains Dependency-Free

The v4 server-side components (Memory, Tools, Dashboard Server) use **only Node.js built-ins**, maintaining the zero-dependency principle for core functionality.

---

**End of Architecture Document**
