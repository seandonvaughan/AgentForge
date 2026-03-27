/**
 * Tests for SqliteAdapter — P0-2 unified data access layer
 *
 * All tests use `:memory:` database for isolation and speed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import type { FeedbackDbRow, CostRow, TaskOutcomeRow, PromotionRow } from '../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../src/db/database.js';

// ---------------------------------------------------------------------------
// Helpers
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

function feedbackFixture(overrides: Partial<FeedbackDbRow> = {}): FeedbackDbRow {
  return {
    id: 'fb-1',
    agent_id: 'agent-a',
    session_id: null,
    category: 'general',
    message: 'Test feedback',
    sentiment: 'positive',
    created_at: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

function costFixture(overrides: Partial<CostRow> = {}): CostRow {
  return {
    id: 'cost-1',
    session_id: null,
    agent_id: 'agent-a',
    model: 'claude-sonnet-4-6',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.005,
    created_at: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// kv_store: writeFile / readFile / fileExists
// ---------------------------------------------------------------------------

describe('kv_store paths', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('writeFile stores and readFile retrieves a value', () => {
    adapter.writeFile('flywheel/snapshot.json', '{"test":true}');
    const result = adapter.readFile('flywheel/snapshot.json');
    expect(result).toBe('{"test":true}');
  });

  it('fileExists returns false for an unknown path', () => {
    expect(adapter.fileExists('some/unknown/path.json')).toBe(false);
  });

  it('fileExists returns true after writeFile', () => {
    adapter.writeFile('config/settings.json', '{}');
    expect(adapter.fileExists('config/settings.json')).toBe(true);
  });

  it('readFile throws for a missing path', () => {
    expect(() => adapter.readFile('not/there.json')).toThrow('File not found: not/there.json');
  });

  it('writeFile overwrites existing kv entry', () => {
    adapter.writeFile('some/key.json', 'v1');
    adapter.writeFile('some/key.json', 'v2');
    expect(adapter.readFile('some/key.json')).toBe('v2');
  });

  it('multiple keys are stored independently', () => {
    adapter.writeFile('a.json', 'AAA');
    adapter.writeFile('b.json', 'BBB');
    expect(adapter.readFile('a.json')).toBe('AAA');
    expect(adapter.readFile('b.json')).toBe('BBB');
  });

  it('arbitrary content is preserved verbatim', () => {
    const content = JSON.stringify({ nested: { arr: [1, 2, 3] }, flag: true });
    adapter.writeFile('deep/path.json', content);
    expect(adapter.readFile('deep/path.json')).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// feedback/ path prefix
// ---------------------------------------------------------------------------

describe('feedback/ path prefix', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('fileExists returns false when no feedback rows exist for that sprint', () => {
    expect(adapter.fileExists('feedback/v4.7.json')).toBe(false);
  });

  it('readFile throws for empty feedback path', () => {
    expect(() => adapter.readFile('feedback/v4.7.json')).toThrow('File not found: feedback/v4.7.json');
  });

  it('writeFile/readFile round-trips a FeedbackDbRow array via feedback path', () => {
    const rows: FeedbackDbRow[] = [
      feedbackFixture({ id: 'fb-sprint-1', category: 'v4.7', message: 'It worked', agent_id: 'agent-a' }),
      feedbackFixture({ id: 'fb-sprint-2', category: 'v4.7', message: 'It also worked', agent_id: 'agent-b' }),
    ];
    adapter.writeFile('feedback/v4.7.json', JSON.stringify(rows));

    const result = JSON.parse(adapter.readFile('feedback/v4.7.json')) as FeedbackDbRow[];
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id).sort()).toEqual(['fb-sprint-1', 'fb-sprint-2'].sort());
  });

  it('fileExists returns true after writeFile to feedback path', () => {
    const rows: FeedbackDbRow[] = [
      feedbackFixture({ id: 'fb-ex-1', category: 'v4.7', agent_id: 'agent-a' }),
    ];
    adapter.writeFile('feedback/v4.7.json', JSON.stringify(rows));
    expect(adapter.fileExists('feedback/v4.7.json')).toBe(true);
  });

  it('different sprint paths are isolated', () => {
    const rows47: FeedbackDbRow[] = [feedbackFixture({ id: 'fb-47', category: 'v4.7', agent_id: 'agent-a' })];
    const rows48: FeedbackDbRow[] = [feedbackFixture({ id: 'fb-48', category: 'v4.8', agent_id: 'agent-b' })];

    adapter.writeFile('feedback/v4.7.json', JSON.stringify(rows47));
    adapter.writeFile('feedback/v4.8.json', JSON.stringify(rows48));

    expect(adapter.fileExists('feedback/v4.7.json')).toBe(true);
    expect(adapter.fileExists('feedback/v4.8.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sessions CRUD
// ---------------------------------------------------------------------------

describe('insertSession / getSession', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('getSession returns null for unknown id', () => {
    expect(adapter.getSession('does-not-exist')).toBeNull();
  });

  it('insertSession then getSession returns the record', () => {
    const sess = sessionFixture();
    adapter.insertSession(sess);
    const result = adapter.getSession('sess-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sess-1');
    expect(result!.agent_id).toBe('agent-a');
    expect(result!.task).toBe('Test task');
  });

  it('insertSession persists all non-null fields', () => {
    const sess = sessionFixture({ status: 'completed', response: 'done', delegation_depth: 2 });
    adapter.insertSession(sess);
    const result = adapter.getSession('sess-1')!;
    expect(result.status).toBe('completed');
    expect(result.response).toBe('done');
    expect(result.delegation_depth).toBe(2);
  });
});

describe('updateSession', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture());
  });

  afterEach(() => {
    db.close();
  });

  it('updateSession persists status change', () => {
    adapter.updateSession('sess-1', { status: 'completed' });
    expect(adapter.getSession('sess-1')!.status).toBe('completed');
  });

  it('updateSession persists response and completed_at', () => {
    adapter.updateSession('sess-1', {
      response: 'All done',
      completed_at: '2026-03-27T01:00:00Z',
      status: 'completed',
    });
    const result = adapter.getSession('sess-1')!;
    expect(result.response).toBe('All done');
    expect(result.completed_at).toBe('2026-03-27T01:00:00Z');
  });

  it('updateSession with empty updates is a no-op', () => {
    adapter.updateSession('sess-1', {});
    expect(adapter.getSession('sess-1')!.status).toBe('pending');
  });
});

describe('listSessions', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture({ id: 's1', agent_id: 'agent-a', status: 'completed' }));
    adapter.insertSession(sessionFixture({ id: 's2', agent_id: 'agent-a', status: 'pending' }));
    adapter.insertSession(sessionFixture({ id: 's3', agent_id: 'agent-b', status: 'completed' }));
  });

  afterEach(() => {
    db.close();
  });

  it('listSessions with no filters returns all sessions', () => {
    expect(adapter.listSessions()).toHaveLength(3);
  });

  it('listSessions filters by agentId', () => {
    const results = adapter.listSessions({ agentId: 'agent-a' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.agent_id === 'agent-a')).toBe(true);
  });

  it('listSessions filters by status', () => {
    const results = adapter.listSessions({ status: 'completed' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'completed')).toBe(true);
  });

  it('listSessions filters by agentId AND status', () => {
    const results = adapter.listSessions({ agentId: 'agent-a', status: 'pending' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('s2');
  });

  it('listSessions respects limit', () => {
    expect(adapter.listSessions({ limit: 2 })).toHaveLength(2);
  });

  it('listSessions respects offset', () => {
    const all = adapter.listSessions();
    const paged = adapter.listSessions({ limit: 2, offset: 1 });
    expect(paged).toHaveLength(2);
    expect(paged[0].id).not.toBe(all[0].id);
  });

  it('listSessions with offset but no limit uses LIMIT -1 for unlimited', () => {
    const all = adapter.listSessions();
    expect(all).toHaveLength(3);
    const withOffset = adapter.listSessions({ offset: 2 });
    expect(withOffset).toHaveLength(1);
    expect(withOffset[0].id).toBe(all[2].id);
  });
});

// ---------------------------------------------------------------------------
// Costs CRUD
// ---------------------------------------------------------------------------

describe('insertCost / getAgentCosts / getTotalCostUsd', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('getTotalCostUsd returns 0 when no costs are recorded', () => {
    expect(adapter.getTotalCostUsd()).toBe(0);
  });

  it('insertCost then getTotalCostUsd reflects the new cost', () => {
    adapter.insertCost(costFixture({ cost_usd: 0.01 }));
    expect(adapter.getTotalCostUsd()).toBeCloseTo(0.01);
  });

  it('getTotalCostUsd sums across multiple entries', () => {
    adapter.insertCost(costFixture({ id: 'c1', cost_usd: 0.01 }));
    adapter.insertCost(costFixture({ id: 'c2', agent_id: 'agent-b', cost_usd: 0.02 }));
    expect(adapter.getTotalCostUsd()).toBeCloseTo(0.03);
  });

  it('getAgentCosts returns empty array for unknown agent', () => {
    expect(adapter.getAgentCosts('no-one')).toHaveLength(0);
  });

  it('getAgentCosts returns only rows for that agent', () => {
    adapter.insertCost(costFixture({ id: 'c1', agent_id: 'agent-a', cost_usd: 0.01 }));
    adapter.insertCost(costFixture({ id: 'c2', agent_id: 'agent-b', cost_usd: 0.02 }));
    const results = adapter.getAgentCosts('agent-a');
    expect(results).toHaveLength(1);
    expect(results[0].agent_id).toBe('agent-a');
    expect(results[0].cost_usd).toBeCloseTo(0.01);
  });
});

// ---------------------------------------------------------------------------
// listFeedback CRUD
// ---------------------------------------------------------------------------

describe('insertFeedback / listFeedback', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('listFeedback returns empty array when no entries exist', () => {
    expect(adapter.listFeedback()).toHaveLength(0);
  });

  it('insertFeedback then listFeedback returns the entry', () => {
    adapter.insertFeedback(feedbackFixture());
    const results = adapter.listFeedback();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('fb-1');
  });

  it('listFeedback filters by agentId', () => {
    adapter.insertFeedback(feedbackFixture({ id: 'fb-a', agent_id: 'agent-a' }));
    adapter.insertFeedback(feedbackFixture({ id: 'fb-b', agent_id: 'agent-b' }));
    const results = adapter.listFeedback({ agentId: 'agent-a' });
    expect(results).toHaveLength(1);
    expect(results[0].agent_id).toBe('agent-a');
  });

  it('listFeedback respects limit', () => {
    adapter.insertFeedback(feedbackFixture({ id: 'fb-1' }));
    adapter.insertFeedback(feedbackFixture({ id: 'fb-2' }));
    adapter.insertFeedback(feedbackFixture({ id: 'fb-3' }));
    expect(adapter.listFeedback({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// updateSession: SQL injection allowlist
// ---------------------------------------------------------------------------

describe('updateSession SQL injection guard', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture());
  });

  afterEach(() => {
    db.close();
  });

  it('silently ignores injected keys not in the SESSION_COLUMNS allowlist', () => {
    // Passing a key like "status = 'hacked' --" should be filtered out
    adapter.updateSession('sess-1', {
      status: 'completed',
      // @ts-expect-error — intentional injection attempt
      'evil = 1; DROP TABLE sessions; --': 'ignored',
    } as Partial<SessionRow>);
    // Session should still exist and status update should work
    const result = adapter.getSession('sess-1');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
  });

  it('update with only non-allowlisted keys is a no-op and does not throw', () => {
    adapter.updateSession('sess-1', {
      // @ts-expect-error — intentional injection attempt
      injected_column: 'bad',
    } as Partial<SessionRow>);
    expect(adapter.getSession('sess-1')!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// writeFile: feedback category enforcement
// ---------------------------------------------------------------------------

describe('writeFile feedback category enforcement', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('overwrites row.category with sprintId derived from path', () => {
    const rows: FeedbackDbRow[] = [
      feedbackFixture({ id: 'fb-cat-1', category: 'wrong-category', agent_id: 'agent-a' }),
    ];
    adapter.writeFile('feedback/v4.7.json', JSON.stringify(rows));

    const result = JSON.parse(adapter.readFile('feedback/v4.7.json')) as FeedbackDbRow[];
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('v4.7');
  });
});

// ---------------------------------------------------------------------------
// Task Outcomes CRUD
// ---------------------------------------------------------------------------

function taskOutcomeFixture(overrides: Partial<TaskOutcomeRow> = {}): TaskOutcomeRow {
  return {
    id: 'to-1',
    session_id: 'sess-1',
    agent_id: 'agent-a',
    task: 'Test task',
    success: 1,
    quality_score: 0.9,
    model: 'claude-sonnet-4-6',
    duration_ms: 1200,
    created_at: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

describe('insertTaskOutcome / listTaskOutcomes', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
    adapter.insertSession(sessionFixture({ id: 'sess-1' }));
    adapter.insertSession(sessionFixture({ id: 'sess-2' }));
  });

  afterEach(() => {
    db.close();
  });

  it('listTaskOutcomes returns empty array when no outcomes exist', () => {
    expect(adapter.listTaskOutcomes()).toHaveLength(0);
  });

  it('insertTaskOutcome then listTaskOutcomes returns the entry', () => {
    adapter.insertTaskOutcome(taskOutcomeFixture());
    const results = adapter.listTaskOutcomes();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('to-1');
    expect(results[0].success).toBe(1);
  });

  it('listTaskOutcomes filters by sessionId', () => {
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-a', session_id: 'sess-1' }));
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-b', session_id: 'sess-2' }));
    const results = adapter.listTaskOutcomes({ sessionId: 'sess-1' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('to-a');
  });

  it('listTaskOutcomes filters by agentId', () => {
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-a', agent_id: 'agent-a' }));
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-b', agent_id: 'agent-b' }));
    const results = adapter.listTaskOutcomes({ agentId: 'agent-b' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('to-b');
  });

  it('listTaskOutcomes respects limit', () => {
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-1' }));
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-2' }));
    adapter.insertTaskOutcome(taskOutcomeFixture({ id: 'to-3' }));
    expect(adapter.listTaskOutcomes({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Promotions CRUD
// ---------------------------------------------------------------------------

function promotionFixture(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'promo-1',
    agent_id: 'agent-a',
    previous_tier: 1,
    new_tier: 2,
    promoted: 1,
    demoted: 0,
    reason: 'Consecutive successes',
    created_at: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

describe('insertPromotion / listPromotions', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(() => {
    ({ adapter, db } = makeAdapter());
  });

  afterEach(() => {
    db.close();
  });

  it('listPromotions returns empty array when no entries exist', () => {
    expect(adapter.listPromotions()).toHaveLength(0);
  });

  it('insertPromotion then listPromotions returns the entry', () => {
    adapter.insertPromotion(promotionFixture());
    const results = adapter.listPromotions();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('promo-1');
    expect(results[0].promoted).toBe(1);
  });

  it('listPromotions filters by agentId', () => {
    adapter.insertPromotion(promotionFixture({ id: 'promo-a', agent_id: 'agent-a' }));
    adapter.insertPromotion(promotionFixture({ id: 'promo-b', agent_id: 'agent-b' }));
    const results = adapter.listPromotions({ agentId: 'agent-a' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('promo-a');
  });

  it('listPromotions respects limit', () => {
    adapter.insertPromotion(promotionFixture({ id: 'promo-1' }));
    adapter.insertPromotion(promotionFixture({ id: 'promo-2' }));
    adapter.insertPromotion(promotionFixture({ id: 'promo-3' }));
    expect(adapter.listPromotions({ limit: 2 })).toHaveLength(2);
  });
});
