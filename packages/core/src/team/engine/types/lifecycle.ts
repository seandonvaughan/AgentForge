/**
 * AgentForge — Agent Identity Hub Type Definitions
 *
 * Core types for the Agent Lifecycle Manager system:
 * agent identity, team units, career progression, skill profiles,
 * institutional knowledge, execution slots, and hiring recommendations.
 */

import type { AutonomyTier } from "./v4-api.js";
import type { ModelTier } from "./agent.js";

// ---------------------------------------------------------------------------
// § 1 — Enumerations
// ---------------------------------------------------------------------------

/** Organizational role within the team hierarchy. */
export type AgentRole = "executive" | "manager" | "tech_lead" | "specialist";

/** Seniority level determining task complexity routing and concurrency cap. */
export type SeniorityLevel = "junior" | "mid" | "senior" | "lead" | "principal";

/** Technical layer a team or agent belongs to. */
export type TechnicalLayer =
  | "frontend"
  | "backend"
  | "infra"
  | "data"
  | "platform"
  | "qa"
  | "research"
  | "executive";

/** Runtime status of an agent in the lifecycle manager. */
export type AgentStatus =
  | "active"
  | "idle"
  | "multitasking"
  | "suspended"
  | "terminated";

// ---------------------------------------------------------------------------
// § 2 — Agent Identity
// ---------------------------------------------------------------------------

/**
 * Unified identity for every agent in the system.
 * Single source of truth managed by AgentLifecycleManager.
 */
export interface AgentIdentity {
  /** Unique agent identifier, e.g. "backend-senior-coder-1". */
  id: string;
  /** Display name, e.g. "Senior Coder". */
  name: string;
  /** Organizational role. */
  role: AgentRole;
  /** Seniority level — determines task routing and concurrency. */
  seniority: SeniorityLevel;
  /** Technical layer this agent belongs to. */
  layer: TechnicalLayer;
  /** ID of the team this agent is a member of. */
  teamId: string;
  /** Model tier assignment. */
  model: ModelTier;
  /** Current runtime status. */
  status: AgentStatus;
  /** ISO-8601 timestamp of when this agent was hired (created). */
  hiredAt: string;
  /** IDs of tasks currently being worked on. */
  currentTasks: string[];
  /** Maximum number of concurrent tasks, derived from seniority + autonomy. */
  maxConcurrentTasks: number;
}

// ---------------------------------------------------------------------------
// § 3 — Team Unit
// ---------------------------------------------------------------------------

/**
 * A team unit — a group of agents organized by technical layer,
 * mirroring a real engineering team structure.
 */
export interface TeamUnit {
  /** Unique team identifier, e.g. "backend-team". */
  id: string;
  /** Technical layer this team covers. */
  layer: TechnicalLayer;
  /** Agent ID of the engineering manager. */
  manager: string;
  /** Agent ID of the tech lead. */
  techLead: string;
  /** Agent IDs of team specialists. */
  specialists: string[];
  /** Maximum number of specialists allowed. */
  maxCapacity: number;
  /** Count of active tasks across all team members. */
  currentLoad: number;
  /** Domain specializations, e.g. ["api", "database", "auth"]. */
  domain: string[];
}

// ---------------------------------------------------------------------------
// § 4 — Task Memory (Short-term)
// ---------------------------------------------------------------------------

/**
 * Structured summary of a completed task, stored per agent.
 * Provides experiential context for future runs.
 */
export interface TaskMemory {
  /** Unique task identifier. */
  taskId: string;
  /** ISO-8601 timestamp of completion. */
  timestamp: string;
  /** What the task aimed to accomplish. */
  objective: string;
  /** How the agent approached the task. */
  approach: string;
  /** Task outcome. */
  outcome: "success" | "partial" | "failure";
  /** Patterns, mistakes, or insights extracted. */
  lessonsLearned: string[];
  /** File paths modified during the task. */
  filesModified: string[];
  /** Agent IDs of collaborators. */
  collaborators: string[];
  /** Self-assessed difficulty 1-5. */
  difficulty: number;
  /** Tokens consumed during the task. */
  tokensUsed: number;
}

// ---------------------------------------------------------------------------
// § 5 — Skill Profile (Medium-term)
// ---------------------------------------------------------------------------

