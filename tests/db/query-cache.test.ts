/**
 * Tests for QueryCache — TTL cache with tag-based invalidation
 *
 * Verifies: get/set mechanics, TTL expiry, tag invalidation,
 * and the cache integration on SqliteAdapter hot-paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryCache } from '../../src/db/query-cache.js';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../src/db/database.js';

// ---------------------------------------------------------------------------
// QueryCache unit tests
// ---------------------------------------------------------------------------

describe('QueryCache — basics', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache();
  });

  it('returns undefined on miss', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the cached value on hit', () => {
    cache.set('k', 42, 5_000);
    expect(cache.get<number>('k')).toBe(42);
  });

  it('caches null values (negative caching)', () => {
    cache.set('k', null, 5_000);
    expect(cache.get('k')).toBeNull();
  });

  it('caches arrays and objects', () => {
    const arr = [{ id: '1' }, { id: '2' }];
    cache.set('arr', arr, 5_000);
    expect(cache.get('arr')).toStrictEqual(arr);
  });

  it('size reflects cached entry count', () => {
    expect(cache.size).toBe(0);
    cache.set('a', 1, 5_000);
    cache.set('b', 2, 5_000);
    expect(cache.size).toBe(2);
  });

  it('overwriting a key removes old tag associations', () => {
    cache.set('k', 'v1', 5_000, ['tag-a']);
    cache.set('k', 'v2', 5_000, ['tag-b']); // replaces
    // Invalidating old tag should NOT affect the entry (it's now under tag-b)
    cache.invalidateTag('tag-a');
    expect(cache.get<string>('k')).toBe('v2');
    // Invalidating new tag SHOULD remove it
    cache.invalidateTag('tag-b');
    expect(cache.get('k')).toBeUndefined();
  });

  it('clear removes all entries', () => {
    cache.set('a', 1, 5_000, ['t1']);
    cache.set('b', 2, 5_000, ['t1']);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('QueryCache — TTL expiry', () => {
  it('returns undefined after TTL elapses', () => {
    vi.useFakeTimers();
    const cache = new QueryCache();
    cache.set('k', 'value', 100); // 100ms TTL
    vi.advanceTimersByTime(101);
    expect(cache.get('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('returns value before TTL elapses', () => {
    vi.useFakeTimers();
    const cache = new QueryCache();
    cache.set('k', 'value', 500);
    vi.advanceTimersByTime(499);
    expect(cache.get<string>('k')).toBe('value');
    vi.useRealTimers();
  });
});

describe('QueryCache — tag invalidation', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache();
  });

  it('invalidateTag removes all entries with that tag', () => {
    cache.set('k1', 'a', 5_000, ['sessions']);
    cache.set('k2', 'b', 5_000, ['sessions']);
    cache.set('k3', 'c', 5_000, ['costs']); // different tag
    cache.invalidateTag('sessions');
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get<string>('k3')).toBe('c'); // unaffected
  });

  it('invalidateTags accepts multiple tags at once', () => {
    cache.set('k1', 'a', 5_000, ['sessions']);
    cache.set('k2', 'b', 5_000, ['costs']);
    cache.invalidateTags(['sessions', 'costs']);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toBeUndefined();
  });

  it('invalidating a nonexistent tag is a no-op', () => {
    cache.set('k', 1, 5_000, ['real-tag']);
    expect(() => cache.invalidateTag('phantom-tag')).not.toThrow();
    expect(cache.get<number>('k')).toBe(1);
  });

  it('entry belonging to multiple tags is removed when either tag is invalidated', () => {
    cache.set('k', 'v', 5_000, ['t1', 't2']);
    cache.invalidateTag('t1');
    expect(cache.get('k')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SqliteAdapter cache integration tests
// ---------------------------------------------------------------------------

function makeAdapter(): { adapter: SqliteAdapter; db: AgentDatabase } {
  const db = new AgentDatabase({ path: ':memory:' });
  const adapter = new SqliteAdapter({ db });
  return { adapter, db };
}

function sessionFixture(overrides: Partial<Omit<SessionRow, 'created_at'>> = {}): Omit<SessionRow, 'created_at'> {
  return {
    id: 'sess-1',
    agent_id: 'agent-a',
    agent_name: 'TestAgent',
    model: 'claude-sonnet-4-6',
    task: 'Test task',
    response: null,
    status: 'pending',
    started_at: '2026-03-27T00:00:00Z',
    completed_at: null,
    estimated_tokens: null,
    autonomy_tier: 1,
    resume_count: 0,
    parent_session_id: null,
    delegation_depth: 0,
    ...overrides,
  };
}

describe('SqliteAdapter — cache serves repeated reads', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture());
  });

  afterEach(() => {
    db.close();
  });

  it('getSession returns identical object on repeated reads (cache hit)', () => {
    const first = adapter.getSession('sess-1');
    const second = adapter.getSession('sess-1');
    expect(first).toStrictEqual(second);
  });

  it('listSessions result is consistent on repeated calls', () => {
    const first = adapter.listSessions();
    const second = adapter.listSessions();
    expect(first).toStrictEqual(second);
  });

  it('countSessions result is consistent on repeated calls', () => {
    expect(adapter.countSessions()).toBe(adapter.countSessions());
  });
});

describe('SqliteAdapter — cache invalidation on writes', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture());
  });

  afterEach(() => {
    db.close();
  });

  it('getSession reflects updateSession immediately (cache invalidated)', () => {
    const before = adapter.getSession('sess-1')!;
    expect(before.status).toBe('pending');

    adapter.updateSession('sess-1', { status: 'completed' });

    const after = adapter.getSession('sess-1')!;
    expect(after.status).toBe('completed');
  });

  it('listSessions reflects insertSession immediately (cache invalidated)', () => {
    expect(adapter.listSessions()).toHaveLength(1);
    adapter.insertSession(sessionFixture({ id: 'sess-2' }));
    expect(adapter.listSessions()).toHaveLength(2);
  });

  it('countSessions reflects insertSession immediately (cache invalidated)', () => {
    expect(adapter.countSessions()).toBe(1);
    adapter.insertSession(sessionFixture({ id: 'sess-2' }));
    expect(adapter.countSessions()).toBe(2);
  });

  it('getTotalCostUsd reflects insertCost immediately (cache invalidated)', () => {
    expect(adapter.getTotalCostUsd()).toBe(0);
    adapter.insertCost({
      id: 'cost-1',
      session_id: null,
      agent_id: 'agent-a',
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.05,
      created_at: '2026-03-27T00:00:00Z',
    });
    expect(adapter.getTotalCostUsd()).toBeCloseTo(0.05);
  });

  it('getAllCosts reflects insertCost immediately (cache invalidated)', () => {
    expect(adapter.getAllCosts()).toHaveLength(0);
    adapter.insertCost({
      id: 'cost-1',
      session_id: null,
      agent_id: 'agent-a',
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.05,
      created_at: '2026-03-27T00:00:00Z',
    });
    expect(adapter.getAllCosts()).toHaveLength(1);
  });
});

describe('AgentDatabase — getSessionTree cache', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture({ id: 'root', delegation_depth: 0 }));
    adapter.insertSession(sessionFixture({ id: 'child-1', parent_session_id: 'root', delegation_depth: 1 }));
  });

  afterEach(() => {
    db.close();
  });

  it('getSessionTree result is consistent on repeated calls (cache hit)', () => {
    const first = db.getSessionTree('root');
    const second = db.getSessionTree('root');
    expect(first).toStrictEqual(second);
  });

  it('getSessionTree cache is invalidated on updateSession', () => {
    const before = db.getSessionTree('root');
    expect(before.find(s => s.id === 'child-1')?.status).toBe('pending');

    adapter.updateSession('child-1', { status: 'completed' });

    const after = db.getSessionTree('root');
    expect(after.find(s => s.id === 'child-1')?.status).toBe('completed');
  });

  it('getSessionTree cache is invalidated on insertSession', () => {
    const before = db.getSessionTree('root');
    expect(before).toHaveLength(2);

    adapter.insertSession(sessionFixture({
      id: 'child-2',
      parent_session_id: 'root',
      delegation_depth: 1,
    }));

    const after = db.getSessionTree('root');
    expect(after).toHaveLength(3);
  });
});
