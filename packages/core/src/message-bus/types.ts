import type { AgentId, SessionId, WorkspaceId } from '@agentforge/shared';

// ── Message envelope ─────────────────────────────────────────────────────────

export interface MessageEnvelopeV2<TPayload = unknown> {
  id: string;
  version: '2.0';
  timestamp: string;
  workspaceId: WorkspaceId;
  from: AgentId | 'system' | 'user';
  to: AgentId | 'broadcast' | 'system';
  topic: MessageTopic;
  category: MessageCategory;
  priority: MessagePriority;
  payload: TPayload;
  correlationId?: string; // links request → response
  sessionId?: SessionId;
  ttlMs?: number; // message expires after this many ms
}

// ── Enums ─────────────────────────────────────────────────────────────────────

export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';
export type MessageCategory =
  | 'lifecycle'     // agent start/stop/suspend
  | 'task'          // task assignment, progress, completion
  | 'delegation'    // delegation requests/responses
  | 'resource'      // resource requests/approvals
  | 'escalation'    // blocker escalation
  | 'feedback'      // quality/performance feedback
  | 'cost'          // cost events and alerts
  | 'system'        // system health, bus events
  | 'comms'         // DMs and inbox messages (v2 agent-comm)
  | 'quality'       // gate verdicts + review findings
  | 'plugin';       // plugin-emitted events

// ── Topic taxonomy ────────────────────────────────────────────────────────────

export type MessageTopic =
  // Lifecycle
  | 'agent.lifecycle.started'
  | 'agent.lifecycle.suspended'
  | 'agent.lifecycle.resumed'
  | 'agent.lifecycle.completed'
  | 'agent.lifecycle.failed'
  // Task
  | 'agent.task.assigned'
  | 'agent.task.accepted'
  | 'agent.task.rejected'
  | 'agent.task.progress'
  | 'agent.task.completed'
  | 'agent.task.failed'
  | 'agent.task.proposed'   // self-proposed task
  // Delegation
  | 'agent.delegation.requested'
  | 'agent.delegation.accepted'
  | 'agent.delegation.rejected'
  | 'agent.delegation.completed'
  // Resource
  | 'agent.resource.requested'
  | 'agent.resource.approved'
  | 'agent.resource.denied'
  // Escalation
  | 'agent.escalation.raised'
  | 'agent.escalation.resolved'
  | 'agent.escalation.timeout'
  // Feedback
  | 'agent.feedback.submitted'
  | 'agent.feedback.acknowledged'
  | 'agent.promotion.proposed'
  | 'agent.promotion.approved'
  | 'agent.promotion.rejected'
  // Cost
  | 'cost.recorded'
  | 'cost.anomaly.detected'
  | 'cost.budget.warning'
  | 'cost.budget.exceeded'
  // System
  | 'system.health.check'
  | 'system.health.status'
  | 'bus.event.replay.requested'
  // Communication (v2 agent-comm spec — Phase 2)
  | 'agent.dm.sent'
  | 'inbox.message.created'
  // Quality + gate (mirrored to @user inbox by InboxBridge — ADR 0004)
  | 'gate.verdict.created'
  | 'review.finding.created'
  // Plugin
  | 'plugin.event'
  // Self-modification canary lifecycle
  | 'self-modification.canary.staged'
  | 'self-modification.canary.promoted'
  | 'self-modification.canary.rolled_back'
  // Worktree / branch (Cycle 4 — T4.3 / T4.4)
  | 'agent.branch.pushed'
  | 'merge-queue.pr.opened';

// ── Agent state machine ───────────────────────────────────────────────────────

export type AgentLifecycleState =
  | 'idle'
  | 'busy'
  | 'blocked'
  | 'suspended'
  | 'failed'
  | 'retired';

// ── Payload types ─────────────────────────────────────────────────────────────

export interface TaskAssignedPayload {
  taskId: string;
  task: string;
  context?: string;
  budgetUsd?: number;
  deadlineMs?: number;
  delegationDepth: number;
}

export interface TaskProgressPayload {
  taskId: string;
  progressPct: number;
  statusMessage: string;
  tokensUsed: number;
  estimatedCostUsd: number;
}

export interface TaskCompletedPayload {
  taskId: string;
  sessionId: SessionId;
  result: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  qualityScore?: number;
}

export interface TaskRejectedPayload {
  taskId: string;
  reason: 'capability_mismatch' | 'budget_exceeded' | 'at_capacity' | 'out_of_scope';
  message: string;
  suggestedAgent?: AgentId;
}

export interface TaskProposedPayload {
  proposalId: string;
  task: string;
  rationale: string;
  estimatedCostUsd: number;
  confidenceScore: number; // 0–1
  requiredCapabilities: string[];
  proposedBy: AgentId;
}

export interface DelegationRequestPayload {
  delegationId: string;
  taskId: string;
  task: string;
  targetAgent: AgentId;
  budgetUsd?: number;
  context: string;
  depth: number;
}

