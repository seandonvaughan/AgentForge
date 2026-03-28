/**
 * tests/v5/audit-trail.test.ts
 * Tests for AuditTrail — record, query, stats
 * Target: 25+ tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditTrail } from '../../packages/core/src/audit/audit-trail.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrail() {
  return new AuditTrail();
}

// ── record() ──────────────────────────────────────────────────────────────────

describe('AuditTrail.record()', () => {
  let trail: AuditTrail;

  beforeEach(() => { trail = makeTrail(); });

  it('creates an entry with a unique id', () => {
    const e1 = trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    const e2 = trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    expect(e1.id).not.toBe(e2.id);
  });

  it('entry has the correct action', () => {
    const e = trail.record('session.started', 'agent-1', 'agent', 'ws-1');
    expect(e.action).toBe('session.started');
  });

  it('entry has the correct actorId', () => {
    const e = trail.record('agent.invoked', 'user-99', 'user', 'ws-1');
    expect(e.actorId).toBe('user-99');
  });

  it('entry has the correct actorType', () => {
    const e = trail.record('agent.invoked', 'system', 'system', 'ws-1');
    expect(e.actorType).toBe('system');
  });

  it('entry has the correct workspaceId', () => {
    const e = trail.record('agent.invoked', 'user-1', 'user', 'ws-xyz');
    expect(e.workspaceId).toBe('ws-xyz');
  });

  it('entry has a valid ISO timestamp', () => {
    const e = trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    expect(() => new Date(e.timestamp)).not.toThrow();
  });

  it('entry has resourceType when provided', () => {
    const e = trail.record('agent.invoked', 'user-1', 'user', 'ws-1', { resourceType: 'agent' });
    expect(e.resourceType).toBe('agent');
  });

  it('entry has resourceId when provided', () => {
    const e = trail.record('agent.invoked', 'user-1', 'user', 'ws-1', { resourceId: 'agent-42' });
    expect(e.resourceId).toBe('agent-42');
  });

  it('entry has metadata when provided', () => {
    const e = trail.record('admin.action', 'admin-1', 'user', 'ws-1', { metadata: { action: 'reset' } });
    expect(e.metadata?.action).toBe('reset');
  });

  it('calls the persist function when set', () => {
    const persist = vi.fn();
    trail.setPersistFn(persist);
    trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('persist function receives the recorded entry', () => {
    const captured: unknown[] = [];
    trail.setPersistFn((e) => captured.push(e));
    trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    expect((captured[0] as { action: string }).action).toBe('agent.invoked');
  });
});

// ── query() ───────────────────────────────────────────────────────────────────

describe('AuditTrail.query()', () => {
  let trail: AuditTrail;

  beforeEach(() => {
    trail = makeTrail();
    // Seed some entries
    trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    trail.record('session.started', 'agent-1', 'agent', 'ws-1');
    trail.record('agent.invoked', 'user-2', 'user', 'ws-2');
    trail.record('plugin.loaded', 'system', 'system', 'ws-1');
  });

  it('returns all entries when no filter given', () => {
    expect(trail.query().length).toBe(4);
  });

  it('filters by workspaceId', () => {
    const results = trail.query({ workspaceId: 'ws-1' });
    expect(results.length).toBe(3);
    expect(results.every(e => e.workspaceId === 'ws-1')).toBe(true);
  });

  it('filters by actorId', () => {
    const results = trail.query({ actorId: 'user-1' });
    expect(results.length).toBe(1);
    expect(results[0].actorId).toBe('user-1');
  });

  it('filters by action', () => {
    const results = trail.query({ action: 'agent.invoked' });
    expect(results.length).toBe(2);
    expect(results.every(e => e.action === 'agent.invoked')).toBe(true);
  });

  it('returns results in descending timestamp order', () => {
    const results = trail.query();
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].timestamp >= results[i + 1].timestamp).toBe(true);
    }
  });

  it('respects limit', () => {
    const results = trail.query({ limit: 2 });
    expect(results.length).toBe(2);
  });

  it('respects offset', () => {
    const all = trail.query();
    const offset = trail.query({ offset: 2 });
    expect(offset.length).toBe(all.length - 2);
  });

  it('since filter excludes entries before the timestamp', () => {
    const future = new Date(Date.now() + 100_000).toISOString();
    const results = trail.query({ since: future });
    expect(results.length).toBe(0);
  });

  it('until filter excludes entries after the timestamp', () => {
    const past = new Date(Date.now() - 100_000).toISOString();
    const results = trail.query({ until: past });
    expect(results.length).toBe(0);
  });

  it('combined filter workspaceId + action', () => {
    const results = trail.query({ workspaceId: 'ws-1', action: 'agent.invoked' });
    expect(results.length).toBe(1);
    expect(results[0].workspaceId).toBe('ws-1');
    expect(results[0].action).toBe('agent.invoked');
  });

  it('empty result when no entries match filter', () => {
    expect(trail.query({ actorId: 'ghost' })).toHaveLength(0);
  });
});

// ── stats() ───────────────────────────────────────────────────────────────────

describe('AuditTrail.stats()', () => {
  let trail: AuditTrail;

  beforeEach(() => {
    trail = makeTrail();
    trail.record('agent.invoked', 'user-1', 'user', 'ws-1');
    trail.record('agent.invoked', 'user-2', 'user', 'ws-1');
    trail.record('session.started', 'agent-1', 'agent', 'ws-1');
    trail.record('agent.invoked', 'user-1', 'user', 'ws-2'); // different workspace
  });

  it('aggregates counts by action for a workspace', () => {
    const s = trail.stats('ws-1');
    expect(s['agent.invoked']).toBe(2);
    expect(s['session.started']).toBe(1);
  });

  it('does not include entries from other workspaces', () => {
    const s = trail.stats('ws-1');
    const total = Object.values(s).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(3); // only ws-1 entries
  });

  it('returns empty object for workspace with no entries', () => {
    expect(trail.stats('ws-none')).toEqual({});
  });

  it('counts all distinct actions', () => {
    const s = trail.stats('ws-1');
    expect(Object.keys(s).length).toBe(2); // agent.invoked, session.started
  });
});
