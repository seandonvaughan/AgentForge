import { generateId, nowIso } from '@agentforge/shared';
import type { ExecutionLogEntry, LogLevel } from './types.js';

export class ExecutionLog {
  private entries: ExecutionLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  log(
    level: LogLevel,
    category: ExecutionLogEntry['category'],
    message: string,
    data?: Record<string, unknown>,
  ): ExecutionLogEntry {
    const entry: ExecutionLogEntry = {
      id: generateId(),
      timestamp: nowIso(),
      level,
      category,
      message,
      ...(data ? { data } : {}),
      ...(typeof data?.['sprintVersion'] === 'string'
        ? { sprintVersion: data['sprintVersion'] }
        : {}),
      ...(typeof data?.['agentId'] === 'string' ? { agentId: data['agentId'] } : {}),
      ...(typeof data?.['costUsd'] === 'number' ? { costUsd: data['costUsd'] } : {}),
      ...(typeof data?.['durationMs'] === 'number'
        ? { durationMs: data['durationMs'] }
        : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return entry;
  }

  query(filters: {
    level?: LogLevel;
    category?: ExecutionLogEntry['category'];
    sprintVersion?: string;
    agentId?: string;
    since?: string;
    limit?: number;
  } = {}): ExecutionLogEntry[] {
    let result = [...this.entries];

    if (filters.level) result = result.filter(e => e.level === filters.level);
    if (filters.category) result = result.filter(e => e.category === filters.category);
    if (filters.sprintVersion) result = result.filter(e => e.sprintVersion === filters.sprintVersion);
    if (filters.agentId) result = result.filter(e => e.agentId === filters.agentId);
    if (filters.since) result = result.filter(e => e.timestamp >= filters.since!);

    const limit = filters.limit ?? 100;
    return result.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }

  count(): number {
    return this.entries.length;
  }
}
