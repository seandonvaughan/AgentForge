/**
 * AgentForge v4 — Integration API Contract
 *
 * Sprint 1.0 deliverable: the stable internal API contract that all v4 pillars
 * build against. All message envelopes, status file schemas, bus topic
 * conventions, and registry entry formats are defined here.
 *
 * Versioning: semver. Interfaces marked @stable are covered by the v4 API
 * stability guarantee. Interfaces marked @experimental may change without notice.
 * All interfaces are backward-compatible with v3.2 types unless explicitly noted.
 */

// ---------------------------------------------------------------------------
// § 1 — Enumerations
// ---------------------------------------------------------------------------

/**
 * Four-tier autonomy system for the self-improvement flywheel.
 * Agents are promoted/demoted based on proposal acceptance rate.
 * @stable
 */
export enum AutonomyTier {
  /** Tier 1 — Supervised. All actions require explicit approval. Default for new agents. */
  Supervised = 1,
  /** Tier 2 — Assisted. Low-risk actions auto-approved; medium-risk require COO sign-off. */
  Assisted = 2,
  /** Tier 3 — Autonomous. All actions auto-approved except REFORGE class changes. */
  Autonomous = 3,
  /** Tier 4 — Strategic. Full authority including REFORGE; reserved for Opus-tier agents. */
  Strategic = 4,
}

/** Current runtime state of an agent process. @stable */
export type AgentState =
  | "idle"       // Registered but not processing anything
  | "active"     // Processing a task
  | "busy"       // At capacity — not accepting new tasks
  | "suspended"  // Serialized to disk, awaiting resume
  | "offline";   // Status file stale beyond heartbeat TTL

/** Priority levels for bus messages. Supersedes v3.2 MessagePriority. @stable */
export type V4MessagePriority = "urgent" | "high" | "normal" | "low";

/**
 * Semantic category of a bus message — determines routing and display tier.
 * @stable
 */
export type MessageCategory =
  | "task"        // Work assignment
  | "result"      // Task completion report
  | "status"      // State change notification
  | "escalation"  // Requires supervisor attention
  | "decision"    // Approval request or decision record
  | "direct"      // Point-to-point (agent→agent or user→agent)
  | "meeting"     // Meeting orchestration event
  | "review"      // Review lifecycle event
  | "memory"      // Knowledge base access
  | "reforge";    // Self-improvement proposal or application

/**
 * Hint to the feed renderer about how verbosely to display a message.
 * @stable
 */
export type DisplayTierHint = "full" | "oneliner" | "marker" | "silent";

/** Six-state machine for document/code review lifecycle. @stable */
export type ReviewStatus =
  | "pending"      // Submitted, awaiting assignment
  | "assigned"     // Reviewer selected, not yet started
  | "in_review"    // Reviewer is actively reviewing
  | "responded"    // Reviewer submitted feedback
  | "resolved"     // Author acknowledged and addressed feedback
  | "approved";    // Final approval granted

/**
 * Memory category determines decay rate and retrieval priority.
 * @stable
 */
export type MemoryCategory =
  | "learning"      // Pattern learned from task outcomes
  | "research"      // External knowledge acquired via research
  | "mistake"       // Error record with corrective action
  | "preference"    // User or team preference
  | "relationship"  // Agent-to-agent collaboration data
  | "context"       // Short-term task context
  | "capability"    // Acquired skill or proficiency data
  | "metric";       // Performance measurement

/** Top-level domain grouping for bus topics. @stable */
export type TopicDomain =
  | "agent"
  | "review"
  | "meeting"
  | "memory"
  | "reforge"
  | "escalation"
  | "system";

/** Permission level required to invoke a registered tool. @stable */
export type ToolPermission =
  | "public"    // Any agent can invoke
  | "team"      // Any agent in the same team
  | "supervisor" // Requires supervisor role
  | "opus";     // Opus-tier agents only

// ---------------------------------------------------------------------------
// § 2 — Message Envelope
// ---------------------------------------------------------------------------

/**
 * Generic typed message envelope for all TeamModeBus communication.
 *
 * TPayload is the domain-specific payload type. Consumers should narrow
 * using the `category` field before accessing `payload`.
 *
 * @stable
 */
