/** Agent Version Pinning types */

export interface AgentVersionRecord {
  /** Unique version record ID */
  id: string;
  /** The agent this version belongs to */
  agentId: string;
  /** Semantic version string e.g. "1.0.0" */
  version: string;
  /** Serialized agent configuration snapshot */
  config: Record<string, unknown>;
  /** Human-readable release notes or change description */
  notes?: string;
  /** ISO timestamp when this version was recorded */
  recordedAt: string;
}

export interface PinnedVersion {
  /** The agent ID */
  agentId: string;
  /** The version record ID that is currently pinned */
  pinnedVersionId: string;
  /** ISO timestamp when the pin was set */
  pinnedAt: string;
}

export interface VersionHistory {
  /** The agent ID */
  agentId: string;
  /** All recorded versions, newest first */
  versions: AgentVersionRecord[];
  /** Currently pinned version record ID, if any */
  pinnedVersionId: string | null;
}
