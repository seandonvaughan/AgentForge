/**
 * StorageGovernor — Sprint 3.1b
 *
 * Enforces the 10,000 file hard limit on .forge/ storage.
 * Provides LRU eviction, per-agent quotas, and usage reporting.
 *
 * Warning threshold at 90% triggers proactive alerts.
 * Git archival support via eviction callbacks (future sprint).
 */

export const DEFAULT_FILE_LIMIT = 10_000;
export const WARNING_THRESHOLD_PCT = 90;

interface TrackedFile {
  path: string;
  agentId: string;
  registeredAt: number;   // epoch ms
  lastAccessedAt: number; // epoch ms
}

export interface UsageReport {
  totalFiles: number;
  limit: number;
  usagePct: number;
  nearLimit: boolean;
  perAgent: Record<string, number>;
}

export class StorageGovernor {
  private readonly limit: number;
  private files = new Map<string, TrackedFile>();
  private agentQuotas = new Map<string, number>();

  constructor(limit: number = DEFAULT_FILE_LIMIT) {
    this.limit = limit;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  registerFile(path: string, agentId: string): void {
    if (this.files.has(path)) return; // idempotent

    if (this.files.size >= this.limit) {
      throw new Error(`Storage limit exceeded: ${this.files.size}/${this.limit} files`);
    }

    const quota = this.agentQuotas.get(agentId);
    if (quota !== undefined) {
      const agentCount = this.fileCountForAgent(agentId);
      if (agentCount >= quota) {
        throw new Error(`Agent quota exceeded for "${agentId}": ${agentCount}/${quota} files`);
      }
    }

    const now = Date.now();
    this.files.set(path, { path, agentId, registeredAt: now, lastAccessedAt: now });
  }

  unregisterFile(path: string): void {
    if (!this.files.has(path)) throw new Error(`File "${path}" is not tracked`);
    this.files.delete(path);
  }

  // ---------------------------------------------------------------------------
  // Access tracking
  // ---------------------------------------------------------------------------

  recordAccess(path: string): void {
    const file = this.files.get(path);
    if (file) file.lastAccessedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Counts & capacity
  // ---------------------------------------------------------------------------

  fileCount(): number {
    return this.files.size;
  }

  fileCountForAgent(agentId: string): number {
    let count = 0;
    for (const f of this.files.values()) {
      if (f.agentId === agentId) count++;
    }
    return count;
  }

  canAdd(): boolean {
    return this.files.size < this.limit;
  }

  isNearLimit(): boolean {
    return (this.files.size / this.limit) * 100 >= WARNING_THRESHOLD_PCT;
  }

  // ---------------------------------------------------------------------------
  // LRU eviction
  // ---------------------------------------------------------------------------

  evictLRU(): string {
    if (this.files.size === 0) throw new Error("No files to evict");
    let oldest: TrackedFile | null = null;
    for (const file of this.files.values()) {
      if (!oldest || file.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = file;
      }
    }
    this.files.delete(oldest!.path);
    return oldest!.path;
  }

  evictUntilBelow(target: number): string[] {
    const evicted: string[] = [];
    while (this.files.size > target) {
      evicted.push(this.evictLRU());
    }
    return evicted;
  }

  // ---------------------------------------------------------------------------
  // Quotas
  // ---------------------------------------------------------------------------

  setAgentQuota(agentId: string, maxFiles: number): void {
    this.agentQuotas.set(agentId, maxFiles);
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  getUsageReport(): UsageReport {
    const perAgent: Record<string, number> = {};
    for (const file of this.files.values()) {
      perAgent[file.agentId] = (perAgent[file.agentId] ?? 0) + 1;
    }
    return {
      totalFiles: this.files.size,
      limit: this.limit,
      usagePct: (this.files.size / this.limit) * 100,
      nearLimit: this.isNearLimit(),
      perAgent,
    };
  }
}
