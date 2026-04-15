import type { AgentVersionRecord, PinnedVersion, VersionHistory } from './types.js';

function generateId(): string {
  return `ver_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * AgentVersionManager tracks version history per agent and supports
 * pinning a specific version for rollback/stability.
 */
export class AgentVersionManager {
  private history = new Map<string, AgentVersionRecord[]>();
  private pins = new Map<string, PinnedVersion>();

  /**
   * Record a new version snapshot for an agent.
   */
  recordVersion(
    agentId: string,
    config: Record<string, unknown>,
    notes?: string,
  ): AgentVersionRecord {
    const existing = this.history.get(agentId) ?? [];
    const versionNumber = existing.length + 1;

    const record: AgentVersionRecord = {
      id: generateId(),
      agentId,
      version: `1.${versionNumber}.0`,
      config: { ...config },
      recordedAt: new Date().toISOString(),
      ...(notes ? { notes } : {}),
    };

    this.history.set(agentId, [record, ...existing]);
    return record;
  }

  /**
   * Pin a specific version for an agent.
   * @throws Error if the version record is not found
   */
  pin(agentId: string, versionId: string): PinnedVersion {
    const versions = this.history.get(agentId) ?? [];
    const found = versions.find((v) => v.id === versionId);
    if (!found) {
      throw new Error(`Version ${versionId} not found for agent ${agentId}`);
    }

    const pin: PinnedVersion = {
      agentId,
      pinnedVersionId: versionId,
      pinnedAt: new Date().toISOString(),
    };

    this.pins.set(agentId, pin);
    return pin;
  }

  /**
   * Get the full version history for an agent.
   */
  getHistory(agentId: string): VersionHistory {
    const versions = this.history.get(agentId) ?? [];
    const pin = this.pins.get(agentId);

    return {
      agentId,
      versions,
      pinnedVersionId: pin?.pinnedVersionId ?? null,
    };
  }

  /**
   * Get the currently pinned version for an agent, or null if none.
   */
  getPinned(agentId: string): AgentVersionRecord | null {
    const pin = this.pins.get(agentId);
    if (!pin) return null;

    const versions = this.history.get(agentId) ?? [];
    return versions.find((v) => v.id === pin.pinnedVersionId) ?? null;
  }

  /**
   * Rollback to a specific version by pinning it and returning the record.
   * @throws Error if the version record is not found
   */
  rollback(agentId: string, versionId: string): AgentVersionRecord {
    const versions = this.history.get(agentId) ?? [];
    const found = versions.find((v) => v.id === versionId);
    if (!found) {
      throw new Error(`Version ${versionId} not found for agent ${agentId}`);
    }

    this.pin(agentId, versionId);
    return found;
  }
}
