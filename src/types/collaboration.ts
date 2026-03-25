/**
 * Collaboration type definitions for the AgentForge v2 Universal Forge.
 *
 * Defines reusable topology patterns that control how agents relate,
 * delegate, communicate, and escalate across domains.
 */

/**
 * Describes the spatial arrangement of agents — who is at the root,
 * and how agents are organized into levels with distinct roles.
 */
export interface TopologyDefinition {
  /** The agent at the top of the hierarchy, or null for flat topologies. */
  root: string | null;
  /** Ordered list of agent levels from top to bottom. */
  levels: { agents: string[]; role: string }[];
}

/**
 * Rules governing how delegation flows between agents.
 */
export interface DelegationRules {
  /** Direction delegation is allowed to flow. */
  direction: "top-down" | "peer" | "any";
  /** Whether agents can delegate to agents outside their level. */
  cross_level: boolean;
  /** Whether peer-level agents can collaborate directly. */
  peer_collaboration: boolean;
  /** Direction in which review results flow. */
  review_flow: "bottom-up" | "top-down" | "peer";
}

/**
 * A named checkpoint that must be satisfied before proceeding.
 *
 * Hard gates block execution; soft gates warn but allow continuation.
 */
export interface GateDefinition {
  /** Human-readable gate name. */
  name: string;
  /** Whether this gate blocks (hard) or warns (soft). */
  type: "hard-gate" | "soft-gate";
  /** Description of the condition that must be met. */
  rule: string;
}

/**
 * Configuration for communication patterns and gates between agents.
 */
export interface CommunicationConfig {
  /** Named communication patterns in use (e.g. "request-response", "broadcast"). */
  patterns: string[];
  /** Gates that govern communication flow. */
  gates: GateDefinition[];
}

/**
 * Configuration for escalation when an agent or task is stuck.
 */
export interface EscalationConfig {
  /** Maximum number of retries before escalation. */
  max_retries: number;
  /** Agent to escalate to when retries are exhausted. */
  escalate_to: string;
  /** Whether to escalate to a human as a last resort. */
  human_escalation: boolean;
}

/**
 * Iteration limits that prevent infinite loops at key cycle points.
 *
 * When a limit is hit the orchestrator escalates rather than
 * silently continuing.
 */
export interface LoopLimits {
  /** Maximum review-fix-review iterations before escalation. */
  review_cycle: number;
  /** Maximum nested delegation chain length. */
  delegation_depth: number;
  /** Maximum retries with the same agent on the same task. */
  retry_same_agent: number;
  /** Maximum total agent actions per top-level task. */
  total_actions: number;
}

/**
 * A reusable collaboration template that defines how a team of
 * agents is structured, communicates, and handles failures.
 */
export interface CollaborationTemplate {
  /** Template name used as an identifier. */
  name: string;
  /** The topology pattern this template uses. */
  type: "hierarchy" | "flat" | "matrix" | "hub-and-spoke" | "custom";
  /** Human-readable description of this template's purpose. */
  description: string;
  /** Spatial arrangement of agents. */
  topology: TopologyDefinition;
  /** Rules governing delegation flow. */
  delegation_rules: DelegationRules;
  /** Communication patterns and gates. */
  communication: CommunicationConfig;
  /** Escalation behaviour when agents are stuck. */
  escalation: EscalationConfig;
  /** Iteration limits to prevent infinite loops. */
  loop_limits: LoopLimits;
}

/**
 * A team scoped to a single domain within a cross-domain project.
 */
export interface DomainTeam {
  /** The lead agent for this domain's team. */
  lead: string;
  /** Other agents on this domain's team. */
  members: string[];
  /** Utility agents shared by this domain's team. */
  utilities: string[];
  /** The internal topology pattern this domain's team uses. */
  internal_topology: string;
}

/**
 * A directed connection between agents in different domains.
 *
 * Bridges enable cross-domain collaboration by making delegation
 * and communication possible between agents that would otherwise
 * be isolated within their domain.
 */
export interface Bridge {
  /** Agent that initiates the cross-domain communication. */
  from: string;
  /** Target agent(s) in the other domain. */
  to: string | string[];
  /** Why this bridge exists. */
  reason: string;
}

/**
 * The top-level team configuration when multiple domains are active.
 *
 * Composed of per-domain teams connected by bridges under a
 * central coordinator.
 */
export interface CrossDomainTeam {
  /** The overall topology pattern (e.g. "hub-and-spoke"). */
  topology: string;
  /** The central coordinator agent. */
  coordinator: string;
  /** Per-domain team configurations keyed by domain name. */
  teams: Record<string, DomainTeam>;
  /** Cross-domain bridges connecting agents across domain boundaries. */
  bridges: Bridge[];
  /** Utility agents shared across all domains. */
  shared_utilities: string[];
}
