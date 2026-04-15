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
  // Plugin
  | 'plugin.event';

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
  return topic.startsWith('system.') || topic.startsWith('bus.');
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
