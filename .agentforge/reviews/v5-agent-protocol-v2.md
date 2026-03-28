# Autonomous Agent Protocol v2

**Author:** lead-architect
**Sprint:** v4.9 (item v49-6)
**Date:** 2026-03-27
**Status:** Complete

---

## 1. Overview

Agent Protocol v2 replaces v4's implicit delegation model with a typed, versioned message protocol. Every agent interaction — delegation, escalation, resource request, progress update — is a message on a bus. This enables:

- Asynchronous agent communication
- Auditable message history
- Self-proposing agents (agents initiate work, not just respond)
- Formal escalation with resolution options
- Capability-based task routing
- Learning from outcomes

---

## 2. Message Type Taxonomy

### 2.1 Core Message Types

```typescript
enum MessageType {
  // === Task Management ===
  TaskAssign          = 'task.assign',           // Assign a task to an agent
  TaskAccept          = 'task.accept',           // Agent accepts a task
  TaskReject          = 'task.reject',           // Agent rejects (with reason)
  TaskComplete        = 'task.complete',         // Task completed successfully
  TaskFail            = 'task.fail',             // Task failed
  TaskCancel          = 'task.cancel',           // Task cancelled by requester

  // === Self-Proposal ===
  TaskPropose         = 'task.propose',          // Agent proposes a task for itself
  TaskProposalApprove = 'task.proposal.approve', // Supervisor approves proposal
  TaskProposalDeny    = 'task.proposal.deny',    // Supervisor denies proposal

  // === Delegation ===
  DelegationRequest   = 'delegation.request',    // Agent requests to delegate subtask
  DelegationApprove   = 'delegation.approve',    // Delegation approved
  DelegationDeny      = 'delegation.deny',       // Delegation denied (budget, capability)

  // === Resource Management ===
  ResourceRequest     = 'resource.request',      // Request budget, agent, file access
  ResourceGrant       = 'resource.grant',        // Resource granted
  ResourceDeny        = 'resource.deny',         // Resource denied

  // === Progress & Status ===
  ProgressUpdate      = 'progress.update',       // Intermediate progress report
  StatusChange        = 'status.change',         // Agent status changed (idle, busy, etc.)
  HeartBeat           = 'heartbeat',             // Agent is alive and working

  // === Escalation ===
  EscalateBlocker     = 'escalate.blocker',      // Blocked, needs help
  EscalateDecision    = 'escalate.decision',     // Needs a decision from above
  EscalateResolved    = 'escalate.resolved',     // Escalation resolved

  // === Capability ===
  CapabilityMismatch  = 'capability.mismatch',   // Task outside agent's scope
  CapabilityUpdate    = 'capability.update',     // Agent's capabilities changed

  // === Learning ===
  OutcomeRecord       = 'outcome.record',        // Record task outcome for learning
  ConfidenceUpdate    = 'confidence.update',     // Agent updates its confidence score

  // === System ===
  AgentRegister       = 'agent.register',        // Agent comes online
  AgentDeregister     = 'agent.deregister',      // Agent goes offline
  BusAck              = 'bus.ack',               // Bus acknowledges receipt
}
```

### 2.2 Message Payloads

```typescript
// === Task Assignment ===
interface TaskAssignPayload {
  taskId: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  budget?: { maxTokens: number; maxCostUsd: number };
  deadline?: string;           // ISO 8601
  context?: Record<string, unknown>;
  parentTaskId?: string;       // If this is a subtask
}

// === Task Self-Proposal ===
interface TaskProposePayload {
  proposalId: string;
  title: string;
  description: string;
  rationale: string;           // Why this task should be done now
  estimatedCost: number;       // USD
  estimatedDuration: string;   // e.g., "5 minutes"
  triggerCondition: string;    // What triggered this proposal
  confidence: number;          // 0-1, how confident the agent is this is valuable
}

// === Resource Request ===
interface ResourceRequestPayload {
  requestId: string;
  resourceType: 'budget' | 'agent' | 'file_access' | 'tool_access' | 'time_extension';
  details: {
    budgetUsd?: number;
    agentName?: string;
    filePaths?: string[];
    toolNames?: string[];
    extensionMs?: number;
  };
  justification: string;
}

// === Escalation ===
interface EscalateBlockerPayload {
  escalationId: string;
  blockerType: 'dependency' | 'permission' | 'ambiguity' | 'resource' | 'technical';
  description: string;
  attemptedResolutions: string[];    // What the agent already tried
  proposedResolutions: Array<{       // Options for the supervisor
    id: string;
    description: string;
    estimatedImpact: string;
    recommended: boolean;
  }>;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timeBlocked: number;              // Milliseconds since blocked
}

// === Progress Update ===
interface ProgressUpdatePayload {
  taskId: string;
  percentComplete: number;          // 0-100
  currentStep: string;
  stepsCompleted: number;
  stepsTotal: number;
  tokensUsed: number;
  costSoFar: number;
  estimatedRemaining: string;
  artifacts?: Array<{               // Intermediate outputs
    type: 'file' | 'data' | 'log';
    path?: string;
    content?: string;
  }>;
}

// === Capability Mismatch ===
interface CapabilityMismatchPayload {
  taskId: string;
  requiredCapabilities: string[];
  agentCapabilities: string[];
  missingCapabilities: string[];
  suggestedAgents: string[];         // Agents that have the required capabilities
}

// === Outcome Recording ===
interface OutcomeRecordPayload {
  taskId: string;
  sessionId: string;
  outcome: 'success' | 'partial' | 'failure';
  metrics: {
    tokensUsed: number;
    costUsd: number;
    durationMs: number;
    delegationDepth: number;
    escalationCount: number;
  };
  lessonsLearned: string[];          // Freeform insights
  shouldRetry: boolean;
  retryStrategy?: string;
}

// === Confidence Update ===
interface ConfidenceUpdatePayload {
  domain: string;                    // e.g., 'typescript', 'api-design', 'testing'
  previousScore: number;             // 0-1
  newScore: number;                  // 0-1
  evidenceSessionIds: string[];      // Sessions that informed the update
  reason: string;
}
```

