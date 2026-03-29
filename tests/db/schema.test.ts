/**
 * Tests for unified SQLite audit schema (P0-1) and delegation chain model (P0-7)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase, CREATE_TABLES_SQL, CREATE_INDEXES_SQL, ALL_DDL } from '../../src/db/index.js';

// Helper to build a fresh in-memory DB for each test
function makeDb(): AgentDatabase {
  return new AgentDatabase({ path: ':memory:' });
}

// Minimal session fixture
function sessionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess-root',
    agent_id: 'agent-1',
    agent_name: 'TestAgent',
    model: 'claude-opus-4',
    task: 'Write tests',
    response: null,
    status: 'completed',
    started_at: '2026-03-27T00:00:00Z',
    completed_at: '2026-03-27T00:01:00Z',
    estimated_tokens: null,
    autonomy_tier: 2,
    resume_count: 0,
    parent_session_id: null,
    delegation_depth: 0,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// Schema export tests
// ──────────────────────────────────────────────────────────────────

describe('schema exports', () => {
  it('exports CREATE_TABLES_SQL as a non-empty array', () => {
    expect(Array.isArray(CREATE_TABLES_SQL)).toBe(true);
    expect(CREATE_TABLES_SQL.length).toBeGreaterThan(0);
  });

  it('exports exactly 15 CREATE TABLE statements', () => {
    expect(CREATE_TABLES_SQL).toHaveLength(15);
  });

  it('exports CREATE_INDEXES_SQL as a non-empty array', () => {
    expect(Array.isArray(CREATE_INDEXES_SQL)).toBe(true);
    expect(CREATE_INDEXES_SQL.length).toBeGreaterThan(0);
  });

  it('exports exactly 26 CREATE INDEX statements', () => {
    expect(CREATE_INDEXES_SQL).toHaveLength(26);
  });

  it('ALL_DDL combines tables + indexes in order', () => {
    expect(ALL_DDL).toHaveLength(CREATE_TABLES_SQL.length + CREATE_INDEXES_SQL.length);
    expect(ALL_DDL[0]).toBe(CREATE_TABLES_SQL[0]);
    expect(ALL_DDL[CREATE_TABLES_SQL.length]).toBe(CREATE_INDEXES_SQL[0]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Table creation tests
// ──────────────────────────────────────────────────────────────────

describe('table creation', () => {
  let db: AgentDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  const expectedTables = [
    'sessions',
    'feedback',
    'task_outcomes',
    'promotions',
    'agent_costs',
    'agent_autonomy',
  ];

  for (const table of expectedTables) {
    it(`creates table: ${table}`, () => {
      const row = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe(table);
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// Index creation tests
// ──────────────────────────────────────────────────────────────────

describe('index creation', () => {
  let db: AgentDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  const expectedIndexes = [
    { table: 'sessions', index: 'idx_sessions_created_at' },
    { table: 'sessions', index: 'idx_sessions_agent_id' },
    { table: 'sessions', index: 'idx_sessions_parent' },
    { table: 'feedback', index: 'idx_feedback_created_at' },
    { table: 'task_outcomes', index: 'idx_task_outcomes_session' },
    { table: 'task_outcomes', index: 'idx_task_outcomes_created_at' },
    { table: 'agent_costs', index: 'idx_agent_costs_session' },
    { table: 'agent_costs', index: 'idx_agent_costs_created_at' },
    { table: 'promotions', index: 'idx_promotions_agent' },
    { table: 'promotions', index: 'idx_promotions_created_at' },
    { table: 'agent_autonomy', index: 'idx_agent_autonomy_updated_at' },
  ];

  for (const { table, index } of expectedIndexes) {
    it(`creates index ${index} on ${table}`, () => {
      const row = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index) as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe(index);
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// sessions table schema (P0-7 columns)
// ──────────────────────────────────────────────────────────────────

describe('sessions table columns (P0-7)', () => {
  let db: AgentDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function getColumnNames(): string[] {
    const rows = db.getDb().pragma('table_info(sessions)') as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  it('has parent_session_id column', () => {
    expect(getColumnNames()).toContain('parent_session_id');
  });

  it('has delegation_depth column', () => {
    expect(getColumnNames()).toContain('delegation_depth');
  });

  it('delegation_depth defaults to 0', () => {
    const rawDb = db.getDb();
    const fixture = sessionFixture();
    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fixture.id, fixture.agent_id, fixture.task, fixture.status, fixture.started_at);

    const row = rawDb.prepare('SELECT delegation_depth FROM sessions WHERE id=?').get(fixture.id) as { delegation_depth: number };
    expect(row.delegation_depth).toBe(0);
  });

  it('parent_session_id is nullable', () => {
    const rawDb = db.getDb();
    const fixture = sessionFixture();
    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fixture.id, fixture.agent_id, fixture.task, fixture.status, fixture.started_at);

    const row = rawDb.prepare('SELECT parent_session_id FROM sessions WHERE id=?').get(fixture.id) as { parent_session_id: null };
    expect(row.parent_session_id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// WAL mode + foreign keys
// ──────────────────────────────────────────────────────────────────

describe('database pragmas', () => {
  let db: AgentDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('WAL journal mode is enabled', () => {
    const result = db.getDb().pragma('journal_mode') as Array<{ journal_mode: string }>;
    // :memory: always returns 'memory' journal mode — WAL pragma is accepted but has no effect
    expect(['wal', 'memory']).toContain(result[0].journal_mode);
  });

  it('foreign keys are enforced', () => {
    const result = db.getDb().pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);
  });

  it('inserting a session with invalid parent_session_id fails', () => {
    const rawDb = db.getDb();
    expect(() => {
      rawDb.prepare(`
        INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('child-1', 'agent-1', 'task', 'pending', '2026-01-01', 'non-existent-parent', 1);
    }).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────
// getSessionTree — delegation chain traversal (P0-7)
// ──────────────────────────────────────────────────────────────────

describe('getSessionTree', () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = makeDb();
    const rawDb = db.getDb();

    // Insert 3-level chain: root -> child -> grandchild
    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('root', 'agent-root', 'root task', 'completed', '2026-01-01T00:00:00Z', null, 0);

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('child', 'agent-child', 'child task', 'completed', '2026-01-01T00:01:00Z', 'root', 1);

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('grandchild', 'agent-gc', 'grandchild task', 'completed', '2026-01-01T00:02:00Z', 'child', 2);
  });

  afterEach(() => { db.close(); });

  it('returns empty array for non-existent rootId', () => {
    expect(db.getSessionTree('does-not-exist')).toEqual([]);
  });

  it('returns single-element array for leaf node with no children', () => {
    const tree = db.getSessionTree('grandchild');
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('grandchild');
  });

  it('returns 3 rows for root of a 3-level chain', () => {
    const tree = db.getSessionTree('root');
    expect(tree).toHaveLength(3);
  });

  it('first result is the root session (depth 0)', () => {
    const tree = db.getSessionTree('root');
    expect(tree[0].id).toBe('root');
    expect(tree[0].delegation_depth).toBe(0);
  });

  it('results are ordered by delegation_depth ascending', () => {
    const tree = db.getSessionTree('root');
    const depths = tree.map(r => r.delegation_depth);
    expect(depths).toEqual([0, 1, 2]);
  });

  it('all ids are present in the tree', () => {
    const tree = db.getSessionTree('root');
    const ids = tree.map(r => r.id);
    expect(ids).toContain('root');
    expect(ids).toContain('child');
    expect(ids).toContain('grandchild');
  });

  it('child node has correct parent_session_id', () => {
    const tree = db.getSessionTree('root');
    const child = tree.find(r => r.id === 'child');
    expect(child).toBeDefined();
    expect(child!.parent_session_id).toBe('root');
  });

  it('subtree starting from child returns 2 rows', () => {
    const tree = db.getSessionTree('child');
    expect(tree).toHaveLength(2);
    const ids = tree.map(r => r.id);
    expect(ids).toContain('child');
    expect(ids).toContain('grandchild');
    expect(ids).not.toContain('root');
  });

  it('throws when a session has delegation_depth > 20', () => {
    // Insert a session with depth 21 directly
    db.getDb().prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('deep-session', 'agent-deep', 'deep task', 'pending', '2026-01-01T00:00:00Z', null, 21);

    expect(() => db.getSessionTree('deep-session')).toThrow(/exceeds maximum/);
  });

  it('shallow cycle (both depth 0) terminates via visited-set guard and returns bounded result', () => {
    const rawDb = db.getDb();

    // Create a genuine two-node cycle: cyc-a → cyc-b → cyc-a (back-edge).
    // Both have delegation_depth = 0, so the depth guard never fires.
    // The BFS visited-set prevents re-enqueuing cyc-a when processing cyc-b's children,
    // so traversal terminates and returns both nodes without throwing.

    rawDb.pragma('foreign_keys = OFF');

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shcyc-a', 'ag-a', 'task a', 'pending', '2026-01-01T00:00:00Z', null, 0);

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('shcyc-b', 'ag-b', 'task b', 'pending', '2026-01-01T00:01:00Z', 'shcyc-a', 0);

    // Back-edge: shcyc-a's parent = shcyc-b (creates cycle)
    rawDb.prepare("UPDATE sessions SET parent_session_id = 'shcyc-b' WHERE id = 'shcyc-a'").run();

    rawDb.pragma('foreign_keys = ON');

    // BFS visited-set prevents infinite loop; result is bounded (2 nodes)
    const result = db.getSessionTree('shcyc-a');
    expect(result.length).toBe(2);
    const ids = result.map(r => r.id);
    expect(ids).toContain('shcyc-a');
    expect(ids).toContain('shcyc-b');
  });

  it('throws when traversing a cycle with corrupted delegation_depth', () => {
    const rawDb = db.getDb();

    // Set up a two-node cycle: cyc-a ↔ cyc-b.
    // In practice, a real cycle would cause delegation_depth to grow unbounded;
    // we simulate the corrupted state by setting cyc-b's depth to 21 and creating
    // the back-edge via FK-off UPDATE. getSessionTree detects this via the depth guard.

    rawDb.pragma('foreign_keys = OFF');

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('cyc-a', 'ag-a', 'task a', 'pending', '2026-01-01T00:00:00Z', null, 0);

    rawDb.prepare(`
      INSERT INTO sessions (id, agent_id, task, status, started_at, parent_session_id, delegation_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('cyc-b', 'ag-b', 'task b', 'pending', '2026-01-01T00:01:00Z', 'cyc-a', 21);

    // Create the back-edge: cyc-a's parent = cyc-b (bypasses FK enforcement)
    rawDb.prepare("UPDATE sessions SET parent_session_id = 'cyc-b' WHERE id = 'cyc-a'").run();

    rawDb.pragma('foreign_keys = ON');

    // BFS visits cyc-a (depth 0, OK), finds child cyc-b, enqueues it.
    // Dequeues cyc-b: depth 21 > MAX_DELEGATION_DEPTH → throws.
    expect(() => db.getSessionTree('cyc-a')).toThrow(/exceeds maximum/);
  });
});
