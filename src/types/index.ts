/**
 * Barrel export for all AgentForge type definitions.
 *
 * Import from "@/types" (or "../types") to access any type
 * without needing to know which sub-module it lives in.
 */

export type {
  ModelTier,
  AgentCategory,
  AgentSkill,
  AgentTriggers,
  AgentCollaboration,
  AgentContext,
  AgentTemplate,
} from "./agent.js";

export type {
  TeamAgents,
  ModelRouting,
  DelegationGraph,
  TeamManifest,
} from "./team.js";

export type {
  ProjectInfo,
  RiskArea,
  CoverageGap,
  RecommendedTeam,
  ProjectAssessment,
} from "./analysis.js";

export type {
  MessageType,
  MessagePriority,
  MessageContext,
  AgentMessage,
} from "./message.js";
