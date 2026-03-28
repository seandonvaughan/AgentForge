import { nowIso } from '@agentforge/shared';

export interface PoolSlot {
  agentId: string;
  taskId: string;
  startedAt: string;
  branchName?: string;
}

/**
 * AgentPool — tracks concurrent agent invocations.
 * Enforces max parallelism ceiling and queues excess work.
 */
export class AgentPool {
  private active = new Map<string, PoolSlot>();
  private queue: Array<{ resolve: () => void; agentId: string; taskId: string }> = [];
  readonly maxConcurrent: number;

  constructor(maxConcurrent = 20) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Acquire a pool slot. Waits if at ceiling. Returns a release function. */
  async acquire(agentId: string, taskId: string): Promise<() => void> {
    const slotKey = `${agentId}:${taskId}`;

    if (this.active.size < this.maxConcurrent) {
      this.active.set(slotKey, { agentId, taskId, startedAt: nowIso() });
      return () => this._release(slotKey);
    }

    // Queue until a slot opens
    await new Promise<void>(resolve => {
      this.queue.push({ resolve, agentId, taskId });
    });

    this.active.set(slotKey, { agentId, taskId, startedAt: nowIso() });
    return () => this._release(slotKey);
  }

  private _release(slotKey: string): void {
    this.active.delete(slotKey);
    const next = this.queue.shift();
    if (next) next.resolve();
  }

  activeCount(): number { return this.active.size; }
  queueDepth(): number { return this.queue.length; }
  listActive(): PoolSlot[] { return Array.from(this.active.values()); }
  isAtCeiling(): boolean { return this.active.size >= this.maxConcurrent; }
}
