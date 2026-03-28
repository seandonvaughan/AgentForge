import { nowIso } from '@agentforge/shared';

export interface DeadEndRecord {
  taskId: string;
  agentId: string;
  failures: number;
  lastFailureAt: string;
  deprioritized: boolean;
}

export class DeadEndTracker {
  private records: Map<string, DeadEndRecord> = new Map();
  private readonly failureThreshold: number;

  constructor(failureThreshold = 3) {
    this.failureThreshold = failureThreshold;
  }

  /** Record a failure for a task/agent combination. Returns true if deprioritized. */
  recordFailure(taskId: string, agentId: string): boolean {
    const key = `${taskId}::${agentId}`;
    const existing = this.records.get(key);

    const record: DeadEndRecord = {
      taskId,
      agentId,
      failures: (existing?.failures ?? 0) + 1,
      lastFailureAt: nowIso(),
      deprioritized: false,
    };

    if (record.failures >= this.failureThreshold) {
      record.deprioritized = true;
    }

    this.records.set(key, record);
    return record.deprioritized;
  }

  /** Check if a task should be skipped due to repeated failures. */
  isDeprioritized(taskId: string, agentId: string): boolean {
    return this.records.get(`${taskId}::${agentId}`)?.deprioritized ?? false;
  }

  /** Reset a task (e.g., after a sprint reset or implementation change). */
  reset(taskId: string, agentId: string): void {
    this.records.delete(`${taskId}::${agentId}`);
  }

  listDeprioritized(): DeadEndRecord[] {
    return [...this.records.values()].filter(r => r.deprioritized);
  }
}
