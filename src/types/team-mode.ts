// src/types/team-mode.ts
import type { MessagePriority } from "./message.js";
import type { TeamManifest } from "./team.js";
import type { AgentTemplate } from "./agent.js";

// Imported from orchestrator to avoid circular deps — re-declared here for portability
export interface TeamSessionConfig {
  projectRoot: string;
  sessionBudgetUsd: number;
  enableReforge?: boolean;
  enableCostAwareRouting?: boolean;
  enableReviewEnforcement?: boolean;
}

// --- Lifecycle ---

export type TeamModeState =
  | "inactive"
  | "activating"
  | "active"
  | "hibernating"
  | "hibernated"
  | "deactivating";

// --- Autonomy ---

export type AutonomyLevel = "full" | "supervised" | "guided";

// --- Addressing ---

export type AddressType = "agent" | "conduit";

export interface AgentAddress {
  type: AddressType;
  name: string;
}

export function createAddress(type: AddressType, name: string): AgentAddress {
  return { type, name };
}

export function formatAddress(address: AgentAddress): string {
  return `${address.type}:${address.name}`;
}

export function parseAddress(raw: string): AgentAddress | null {
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const [type, name] = parts;
  if (type !== "agent" && type !== "conduit") return null;
  if (!name) return null;
  return { type, name };
}

export const USER_CONDUIT: AgentAddress = { type: "conduit", name: "user" };

// --- Messages ---

export type TeamModeMessageType =
  | "task"
  | "result"
  | "escalation"
  | "decision"
  | "status"
  | "direct";

export interface TeamModeMessage {
  id: string;
  from: string;       // formatted address
  to: string;         // formatted address
  type: TeamModeMessageType;
  content: string;
  priority: MessagePriority;
  timestamp: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

// --- Feed ---

export interface FeedEntry {
  timestamp: string;
  source: string;
  target?: string;
  type: TeamModeMessageType;
  summary: string;
  content: string;
  cost?: number;
}

export type FeedDisplayTier = "full" | "oneliner" | "marker" | "silent";

// --- Configuration ---

export interface TeamModeConfig {
  sessionConfig: TeamSessionConfig;
  autonomyLevel?: AutonomyLevel;
  teamManifest: TeamManifest;
  agentTemplates: Map<string, AgentTemplate>;
}

// --- Hibernation ---

export interface HibernatedSession {
  sessionId: string;
  autonomyLevel: AutonomyLevel;
  hibernatedAt: string;
  projectRoot: string;
  teamManifest: TeamManifest;
  feedEntries: FeedEntry[];
  gitCommitAtHibernation: string;
  sessionBudgetUsd: number;
  spentUsd: number;
}