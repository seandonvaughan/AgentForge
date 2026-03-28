/**
 * tests/v5/core-message-bus.test.ts
 * Tests for MessageBusV2 — subscribe, publish, wildcard, once, history
 * Target: 30+ tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBusV2 } from '../../packages/core/src/message-bus/message-bus.js';
import {
  isTaskTopic,
  isDelegationTopic,
  isEscalationTopic,
  isLifecycleTopic,
  isCostTopic,
  isFeedbackTopic,
  isSystemTopic,
} from '../../packages/core/src/message-bus/types.js';
import type { MessageTopic } from '../../packages/core/src/message-bus/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBus() {
  return new MessageBusV2({ workspaceId: 'ws-test', maxHistorySize: 100 });
}

function publishTask(bus: MessageBusV2, topic: MessageTopic = 'agent.task.assigned') {
  return bus.publish({
    from: 'coder',
    to: 'broadcast',
    topic,
    category: 'task',
    payload: { taskId: 't1', task: 'Do something', delegationDepth: 0 },
  });
}

// ── Basic publish + subscribe ─────────────────────────────────────────────────

describe('MessageBusV2 — basic publish/subscribe', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('calls subscriber when matching topic is published', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.assigned', handler);
    publishTask(bus);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('passes the full envelope to the handler', () => {
    const received: unknown[] = [];
    bus.subscribe('agent.task.assigned', (env) => received.push(env));
    const sent = publishTask(bus);
    expect(received[0]).toMatchObject({ id: sent.id, topic: 'agent.task.assigned' });
  });

  it('does not call subscriber for a different topic', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.completed', handler);
    publishTask(bus, 'agent.task.assigned');
    expect(handler).not.toHaveBeenCalled();
  });

  it('publish returns the envelope with a generated id', () => {
    const env = publishTask(bus);
    expect(typeof env.id).toBe('string');
    expect(env.id.length).toBeGreaterThan(0);
  });

  it('publish sets the correct workspaceId', () => {
    const env = publishTask(bus);
    expect(env.workspaceId).toBe('ws-test');
  });

  it('publish sets version to 2.0', () => {
    const env = publishTask(bus);
    expect(env.version).toBe('2.0');
  });

  it('default priority is normal when not specified', () => {
    const env = publishTask(bus);
    expect(env.priority).toBe('normal');
  });

  it('can publish with explicit priority', () => {
    const env = bus.publish({
      from: 'system',
      to: 'broadcast',
      topic: 'system.health.check',
      category: 'system',
      payload: {},
      priority: 'critical',
    });
    expect(env.priority).toBe('critical');
  });

  it('multiple publishers on the same topic all trigger the subscriber', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.assigned', handler);
    publishTask(bus);
    publishTask(bus);
    publishTask(bus);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

// ── Multiple subscribers ───────────────────────────────────────────────────────

describe('MessageBusV2 — multiple subscribers', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('all subscribers on the same topic receive the event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    bus.subscribe('agent.task.assigned', h1);
    bus.subscribe('agent.task.assigned', h2);
    bus.subscribe('agent.task.assigned', h3);
    publishTask(bus);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h3).toHaveBeenCalledOnce();
  });

  it('stats.subscriberCount reflects all registered handlers', () => {
    bus.subscribe('agent.task.assigned', vi.fn());
    bus.subscribe('agent.task.assigned', vi.fn());
    bus.subscribe('agent.task.completed', vi.fn());
    expect(bus.getStats().subscriberCount).toBe(3);
  });
});

// ── Unsubscribe ───────────────────────────────────────────────────────────────

describe('MessageBusV2 — unsubscribe', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('stops receiving events after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.subscribe('agent.task.assigned', handler);
    publishTask(bus);
    unsub();
    publishTask(bus);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('removing one handler does not affect remaining handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = bus.subscribe('agent.task.assigned', h1);
    bus.subscribe('agent.task.assigned', h2);
    unsub1();
    publishTask(bus);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('subscriberCount decrements after unsubscribe', () => {
    const unsub = bus.subscribe('agent.task.assigned', vi.fn());
    expect(bus.getStats().subscriberCount).toBe(1);
    unsub();
    expect(bus.getStats().subscriberCount).toBe(0);
  });
});

// ── Wildcard subscriptions ────────────────────────────────────────────────────

describe('MessageBusV2 — wildcard subscriptions', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('agent.task.* matches agent.task.assigned', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.*', handler);
    publishTask(bus, 'agent.task.assigned');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('agent.task.* matches agent.task.completed', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.*', handler);
    publishTask(bus, 'agent.task.completed');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('agent.task.* does not match agent.lifecycle.started', () => {
    const handler = vi.fn();
    bus.subscribe('agent.task.*', handler);
    bus.publish({ from: 'system', to: 'broadcast', topic: 'agent.lifecycle.started', category: 'lifecycle', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('subscribeAll registers a handler on the "*.*" catch-all pattern', () => {
    // subscribeAll() is a convenience wrapper around subscribe('*.*', handler)
    // It registers successfully without throwing
    const handler = vi.fn();
    expect(() => bus.subscribeAll(handler)).not.toThrow();
    // The returned value should be an unsubscribe function
    const result = bus.subscribeAll(vi.fn());
    expect(typeof result).toBe('function');
  });

  it('wildcard handler receives correct topic in envelope', () => {
    const topics: string[] = [];
    bus.subscribe('agent.task.*', (env) => topics.push(env.topic));
    publishTask(bus, 'agent.task.assigned');
    publishTask(bus, 'agent.task.completed');
    expect(topics).toContain('agent.task.assigned');
    expect(topics).toContain('agent.task.completed');
  });
});

// ── once semantics ────────────────────────────────────────────────────────────

describe('MessageBusV2 — once()', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('resolves with the envelope of the first matching message', async () => {
    const promise = bus.once('agent.task.assigned');
    const sent = publishTask(bus);
    const received = await promise;
    expect(received.id).toBe(sent.id);
  });

  it('rejects after timeout if no message arrives', async () => {
    await expect(bus.once('agent.task.assigned', 10)).rejects.toThrow('timeout');
  });
});

// ── History & stats ───────────────────────────────────────────────────────────

describe('MessageBusV2 — history and stats', () => {
  let bus: MessageBusV2;
  beforeEach(() => { bus = makeBus(); });

  it('totalPublished increments on each publish', () => {
    publishTask(bus);
    publishTask(bus);
    publishTask(bus);
    expect(bus.getStats().totalPublished).toBe(3);
  });

  it('historySize grows with each publish', () => {
    publishTask(bus);
    publishTask(bus);
    expect(bus.getStats().historySize).toBe(2);
  });

  it('getHistory returns published messages', () => {
    const env = publishTask(bus);
    const hist = bus.getHistory();
    expect(hist.some(m => m.id === env.id)).toBe(true);
  });

  it('getHistory can filter by topic', () => {
    publishTask(bus, 'agent.task.assigned');
    publishTask(bus, 'agent.task.completed');
    const filtered = bus.getHistory(100, 'agent.task.assigned');
    expect(filtered.every(m => m.topic === 'agent.task.assigned')).toBe(true);
  });

  it('clear() resets history and subscribers', () => {
    bus.subscribe('agent.task.assigned', vi.fn());
    publishTask(bus);
    bus.clear();
    expect(bus.getStats().historySize).toBe(0);
    expect(bus.getStats().subscriberCount).toBe(0);
  });

  it('replay() delivers history to a new handler', () => {
    publishTask(bus, 'agent.task.assigned');
    publishTask(bus, 'agent.task.assigned');
    const replayed: unknown[] = [];
    bus.replay((env) => replayed.push(env), 'agent.task.assigned');
    expect(replayed.length).toBe(2);
  });
});

// ── Topic type guards ─────────────────────────────────────────────────────────

describe('Topic type guards', () => {
  it('isTaskTopic returns true for agent.task.assigned', () => {
    expect(isTaskTopic('agent.task.assigned')).toBe(true);
  });

  it('isTaskTopic returns false for agent.lifecycle.started', () => {
    expect(isTaskTopic('agent.lifecycle.started')).toBe(false);
  });

  it('isDelegationTopic returns true for agent.delegation.requested', () => {
    expect(isDelegationTopic('agent.delegation.requested')).toBe(true);
  });

  it('isEscalationTopic returns true for agent.escalation.raised', () => {
    expect(isEscalationTopic('agent.escalation.raised')).toBe(true);
  });

  it('isLifecycleTopic returns true for agent.lifecycle.started', () => {
    expect(isLifecycleTopic('agent.lifecycle.started')).toBe(true);
  });

  it('isCostTopic returns true for cost.recorded', () => {
    expect(isCostTopic('cost.recorded')).toBe(true);
  });

  it('isFeedbackTopic returns true for agent.feedback.submitted', () => {
    expect(isFeedbackTopic('agent.feedback.submitted')).toBe(true);
  });

  it('isSystemTopic returns true for system.health.check', () => {
    expect(isSystemTopic('system.health.check')).toBe(true);
  });
});