export interface ResourceRequestPayload {
  requestId: string;
  resourceType: 'agent' | 'budget' | 'file_access' | 'api_key' | 'tool';
  amount?: number;
  reason: string;
  urgency: MessagePriority;
}

export interface EscalationPayload {
  escalationId: string;
  taskId: string;
  blockerId: string;
  description: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  resolutionOptions: string[];
  timeoutMs: number;
}

export interface FeedbackPayload {
  feedbackId: string;
  targetAgent: AgentId;
  category: 'quality' | 'speed' | 'accuracy' | 'communication' | 'cost';
  sentiment: 'positive' | 'neutral' | 'negative';
  message: string;
  score?: number; // 0–10
}

export interface CostAnomalyPayload {
  agentId: AgentId;
  sessionId: SessionId;
  amount: number;
  threshold: number;
  percentageOver: number;
  model: string;
}

export interface PromotionProposalPayload {
  agentId: AgentId;
  currentTier: number;
  proposedTier: number;
  direction: 'promotion' | 'demotion';
  evidence: string[];
  confidenceScore: number;
}

// ── Lifecycle payload ─────────────────────────────────────────────────────────

export interface AgentLifecyclePayload {
  agentId: AgentId;
  state: AgentLifecycleState;
  sessionId?: SessionId;
  reason?: string;
  timestamp: string;
}

// ── Cost payload ──────────────────────────────────────────────────────────────

export interface CostRecordedPayload {
  agentId: AgentId;
  sessionId: SessionId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  taskId?: string;
}

export interface CostBudgetWarningPayload {
  workspaceId: WorkspaceId;
  budgetUsd: number;
  spentUsd: number;
  percentUsed: number;
  agentId?: AgentId;
}

// ── System payload ────────────────────────────────────────────────────────────

export interface SystemHealthPayload {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeMs: number;
  connectedClients: number;
  busStats: {
    totalPublished: number;
    historySize: number;
    subscriberCount: number;
  };
  version: string;
}

// ── Plugin payload ────────────────────────────────────────────────────────────

export interface PluginEventPayload {
  pluginId: string;
  eventType: string;
  data: unknown;
  source: string;
}

// ── Comms payloads (Phase 2 — v2 agent-comm spec) ─────────────────────────────

/** Payload for `agent.dm.sent` — peer-to-peer DM published on the bus. */
export interface AgentDmSentPayload {
  id: string;
  fromAgent: string;
  toAgent: string;
  body: string;
  replyToId: string | null;
  sentAt: string;
}

/** Payload for `inbox.message.created` — inbox row + recipient list. */
export interface InboxMessageCreatedPayload {
  id: string;
  body: string;
  kind: 'info' | 'warning' | 'action_required';
  sourceId: string | null;
  sourceType: string | null;
  threadId: string | null;
  createdAt: string;
  recipients: string[];
}

/**
 * Payload for `gate.verdict.created` — emitted by GatePhaseHandler when a
 * verdict is written. Mirrored to the `@user` inbox by `InboxBridge` per
 * ADR 0004 (the JSONL memory store stays canonical; the inbox row is the
 * surfacing layer).
 */
export interface GateVerdictCreatedPayload {
  /** Memory-entry id (`writeMemoryEntry({type: 'gate-verdict'}).id`). */
  entryId: string;
  cycleId: string;
  verdict: 'approved' | 'rejected' | 'pending';
  rationale: string;
  criticalFindings: string[];
  majorFindings: string[];
  createdAt: string;
}

/**
 * Payload for `review.finding.created` — emitted by the review phase when
 * a CRITICAL or MAJOR finding is captured. Mirrored to `@user` inbox by
 * `InboxBridge` per ADR 0004.
 */
export interface ReviewFindingCreatedPayload {
  entryId: string;
  cycleId: string;
  severity: 'CRITICAL' | 'MAJOR';
  summary: string;
  file: string | null;
  line: number | null;
  fixSuggestion: string | null;
  createdAt: string;
}

