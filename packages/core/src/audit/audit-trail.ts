import { randomUUID } from 'node:crypto';
import type { AuditEntry, AuditAction, AuditQuery } from './types.js';

type PersistFn = (entry: AuditEntry) => void;

export class AuditTrail {
  private entries: AuditEntry[] = [];
  private persistFn?: PersistFn;

  /** Optionally wire up a persistence function (e.g. SQLite insert). */
  setPersistFn(fn: PersistFn): void {
    this.persistFn = fn;
  }

  /** Record an audit event. */
  record(
    action: AuditAction,
    actorId: string,
    actorType: 'user' | 'agent' | 'system',
    workspaceId: string,
    opts: {
      resourceType?: string;
      resourceId?: string;
      metadata?: Record<string, unknown>;
      ip?: string;
    } = {},
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      action,
      actorId,
      actorType,
      workspaceId,
      timestamp: new Date().toISOString(),
      ...opts,
    };
    this.entries.push(entry);
    this.persistFn?.(entry);
    return entry;
  }

  /** Query audit entries. */
  query(q: AuditQuery = {}): AuditEntry[] {
    let results = [...this.entries];
    if (q.workspaceId) results = results.filter(e => e.workspaceId === q.workspaceId);
    if (q.actorId) results = results.filter(e => e.actorId === q.actorId);
    if (q.action) results = results.filter(e => e.action === q.action);
    if (q.since) results = results.filter(e => e.timestamp >= q.since!);
    if (q.until) results = results.filter(e => e.timestamp <= q.until!);
    results = results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  /** Get audit stats for a workspace. */
  stats(workspaceId: string): Record<string, number> {
    const entries = this.entries.filter(e => e.workspaceId === workspaceId);
    const byAction: Record<string, number> = {};
    for (const e of entries) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    }
    return byAction;
  }
}