/**
 * An agent's proficiency in a specific skill, tracked over time.
 */
export interface SkillLevel {
  /** Skill identifier. */
  name: string;
  /** Proficiency level 1-5 (Novice → Master). */
  level: number;
  /** Number of times this skill has been exercised. */
  exerciseCount: number;
  /** Success rate across all exercises (0.0-1.0). */
  successRate: number;
  /** ISO-8601 timestamp of last exercise. */
  lastExercised: string;
  /** Capabilities unlocked at this level. */
  unlockedCapabilities: string[];
}

/**
 * Complete skill profile for an agent.
 */
export interface SkillProfile {
  /** Agent this profile belongs to. */
  agentId: string;
  /** Map of skill name → skill level data. */
  skills: Record<string, SkillLevel>;
}

/** Skill level-up thresholds. */
export const SKILL_LEVEL_THRESHOLDS: Record<number, { minExercises: number; minSuccessRate: number }> = {
  2: { minExercises: 5, minSuccessRate: 0.70 },
  3: { minExercises: 15, minSuccessRate: 0.80 },
  4: { minExercises: 30, minSuccessRate: 0.85 },
  5: { minExercises: 50, minSuccessRate: 0.90 },
};

/** Human-readable skill level names. */
export const SKILL_LEVEL_NAMES: Record<number, string> = {
  1: "Novice",
  2: "Competent",
  3: "Proficient",
  4: "Expert",
  5: "Master",
};

// ---------------------------------------------------------------------------
// § 6 — Institutional Knowledge (Long-term)
// ---------------------------------------------------------------------------

/** Category of institutional knowledge. */
export type KnowledgeCategory = "convention" | "pattern" | "decision" | "pitfall" | "domain_fact";

/**
 * A piece of team-scoped institutional knowledge that persists across sessions.
 */