---

## 3. Agent Lifecycle State Machine

```
                    ┌─────────┐
                    │  IDLE   │ ◄──────────────────────────┐
                    └────┬────┘                             │
                         │                                  │
                    TaskAssign                          TaskComplete
                    TaskProposalApprove                 TaskFail
                         │                             TaskCancel
                         ▼                                  │
                    ┌─────────┐                             │
              ┌────►│  BUSY   │─────────────────────────────┘
              │     └────┬────┘
              │          │
              │     EscalateBlocker
              │          │
              │          ▼
              │     ┌─────────┐
              │     │ BLOCKED │
              │     └────┬────┘
              │          │
              │     EscalateResolved
              │          │
              └──────────┘

    At any state:
    ┌─────────┐     AgentDeregister     ┌──────────┐
    │ (any)   │ ──────────────────────► │ OFFLINE  │
    └─────────┘                         └──────────┘
```

**State definitions:**

| State | Description | Allowed Actions |
|-------|-------------|-----------------|
| `IDLE` | No active task. Monitoring for proposals. | TaskPropose, accept TaskAssign |
| `BUSY` | Actively working on a task. | ProgressUpdate, DelegationRequest, ResourceRequest, EscalateBlocker, TaskComplete, TaskFail |
| `BLOCKED` | Waiting for escalation resolution. | HeartBeat (to show still alive) |
| `OFFLINE` | Agent process not running. | AgentRegister to come back online |

---

## 4. Self-Proposal System

Agents can propose tasks based on their domain knowledge and the current project state.

### 4.1 Trigger Conditions

An agent evaluates whether to self-propose when:

1. **Idle timeout.** Agent has been IDLE for >60 seconds. It reviews the current sprint and project state for unassigned work.
2. **Event trigger.** An event on the bus matches the agent's domain. E.g., a `session.failed` event for a testing session might trigger the debugger to propose a fix.
3. **Scheduled review.** Configured interval (default: every 5 minutes when idle). Agent scans for opportunities in its domain.
4. **Feedback trigger.** New feedback arrives that matches the agent's capabilities.

### 4.2 Proposal Flow

```
Agent (IDLE)                    Supervisor                     Bus
    │                               │                           │
    │ ──── TaskPropose ──────────►  │                           │
    │      (with rationale,         │                           │
    │       confidence, cost)       │                           │
    │                               │ ── evaluate proposal ──   │
    │                               │    (check budget,         │
    │                               │     priority, conflicts)  │
    │                               │                           │
    │ ◄── TaskProposalApprove ────  │                           │
    │     (or TaskProposalDeny)     │                           │
    │                               │                           │
    │ ──── StatusChange(BUSY) ──────────────────────────────►   │
    │                               │                           │
    │ ──── ProgressUpdate ──────────────────────────────────►   │
    │      ...                      │                           │
    │ ──── TaskComplete ────────────────────────────────────►   │
    │                               │                           │
    │ ──── OutcomeRecord ───────────────────────────────────►   │
    │                               │                           │
    │ ──── StatusChange(IDLE) ──────────────────────────────►   │
```

### 4.3 Proposal Evaluation Rules

The supervisor (team lead agent or CTO for cross-team proposals) evaluates proposals against:

1. **Budget check.** Is there remaining budget for this sprint?
2. **Priority alignment.** Does this align with current sprint goals?
3. **Conflict detection.** Is another agent already working on this or something overlapping?
4. **Confidence threshold.** Agent's self-reported confidence must be >= 0.6 for auto-approval, < 0.6 requires human review.
5. **Cost cap.** Proposal cost must be within agent's per-task budget limit.

