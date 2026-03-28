import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EscalationEvent } from './types.js';

// Escalation chain: agent → their lead → CTO/COO → CEO
const ESCALATION_CHAIN: Record<string, string> = {
  // Implementation agents escalate to their tech lead
  'coder': 'cto',
  'debugger': 'cto',
  'api-specialist': 'cto',
  'linter': 'cto',
  'architect': 'cto',
  // QA escalates to COO
  'team-reviewer': 'coo',
  // Research escalates to CTO
  'researcher': 'cto',
  // Default chain
  'default': 'cto',
};

function getEscalationTarget(fromAgentId: string, level: 1 | 2 | 3): string {
  if (level === 3) return 'cto'; // Always CTO at level 3
  const direct = ESCALATION_CHAIN[fromAgentId] ?? ESCALATION_CHAIN['default'] ?? 'cto';
  if (level === 2) return ESCALATION_CHAIN[direct] ?? 'cto';
  return direct;
}

export class EscalationProtocol extends EventEmitter {
  private events: Map<string, EscalationEvent> = new Map();
  private autoEscalateThreshold = 3; // escalate after 3 failed attempts

  /** Escalate a task that an agent cannot resolve. */
  escalate(
    fromAgentId: string,
    task: string,
    reason: string,
    level: 1 | 2 | 3 = 1,
  ): EscalationEvent {
    const id = randomUUID();
    const toAgentId = getEscalationTarget(fromAgentId, level);

    const event: EscalationEvent = {
      id,
      fromAgentId,
      toAgentId,
      task,
      reason,
      escalatedAt: new Date().toISOString(),
      level,
    };

    this.events.set(id, event);
    this.emit('escalation.created', event);

    return event;
  }

  /** Mark an escalation as resolved. */
  resolve(id: string, resolution: string): EscalationEvent | null {
    const event = this.events.get(id);
    if (!event) return null;
    event.resolvedAt = new Date().toISOString();
    event.resolution = resolution;
    this.emit('escalation.resolved', event);
    return event;
  }

  /** Auto-escalate if confidence is too low after retries. */
  maybeEscalate(
    agentId: string,
    task: string,
    attempts: number,
    lastError: string,
  ): EscalationEvent | null {
    if (attempts < this.autoEscalateThreshold) return null;
    const level = attempts >= 6 ? 3 : attempts >= 4 ? 2 : 1;
    return this.escalate(agentId, task, `Auto-escalated after ${attempts} failed attempts: ${lastError}`, level as 1 | 2 | 3);
  }

  /** Get all escalations, optionally filtered by resolved status. */
  list(resolved?: boolean): EscalationEvent[] {
    const all = [...this.events.values()];
    if (resolved === undefined) return all;
    return all.filter(e => resolved ? !!e.resolvedAt : !e.resolvedAt);
  }

  getStats(): { total: number; open: number; resolved: number; byLevel: Record<number, number> } {
    const all = [...this.events.values()];
    return {
      total: all.length,
      open: all.filter(e => !e.resolvedAt).length,
      resolved: all.filter(e => !!e.resolvedAt).length,
      byLevel: {
        1: all.filter(e => e.level === 1).length,
        2: all.filter(e => e.level === 2).length,
        3: all.filter(e => e.level === 3).length,
      },
    };
  }
}