export interface KnowledgeEntry {
  /** Unique entry identifier. */
  id: string;
  /** Team this knowledge belongs to. */
  teamId: string;
  /** Classification of the knowledge. */
  category: KnowledgeCategory;
  /** The knowledge content itself. */
  content: string;
  /** Agent or task that discovered this knowledge. */
  source: string;
  /** Confidence score 0.0-1.0, decays when contradicted. */
  confidence: number;
  /** File paths or PR IDs that reference this knowledge. */
  references: string[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last validation. */
  lastValidated: string;
}

// ---------------------------------------------------------------------------
// § 7 — Career Record
// ---------------------------------------------------------------------------

/** Types of career events tracked. */
export type CareerEventType = "hired" | "promoted" | "demoted" | "reassigned" | "trained" | "terminated";

/**
 * A single career event in an agent's history.
 */
export interface CareerEvent {
  /** Unique event identifier. */
  id: string;
  /** Agent this event belongs to. */
  agentId: string;
  /** Type of career event. */
  eventType: CareerEventType;
  /** Event-specific details (JSON-serializable). */
  details: Record<string, unknown>;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/**
 * Performance metrics for an agent, updated after each task.
 */
export interface PerformanceMetrics {
  /** Total tasks completed. */
  tasksCompleted: number;
  /** Overall success rate (0.0-1.0). */
  successRate: number;
  /** Average task duration in milliseconds. */
  avgTaskDuration: number;
  /** Average score from peer reviews (0.0-1.0). */
  peerReviewScore: number;
  /** Number of junior agents mentored. */
  mentorshipCount: number;
}

/**
 * Complete career record for an agent — single source of truth
 * for experience, skills, and performance.
 */
export interface AgentCareerRecord {
  /** Agent this record belongs to. */
  agentId: string;
  /** ISO-8601 timestamp of hire date. */
  hiredAt: string;
  /** Current team membership. */
  currentTeam: string;
  /** Current organizational role. */
  currentRole: AgentRole;
  /** Current seniority level. */
  seniority: SeniorityLevel;
  /** Current autonomy tier (from AutonomyGovernor). */
  autonomyTier: AutonomyTier;
  /** Living skill profile. */
  skillProfile: SkillProfile;
  /** Rolling window of recent task memories (last 50). */
  taskHistory: TaskMemory[];
  /** Full career event log. */
  careerEvents: CareerEvent[];
  /** Aggregated performance metrics. */
  performanceMetrics: PerformanceMetrics;
}

// ---------------------------------------------------------------------------
// § 8 — Execution Slots (Parallel Execution)
// ---------------------------------------------------------------------------

/**
 * An execution slot representing one parallel work stream for an agent.
 */
export interface ExecutionSlot {
  /** Unique slot identifier. */
  slotId: string;
  /** Agent this slot belongs to. */
  agentId: string;
  /** Task being executed in this slot. */
  taskId: string;
  /** Current slot status. */
  status: "active" | "completed" | "failed";
  /** Isolated context for this slot's execution. */
  contextSnapshot: {
    /** Task memories relevant to this specific task. */
    taskMemories: TaskMemory[];
    /** Team knowledge (shared, read-only across slots). */
    teamKnowledge: KnowledgeEntry[];
    /** Files this slot is working with. */
    workingFiles: string[];
  };
  /** ISO-8601 timestamp of slot creation. */
  startedAt: string;
  /** ISO-8601 timestamp of slot completion. */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// § 9 — Hiring Recommendations
// ---------------------------------------------------------------------------

/** Status of a hiring recommendation. */
export type HiringStatus = "pending" | "approved" | "denied";

/**
 * A hiring recommendation generated by TeamScaler or requested by an executive.
 */
export interface HiringRecommendation {
  /** Unique recommendation identifier. */
  id: string;
  /** Team the hire is recommended for. */
  teamId: string;
  /** Recommended role. */
  requestedRole: AgentRole;
  /** Recommended seniority. */
  requestedSeniority: SeniorityLevel;
  /** Skills the hire should have. */
  requestedSkills: string[];
  /** Why this hire is needed. */
  justification: string;
  /** Current status. */
  status: HiringStatus;
  /** Agent who requested the hire. */
  requestedBy: string;
  /** Agent who approved/denied. */
  decidedBy?: string;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of decision. */
  decidedAt?: string;
}

// ---------------------------------------------------------------------------
// § 10 — Seniority Configuration
// ---------------------------------------------------------------------------

/** Maps seniority to its capabilities and constraints. */
export interface SeniorityConfig {
  /** Maximum concurrent tasks at this seniority. */
  maxConcurrentTasks: number;
  /** Default model tier. */
  defaultModel: ModelTier;
  /** Minimum autonomy tier required. */
  minAutonomyTier: AutonomyTier;
  /** Number of task memories provided as context. */
  contextWindowSize: number;
}

/** Seniority ladder configuration. */
export const SENIORITY_CONFIG: Record<SeniorityLevel, SeniorityConfig> = {
  junior: {
    maxConcurrentTasks: 1,
    defaultModel: "haiku",
    minAutonomyTier: 1 as AutonomyTier,
    contextWindowSize: 10,
  },
  mid: {
    maxConcurrentTasks: 2,
    defaultModel: "sonnet",
    minAutonomyTier: 2 as AutonomyTier,
    contextWindowSize: 20,
  },
  senior: {
    maxConcurrentTasks: 3,
    defaultModel: "sonnet",
    minAutonomyTier: 3 as AutonomyTier,
    contextWindowSize: 20,
  },
  lead: {
    maxConcurrentTasks: 3,
    defaultModel: "opus",
    minAutonomyTier: 3 as AutonomyTier,
    contextWindowSize: 50,
  },
  principal: {
    maxConcurrentTasks: 2,
    defaultModel: "opus",
    minAutonomyTier: 4 as AutonomyTier,
    contextWindowSize: 50,
  },
};

// ---------------------------------------------------------------------------
// § 11 — Executive Tool Types
// ---------------------------------------------------------------------------

/** Tool permission scoped to a specific executive role. */
export interface ExecutiveToolPermission {
  /** Role required to invoke this tool. */
  requiredRole: AgentRole;
  /** Specific agent ID required (e.g., "ceo"). Null means any agent with the role. */
  requiredAgentId?: string;
  /** Minimum seniority required. */
  minSeniority: SeniorityLevel;
}

/**
 * An executive tool definition — an invocable action
 * available to specific executive roles.
 */
export interface ExecutiveTool {
  /** Unique tool name, e.g. "ceo.createSprint". */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Permission requirements. */
  permission: ExecutiveToolPermission;
  /** Tool category for organization. */
  category: "strategic" | "operational" | "financial" | "personnel" | "technical";
}