export interface MessageEnvelope<TPayload = unknown> {
  /** UUID v4 — globally unique message identifier. */
  id: string;
  /** SemVer of the envelope format. Current: "4.0". */
  version: string;
  /** ISO-8601 timestamp when the message was created. */
  timestamp: string;
  /** Formatted agent address: "agent:{name}" or "conduit:user". */
  from: string;
  /** Formatted agent address or broadcast topic. */
  to: string;
  /** Fully-qualified bus topic, e.g. "agent.task.assign". */
  topic: string;
  /** Semantic category for routing and display. */
  category: MessageCategory;
  /** Message priority — affects queue position and display tier. */
  priority: V4MessagePriority;
  /** Domain-specific payload. Type depends on `topic`. */
  payload: TPayload;
  /** ID of the message this is replying to, if any. */
  replyTo?: string;
  /** Shared ID for a multi-turn conversation thread. */
  conversationId?: string;
  /** ISO-8601 expiry — message is discarded if not delivered by this time. */
  ttl?: string;
  /** Hint to the feed renderer. Overrides automatic tier calculation. */
  displayTierHint?: DisplayTierHint;
  /** Arbitrary metadata for middleware and debugging. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// § 3 — Bus Topic Payload Contracts
// ---------------------------------------------------------------------------

/** Payload for "agent.task.assign" @stable */
export interface TaskAssignPayload {
  taskId: string;
  description: string;
  context: string;
  filesInScope: string[];
  budgetUsd?: number;
  deadlineIso?: string;
  businessRationale?: string;
  acceptableTradeoffs?: string;
}

/** Payload for "agent.task.result" @stable */
export interface TaskResultPayload {
  taskId: string;
  success: boolean;
  summary: string;
  artifacts?: string[];   // File paths produced
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
}

/** Payload for "agent.status.update" @stable */
export interface AgentStatusPayload {
  agentId: string;
  previousState: AgentState;
  currentState: AgentState;
  activeTaskId?: string;
  reason?: string;
}

/** Payload for "review.lifecycle.*" topics @stable */
export interface ReviewLifecyclePayload {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  status: ReviewStatus;
  reviewerAgentId?: string;
  verdict?: "approve" | "request_changes" | "block";
  commentFile?: string;  // Path to .agentforge/reviews/*/comments/{agent}.md
  previousStatus?: ReviewStatus;
}

/** Payload for "meeting.coordination.*" topics @stable */
export interface MeetingCoordinationPayload {
  meetingId: string;
  agenda: string;
  participants: string[];   // Agent addresses
  scheduledAt?: string;     // ISO-8601
  durationMinutes?: number;
  priority: V4MessagePriority;
  status: "requested" | "scheduled" | "active" | "completed" | "cancelled";
  queuePosition?: number;   // Set when meeting is queued (at 3-meeting cap)
}

/** Payload for "memory.query" @stable */
export interface MemoryQueryPayload {
  queryId: string;
  query: string;
  categories?: MemoryCategory[];
  similarityThreshold?: number;  // Default 0.82 from persistence-lead spec
  maxResults?: number;
  agentId: string;
}

/** Payload for "memory.result" @stable */
export interface MemoryResultPayload {
  queryId: string;
  results: MemoryHit[];
  totalFound: number;
  searchDurationMs: number;
}

export interface MemoryHit {
  entryId: string;
  category: MemoryCategory;
  content: string;
  relevanceScore: number;  // 0.0–1.0 cosine similarity
  createdAt: string;
  lastAccessedAt: string;
  ownerAgentId: string;
}

/** Payload for "reforge.propose" @stable */
export interface ReforgeProposalPayload {
  proposalId: string;
  agentId: string;           // Agent proposing the REFORGE
  targetAgentId: string;     // Agent to be modified
  proposalType: "prompt_edit" | "skill_add" | "skill_remove" | "model_change" | "constraint_add";
  rationale: string;
  evidenceTaskIds: string[];  // Tasks that motivated this proposal
  proposedChange: string;     // Human-readable description
  expectedOutcome: string;
  riskLevel: "low" | "medium" | "high";
  estimatedCostUsd?: number;
}

/** Payload for "reforge.approve" @stable */
export interface ReforgeApprovalPayload {
  proposalId: string;
  approvedBy: string;     // Agent address of approver
  approvalTier: AutonomyTier;
  approved: boolean;
  rejectionReason?: string;
  conditions?: string[];  // Conditions attached to conditional approval
}

/** Payload for "reforge.apply" @stable */
export interface ReforgeApplicationPayload {
  proposalId: string;
  gitTagBefore: string;    // reforge/v4/{timestamp}-{opId}
  gitTagAfter?: string;    // Set after successful application
  success: boolean;
  rollbackAvailable: boolean;
  changedFiles: string[];
  verificationResult?: string;
}

/** Payload for "escalation.*" topics @stable */
export interface EscalationPayload {
  escalationId: string;
  originAgentId: string;
  supervisorAgentId: string;
  issueDescription: string;
  urgency: V4MessagePriority;
  blockedTaskId?: string;
  proposedResolutions?: string[];
  timeoutIso?: string;   // If not resolved by this time, escalate further
}

// ---------------------------------------------------------------------------
// § 4 — Status File Schema (Agent-Owned)
// ---------------------------------------------------------------------------

/**
 * Schema for agent-owned status files: /.forge/status/{agent-id}.json
 *
 * Each agent is the sole writer of its own status file. Any agent or
 * coordinator may read any status file. No locking required for reads.
 * Writers use flock(2) advisory locks to prevent partial writes.
 *
 * @stable
 */
export interface AgentStatusFile {
  /** Schema version. Current: "4.0". */
  schemaVersion: string;
  /** Stable agent identifier matching .agentforge/agents/{id}.yaml. */
  agentId: string;
  /** Display name. */
  agentName: string;
  /** Model tier: "opus" | "sonnet" | "haiku". */
  modelTier: string;
  /** Autonomy tier 1-4. */
  autonomyTier: AutonomyTier;
  /** Current runtime state. */
  state: AgentState;
  /** ISO-8601 timestamp of last status file write. Stale if >2 minutes old. */
  heartbeatAt: string;
  /** ISO-8601 timestamp of agent process start. */
  startedAt: string;
  /** Active task, if any. */
  activeTask?: {
    taskId: string;
    description: string;
    startedAt: string;
    progressPercent?: number;
    estimatedCompleteAt?: string;
  };
  /** Skills this agent has, with proficiency. */
  capabilities: AgentCapabilityEntry[];
  /** Additional runtime metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// § 5 — Registry Entry Formats
// ---------------------------------------------------------------------------

/**
 * Base fields shared by all registry entries.
 * @stable
 */
interface RegistryEntryBase {
  /** Unique identifier within the registry. */
  id: string;
  /** SemVer of this entry's schema. */
  version: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
  /** Agent that owns and is responsible for this entry. */
  ownerAgentId: string;
  /** Whether this entry is currently active. */
  active: boolean;
}

/**
 * Tool registry entry — describes a callable tool available to agents.
 * Stored in /.forge/registry/tools/{id}.json
 * @stable
 */
export interface ToolRegistryEntry extends RegistryEntryBase {
  type: "tool";
  /** Human-readable tool name. */
  name: string;
  /** What the tool does. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's output. */
  outputSchema: Record<string, unknown>;
  /** Required permission level to invoke this tool. */
  permission: ToolPermission;
  /** How this tool is provisioned: "mcp" | "subprocess" | "inline". */
  provisioningMode: "mcp" | "subprocess" | "inline";
  /** MCP server ID if provisioningMode is "mcp". */
  mcpServerId?: string;
  /** Subprocess command if provisioningMode is "subprocess". */
  command?: string[];
  /** Estimated cost per invocation in USD, if known. */
  estimatedCostUsd?: number;
}

/**
 * Memory registry entry — tracks a persisted memory artifact.
 * Stored in /.forge/registry/memory/{id}.json
 * @stable
 */
export interface MemoryRegistryEntry extends RegistryEntryBase {
  type: "memory";
  /** Semantic category. */
  category: MemoryCategory;
  /** Content summary (not the full content — use the content store). */
  summary: string;
  /** Path to the full memory content file. */
  contentPath: string;
  /** Relevance score 0.0–1.0, decaying over time. */
  relevanceScore: number;
  /** Decay rate per day (0.0 = no decay, 1.0 = fully decays in one day). */
  decayRatePerDay: number;
  /** ISO-8601 timestamp of last access (resets decay clock). */
  lastAccessedAt: string;
  /** ISO-8601 expiry — entry is archived at this time. null = never expires. */
  expiresAt: string | null;
  /** Tags for keyword fallback search. */
  tags: string[];
}

/**
 * Agent capability entry — records a skill an agent has demonstrated.
 * Embedded in AgentStatusFile and also stored in /.forge/registry/capabilities/{agentId}/{skillId}.json
 * @stable
 */
export interface AgentCapabilityEntry {
  /** Skill identifier, e.g. "typescript_type_design". */
  skillId: string;
  /** Human-readable skill name. */
  skillName: string;
  /** Proficiency 0.0–1.0. Updated by meta-learning engine. */
  proficiency: number;
  /** Number of tasks this skill was exercised in. */
  exerciseCount: number;
  /** Success rate across all exercises (successes / exerciseCount). */
  successRate: number;
  /** ISO-8601 timestamp when this skill was first recorded. */
  learnedAt: string;
  /** Agent this skill was propagated from, if via capability inheritance. */
  sourceAgentId?: string;
  /** Whether this agent explicitly opted in to receiving this skill. */
  inheritedViaOptIn?: boolean;
}

/**
 * Role registry entry — maps an organizational role to an agent.
 * Stored in /.forge/registry/roles/{roleId}.json
 * @stable
 */
export interface RoleRegistryEntry extends RegistryEntryBase {
  type: "role";
  /** Role identifier, e.g. "cto" | "architect". */
  roleId: string;
  /** Display name for this role. */
  roleName: string;
  /** Agent currently holding this role. */
  agentId: string;
  /** Agent that supervises this role. */
  supervisorAgentId?: string;
  /** ISO-8601 timestamp of role assignment. */
  assignedAt: string;
  /** Previous holder of this role, for audit. */
  previousAgentId?: string;
  /** Reason for role assignment or reassignment. */
  assignmentReason?: string;
}

// ---------------------------------------------------------------------------
// § 6 — Org-Graph Types
// ---------------------------------------------------------------------------

/**
 * A node in the organization DAG.
 * @stable
 */
export interface OrgNode {
  agentId: string;
  roleId: string;
  supervisorAgentId: string | null;   // null for root (CEO)
  directReportIds: string[];
  peerAgentIds: string[];
  /** Delegation authority: which roles this agent can delegate to. */
  canDelegateTo: string[];
}

/**
 * A delegation context envelope — wraps any task assignment with
 * the business rationale and constraints the delegatee needs.
 * @stable
 */
export interface DelegationContext {
  taskId: string;
  delegatorAgentId: string;
  delegateeAgentId: string;
  /** Why this task matters to the business. */
  businessRationale: string;
  /** Constraints the delegatee must respect. */
  constraints: string[];
  /** Trade-offs the delegator considers acceptable. */
  acceptableTradeoffs: string[];
  /** Expected deliverable format. */
  expectedOutput: string;
  budgetUsd?: number;
  deadlineIso?: string;
}

// ---------------------------------------------------------------------------
// § 7 — Flywheel Metric Types (Pillar 5)
// ---------------------------------------------------------------------------

/**
 * Sprint-level velocity record for the compounding improvement flywheel.
 * Velocity ratio = this sprint's output / previous sprint's output.
 * Ratio > 1.05 = on track. Ratio < 1.0 = deceleration alert.
 * @experimental
 */
export interface SprintVelocityRecord {
  sprintId: string;
  completedAt: string;
  tasksCompleted: number;
  tokensConsumed: number;
  costUsd: number;
  /** Normalized output units (tasks / $1 spent). */
  outputPerDollar: number;
  /** Ratio vs. previous sprint. Null for first sprint. */
  velocityRatio: number | null;
  /** Whether this sprint triggered a velocity alert (ratio < 1.0). */
  decelerationAlert: boolean;
}

/**
 * Meta-learning pattern extracted from cross-task analysis.
 * @experimental
 */
export interface LearnedPattern {
  patternId: string;
  discoveredAt: string;
  discoveredByAgentId: string;
  /** Human-readable description of the pattern. */
  description: string;
  /** Tasks that provided evidence for this pattern. */
  evidenceTaskIds: string[];
  /** Confidence 0.0–1.0. */
  confidence: number;
  /** Whether this pattern has been validated by a supervisor. */
  validated: boolean;
  /** Agents that have received this pattern via capability inheritance. */
  propagatedToAgentIds: string[];
}

// ---------------------------------------------------------------------------
// § 8 — Versioning Manifest
// ---------------------------------------------------------------------------

/**
 * API version manifest — describes which interfaces are stable vs experimental.
 * Served at /.forge/api-version.json
 * @stable
 */
export interface ApiVersionManifest {
  /** SemVer of the v4 API. Breaking changes bump major. */
  apiVersion: string;
  /** ISO-8601 effective date. */
  effectiveDate: string;
  /** Interfaces guaranteed stable for this major version. */
  stableInterfaces: string[];
  /** Interfaces that may change without notice. */
  experimentalInterfaces: string[];
  /** Deprecated v3.2 interfaces and their v4 replacements. */
  deprecations: Array<{
    v3Interface: string;
    v4Replacement: string;
    removalVersion: string;
  }>;
}

// ---------------------------------------------------------------------------
// § 9 — v3.2 Compatibility
// ---------------------------------------------------------------------------

/**
 * v3.2 AutonomyLevel is still valid; v4 extends it with AutonomyTier.
 * AutonomyLevel maps to AutonomyTier as follows:
 *   "full"       → AutonomyTier.Strategic (4)
 *   "supervised" → AutonomyTier.Assisted  (2)
 *   "guided"     → AutonomyTier.Supervised (1)
 */
export type AutonomyLevelCompat = "full" | "supervised" | "guided";

export function autonomyLevelToTier(level: AutonomyLevelCompat): AutonomyTier {
  switch (level) {
    case "full":       return AutonomyTier.Strategic;
    case "supervised": return AutonomyTier.Assisted;
    case "guided":     return AutonomyTier.Supervised;
  }
}

export function tierToAutonomyLevel(tier: AutonomyTier): AutonomyLevelCompat {
  if (tier >= AutonomyTier.Autonomous) return "full";
  if (tier >= AutonomyTier.Assisted)   return "supervised";
  return "guided";
}