/** Payload for self-modification canary lifecycle events. */
export interface SelfModificationCanaryLifecyclePayload {
  agentName: string;
  planId: string;
  flagId: string;
  trafficPercent: number;
  strategy: 'hash' | 'header' | 'percentage';
  rollbackThreshold: number;
  canaryRequests: number;
  canaryErrors: number;
  errorRate: number;
  rollbackReason?: string;
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isTaskTopic(topic: MessageTopic): boolean {
  return topic.startsWith('agent.task.');
}

export function isDelegationTopic(topic: MessageTopic): boolean {
  return topic.startsWith('agent.delegation.');
}

export function isEscalationTopic(topic: MessageTopic): boolean {
  return topic.startsWith('agent.escalation.');
}

export function isLifecycleTopic(topic: MessageTopic): boolean {
  return topic.startsWith('agent.lifecycle.');
}

export function isCostTopic(topic: MessageTopic): boolean {
  return topic.startsWith('cost.');
}

export function isFeedbackTopic(topic: MessageTopic): boolean {
  return topic.startsWith('agent.feedback.') || topic.startsWith('agent.promotion.');
}

export function isSystemTopic(topic: MessageTopic): boolean {
  return topic.startsWith('system.')
    || topic.startsWith('bus.')
    || topic.startsWith('self-modification.');
}

// ── Typed envelope constructors ───────────────────────────────────────────────

export type TaskAssignedEnvelope = MessageEnvelopeV2<TaskAssignedPayload>;
export type TaskProgressEnvelope = MessageEnvelopeV2<TaskProgressPayload>;
export type TaskCompletedEnvelope = MessageEnvelopeV2<TaskCompletedPayload>;
export type TaskRejectedEnvelope = MessageEnvelopeV2<TaskRejectedPayload>;
export type TaskProposedEnvelope = MessageEnvelopeV2<TaskProposedPayload>;
export type DelegationRequestEnvelope = MessageEnvelopeV2<DelegationRequestPayload>;
export type ResourceRequestEnvelope = MessageEnvelopeV2<ResourceRequestPayload>;
export type EscalationEnvelope = MessageEnvelopeV2<EscalationPayload>;
export type FeedbackEnvelope = MessageEnvelopeV2<FeedbackPayload>;
export type CostAnomalyEnvelope = MessageEnvelopeV2<CostAnomalyPayload>;
export type PromotionProposalEnvelope = MessageEnvelopeV2<PromotionProposalPayload>;
export type AgentLifecycleEnvelope = MessageEnvelopeV2<AgentLifecyclePayload>;
export type CostRecordedEnvelope = MessageEnvelopeV2<CostRecordedPayload>;
export type SystemHealthEnvelope = MessageEnvelopeV2<SystemHealthPayload>;
export type PluginEventEnvelope = MessageEnvelopeV2<PluginEventPayload>;
export type AgentDmSentEnvelope = MessageEnvelopeV2<AgentDmSentPayload>;
export type InboxMessageCreatedEnvelope = MessageEnvelopeV2<InboxMessageCreatedPayload>;
export type GateVerdictCreatedEnvelope = MessageEnvelopeV2<GateVerdictCreatedPayload>;
export type ReviewFindingCreatedEnvelope = MessageEnvelopeV2<ReviewFindingCreatedPayload>;
export type SelfModificationCanaryLifecycleEnvelope =
  MessageEnvelopeV2<SelfModificationCanaryLifecyclePayload>;

// ── Worktree / branch payloads (Cycle 4 — T4.3) ──────────────────────────────

/**
 * Payload for `agent.branch.pushed` — emitted by `commitAgentWork` after a
 * coder-class agent completes its work in an isolated worktree, commits all
 * changes, and pushes the branch to origin.  The `pr-merge-manager` (T4.4)
 * subscribes to this topic to open a draft PR.
 */
export interface AgentBranchPushedPayload {
  cycleId: string;
  agentId: string;
  sessionId: string;
  /** Branch that was pushed — e.g. `autonomous/agent-coder-abc123`. */
  branch: string;
  /** The base branch this work was forked from — typically `main`. */
  baseBranch: string;
  /** HEAD sha after the commit. */
  commitSha: string;
  /** Number of files touched (from `git diff --name-only HEAD~1..HEAD`). */
  filesChanged: number;
  /** First 500 chars of `git diff --stat HEAD~1..HEAD`. */
  diffSummary: string;
  /** ISO timestamp when the push completed. */
  pushedAt: string;
  /** Sprint item ids the agent worked on. */
  itemIds: string[];
  /**
   * True when origin remote does not exist (test / local-only repos).
   * When true the branch was committed locally but NOT pushed to a remote.
   */
  localOnly?: boolean;
}

export type AgentBranchPushedEnvelope = MessageEnvelopeV2<AgentBranchPushedPayload>;

/**
 * Payload for `merge-queue.pr.opened` — emitted by `MergeQueue` after a draft
 * PR is opened (or recorded in dry-run/skip modes) for an agent branch.
 */
export interface MergeQueuePrOpenedPayload {
  cycleId: string;
  agentId: string;
  branch: string;
  prNumber: number | null;
  status: 'open' | 'dry-run' | 'skipped-no-gh' | 'merged';
  prUrl: string | null;
  openedAt: string;
}

export type MergeQueuePrOpenedEnvelope = MessageEnvelopeV2<MergeQueuePrOpenedPayload>;

export function isCommsTopic(topic: MessageTopic): boolean {
  return topic === 'agent.dm.sent' || topic === 'inbox.message.created';
}

export function isQualityTopic(topic: MessageTopic): boolean {
  return topic === 'gate.verdict.created' || topic === 'review.finding.created';
}

export function isWorktreeTopic(topic: MessageTopic): boolean {
  return topic === 'agent.branch.pushed' || topic === 'merge-queue.pr.opened';
}

export function isSelfModificationTopic(topic: MessageTopic): boolean {
  return topic === 'self-modification.canary.staged'
    || topic === 'self-modification.canary.promoted'
    || topic === 'self-modification.canary.rolled_back';
}