**Auto-approval rules:**
- Confidence >= 0.8 AND cost < $0.10 AND no conflicts → auto-approved
- Confidence >= 0.6 AND cost < $0.50 AND priority matches sprint → auto-approved
- Everything else → queued for supervisor review

---

## 5. Escalation Protocol

### 5.1 Escalation Chain

```
Agent → Team Lead → VP → CTO → CEO → Human
```

Each level has a response timeout:
- Team Lead: 30 seconds
- VP: 60 seconds
- CTO: 120 seconds
- CEO: 300 seconds
- Human: no timeout (async notification)

If a level times out, escalation automatically moves up.

### 5.2 Escalation Response

The supervisor must choose one of the proposed resolutions or provide a custom one:

```typescript
interface EscalateResolvedPayload {
  escalationId: string;
  resolution: {
    chosenOptionId: string | 'custom';
    customResolution?: string;
    additionalContext?: string;
  };
  resolvedBy: string;           // Agent or user ID
}
```

### 5.3 Escalation Metrics

Tracked per agent and per team:
- Average time to resolution
- Escalation frequency (per 100 tasks)
- Escalation depth (how many levels before resolution)
- Resolution satisfaction (did the escalation actually unblock?)

These metrics feed into autonomy tier scoring. Agents that escalate less and resolve more get promoted to higher autonomy tiers.

---

## 6. Confidence and Learning

### 6.1 Confidence Scores

Each agent maintains a confidence score per domain (0.0 to 1.0):

```typescript
interface AgentConfidence {
  agentId: string;
  domains: Record<string, {
    score: number;           // 0.0 - 1.0
    taskCount: number;       // Total tasks in this domain
    successRate: number;     // 0.0 - 1.0
    lastUpdated: string;     // ISO 8601
  }>;
}
```

### 6.2 Score Update Algorithm

After each task completion:

```
new_score = (0.7 * old_score) + (0.3 * task_outcome_score)

where task_outcome_score:
  success + under budget + no escalations = 1.0
  success + under budget + escalations    = 0.8
  success + over budget                   = 0.6
  partial success                         = 0.4
  failure + graceful                      = 0.2
  failure + crash                         = 0.0
```

The 0.7/0.3 weighting means recent performance matters but a single failure doesn't destroy a good track record.

### 6.3 Confidence-Based Routing

When a task arrives and multiple agents could handle it, the router considers:

1. **Primary assignment:** Agent whose YAML role matches the task type
2. **Confidence tiebreaker:** If multiple agents qualify, prefer higher confidence
3. **Load balancing:** If the best agent is BUSY, the second-best agent gets it (if confidence >= 0.5)
4. **Escalation:** If no agent has confidence >= 0.5, escalate to supervisor for manual assignment

---

## 7. Message Bus Implementation

### 7.1 Local Deployment (Single Process)

```typescript
class LocalMessageBus implements MessageBus {
  private subscribers: Map<string, Set<MessageHandler>> = new Map();
  private history: AgentMessage[] = [];
  private db: WorkspaceDb;

  publish(message: AgentMessage): void {
    // Persist to events table
    this.db.insertEvent(message);

    // Deliver to subscribers
    const handlers = this.subscribers.get(message.type) ?? new Set();
    const wildcardHandlers = this.subscribers.get('*') ?? new Set();

    for (const handler of [...handlers, ...wildcardHandlers]) {
      try {
        handler(message);
      } catch (err) {
        this.publish({
          type: MessageType.BusAck,
          from: 'bus',
          to: message.from,
          payload: { error: err.message, originalMessageId: message.id },
        });
      }
    }
  }

  subscribe(types: string[], handler: MessageHandler): Unsubscribe {
    for (const type of types) {
      if (!this.subscribers.has(type)) this.subscribers.set(type, new Set());
      this.subscribers.get(type)!.add(handler);
    }
    return () => {
      for (const type of types) {
        this.subscribers.get(type)?.delete(handler);
      }
    };
  }
}
```

### 7.2 Cloud Deployment (Multi-Node)

Replace `LocalMessageBus` with `RedisMessageBus`:
- Uses Redis Streams for message persistence and delivery
- Consumer groups for load-balanced processing
- `XADD` for publish, `XREADGROUP` for subscribe
- Automatic dead-letter queue for failed messages
- Same `MessageBus` interface — swap is transparent to agents

---

## 8. Protocol Versioning

All messages include `version: '2.0'`. When v2.1 is released:
- Agents declare which protocol versions they support
- The bus routes messages to the correct version handler
- Backward compatibility: v2.0 messages are always accepted
- Forward compatibility: unknown fields are ignored, unknown message types are logged and dropped
