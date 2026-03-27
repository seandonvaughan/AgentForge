/**
 * Tests for ReportGenerator — P2-4: Data Analyst First Queries
 *
 * All tests use :memory: database for isolation and speed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import type { CostRow, TaskOutcomeRow } from '../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../src/db/database.js';
import { ReportGenerator } from '../../src/analytics/report-generator.js';
import type { ReportSection, AnalyticsReport } from '../../src/analytics/report-generator.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStack(): { adapter: SqliteAdapter; db: AgentDatabase; gen: ReportGenerator } {
  const db = new AgentDatabase({ path: ':memory:' });
  const adapter = new SqliteAdapter({ db });
  const gen = new ReportGenerator(adapter);
  return { adapter, db, gen };
}

function sessionFixture(overrides: Partial<Omit<SessionRow, 'created_at'>> = {}): Omit<SessionRow, 'created_at'> {
  return {
    id: 'sess-1',
    agent_id: 'agent-a',
    agent_name: 'TestAgent',
    model: 'claude-sonnet-4-6',
    task: 'Test task',
    response: null,
    status: 'completed',
    started_at: '2026-03-27T00:00:00Z',
    completed_at: '2026-03-27T00:01:00Z',
    estimated_tokens: null,
    autonomy_tier: 1,
    resume_count: 0,
    parent_session_id: null,
    delegation_depth: 0,
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
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function outcomeFixture(overrides: Partial<TaskOutcomeRow> = {}): TaskOutcomeRow {
  return {
    id: 'out-1',
    session_id: 'sess-1',
    agent_id: 'agent-a',
    task: 'Test task',
    success: 1,
    quality_score: null,
    model: 'claude-sonnet-4-6',
    duration_ms: 1000,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ReportSection shape helper
// ---------------------------------------------------------------------------

function expectSectionShape(section: ReportSection, expectedTitle: string): void {
  expect(section).toHaveProperty('title', expectedTitle);
  expect(section).toHaveProperty('rows');
  expect(Array.isArray(section.rows)).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests: spendBySprint
// ---------------------------------------------------------------------------

describe('ReportGenerator.spendBySprint()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns correct section shape', async () => {
    const section = await gen.spendBySprint();
    expectSectionShape(section, 'Spend by Sprint');
  });

  it('returns No data available when DB is empty', async () => {
    const section = await gen.spendBySprint();
    expect(section.rows).toHaveLength(0);
    expect(section.summary).toBe('No data available');
  });

  it('groups sessions by detected sprint pattern', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1', task: 'Implement v4.5 feature' }));
    adapter.insertSession(sessionFixture({ id: 'sess-2', task: 'Fix bug in v4.6' }));
    adapter.insertSession(sessionFixture({ id: 'sess-3', task: 'Unrelated task' }));

    adapter.insertCost(costFixture({ id: 'c1', session_id: 'sess-1', agent_id: 'agent-a', cost_usd: 0.01 }));
    adapter.insertCost(costFixture({ id: 'c2', session_id: 'sess-2', agent_id: 'agent-b', cost_usd: 0.02 }));
    adapter.insertCost(costFixture({ id: 'c3', session_id: 'sess-3', agent_id: 'agent-c', cost_usd: 0.03 }));

    const section = await gen.spendBySprint();
    const sprints = section.rows.map(r => r.sprint);

    expect(sprints).toContain('v4.5');
    expect(sprints).toContain('v4.6');
    expect(sprints).toContain('Unknown');
  });

  it('accumulates cost correctly within a sprint', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1', task: 'Task for v4.7' }));
    adapter.insertCost(costFixture({ id: 'c1', session_id: 'sess-1', agent_id: 'a1', cost_usd: 0.001 }));
    adapter.insertCost(costFixture({ id: 'c2', session_id: 'sess-1', agent_id: 'a2', cost_usd: 0.002 }));

    const section = await gen.spendBySprint();
    const v47row = section.rows.find(r => r.sprint === 'v4.7');
    expect(v47row).toBeDefined();
    expect(v47row!.total_cost_usd).toBe('0.0030');
  });

  it('summary includes grand total and sprint count', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1', task: 'Task v4.5' }));
    adapter.insertCost(costFixture({ id: 'c1', session_id: 'sess-1', cost_usd: 0.005 }));

    const section = await gen.spendBySprint();
    expect(section.summary).toMatch(/Total spend/);
    expect(section.summary).toMatch(/sprint/);
  });
});

// ---------------------------------------------------------------------------
// Tests: topExpensiveAgents
// ---------------------------------------------------------------------------

describe('ReportGenerator.topExpensiveAgents()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns correct section shape', async () => {
    const section = await gen.topExpensiveAgents();
    expectSectionShape(section, 'Top 10 Most Expensive Agents');
  });

  it('returns No data available when no costs', async () => {
    const section = await gen.topExpensiveAgents();
    expect(section.rows).toHaveLength(0);
    expect(section.summary).toBe('No data available');
  });

  it('aggregates cost per agent and sorts descending', async () => {
    adapter.insertCost(costFixture({ id: 'c1', agent_id: 'cheap-agent', cost_usd: 0.001, session_id: null }));
    adapter.insertCost(costFixture({ id: 'c2', agent_id: 'costly-agent', cost_usd: 0.5, session_id: null }));
    adapter.insertCost(costFixture({ id: 'c3', agent_id: 'costly-agent', cost_usd: 0.3, session_id: null }));

    const section = await gen.topExpensiveAgents();
    expect(section.rows[0].agent_id).toBe('costly-agent');
    expect(section.rows[0].total_cost_usd).toBe('0.8000');
    expect(section.rows[0].invocations).toBe(2);
  });

  it('limits results to top 10', async () => {
    for (let i = 0; i < 15; i++) {
      adapter.insertCost(costFixture({
        id: `c${i}`,
        agent_id: `agent-${i}`,
        cost_usd: i * 0.001,
        session_id: null,
      }));
    }

    const section = await gen.topExpensiveAgents();
    expect(section.rows.length).toBeLessThanOrEqual(10);
  });

  it('formats costs to 4 decimal places', async () => {
    adapter.insertCost(costFixture({ id: 'c1', agent_id: 'agent-a', cost_usd: 0.12345, session_id: null }));

    const section = await gen.topExpensiveAgents();
    expect(section.rows[0].total_cost_usd).toMatch(/^\d+\.\d{4}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: successRateByModel
// ---------------------------------------------------------------------------

describe('ReportGenerator.successRateByModel()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns correct section shape', async () => {
    const section = await gen.successRateByModel();
    expectSectionShape(section, 'Success Rate by Model');
  });

  it('returns No data available when no outcomes', async () => {
    const section = await gen.successRateByModel();
    expect(section.rows).toHaveLength(0);
    expect(section.summary).toBe('No data available');
  });

  it('computes success rate correctly', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1' }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o1', session_id: 'sess-1', model: 'claude-opus', success: 1 }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o2', session_id: 'sess-1', model: 'claude-opus', success: 1 }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o3', session_id: 'sess-1', model: 'claude-opus', success: 0 }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o4', session_id: 'sess-1', model: 'claude-haiku', success: 1 }));

    const section = await gen.successRateByModel();
    const opusRow = section.rows.find(r => r.model === 'claude-opus');
    expect(opusRow).toBeDefined();
    expect(opusRow!.success_rate).toBe('66.7%');
    expect(opusRow!.total_tasks).toBe(3);

    const haikuRow = section.rows.find(r => r.model === 'claude-haiku');
    expect(haikuRow!.success_rate).toBe('100.0%');
  });

  it('formats success rates as percentages', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1' }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o1', session_id: 'sess-1', model: 'model-x', success: 1 }));

    const section = await gen.successRateByModel();
    expect(section.rows[0].success_rate).toMatch(/^\d+\.\d+%$/);
  });

  it('summary includes overall success rate', async () => {
    adapter.insertSession(sessionFixture({ id: 'sess-1' }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o1', session_id: 'sess-1', model: 'model-x', success: 1 }));
    adapter.insertTaskOutcome(outcomeFixture({ id: 'o2', session_id: 'sess-1', model: 'model-x', success: 0 }));

    const section = await gen.successRateByModel();
    expect(section.summary).toMatch(/Overall success rate/);
    expect(section.summary).toMatch(/50\.0%/);
  });
});

// ---------------------------------------------------------------------------
// Tests: costTrendByDay
// ---------------------------------------------------------------------------

describe('ReportGenerator.costTrendByDay()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns correct section shape', async () => {
    const section = await gen.costTrendByDay();
    expectSectionShape(section, 'Cost Trend (Last 30 Days)');
  });

  it('returns No data available when no recent costs', async () => {
    // Insert a cost from far in the past
    adapter.insertCost(costFixture({
      id: 'c1',
      cost_usd: 0.01,
      session_id: null,
      created_at: '2020-01-01T00:00:00Z',
    }));

    const section = await gen.costTrendByDay();
    expect(section.rows).toHaveLength(0);
    expect(section.summary).toBe('No data available');
  });

  it('groups costs by date and sums correctly', async () => {
    const today = new Date().toISOString();
    adapter.insertCost(costFixture({ id: 'c1', cost_usd: 0.01, session_id: null, created_at: today }));
    adapter.insertCost(costFixture({ id: 'c2', cost_usd: 0.02, session_id: null, created_at: today }));

    const section = await gen.costTrendByDay();
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0].total_cost_usd).toBe('0.0300');
    expect(section.rows[0].invocations).toBe(2);
  });

  it('rows are sorted by date ascending', async () => {
    const d1 = new Date();
    d1.setUTCDate(d1.getUTCDate() - 2);
    const d2 = new Date();
    d2.setUTCDate(d2.getUTCDate() - 1);

    adapter.insertCost(costFixture({ id: 'c1', cost_usd: 0.01, session_id: null, created_at: d2.toISOString() }));
    adapter.insertCost(costFixture({ id: 'c2', cost_usd: 0.02, session_id: null, created_at: d1.toISOString() }));

    const section = await gen.costTrendByDay();
    expect(section.rows[0].date < section.rows[1].date).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: delegationDepthDistribution
// ---------------------------------------------------------------------------

describe('ReportGenerator.delegationDepthDistribution()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns correct section shape', async () => {
    const section = await gen.delegationDepthDistribution();
    expectSectionShape(section, 'Delegation Depth Distribution');
  });

  it('returns No data available when no sessions', async () => {
    const section = await gen.delegationDepthDistribution();
    expect(section.rows).toHaveLength(0);
    expect(section.summary).toBe('No data available');
  });

  it('correctly counts sessions by depth bucket', async () => {
    adapter.insertSession(sessionFixture({ id: 's1', delegation_depth: 0 }));
    adapter.insertSession(sessionFixture({ id: 's2', delegation_depth: 0 }));
    adapter.insertSession(sessionFixture({ id: 's3', delegation_depth: 1 }));
    adapter.insertSession(sessionFixture({ id: 's4', delegation_depth: 2 }));
    adapter.insertSession(sessionFixture({ id: 's5', delegation_depth: 3 }));
    adapter.insertSession(sessionFixture({ id: 's6', delegation_depth: 5 }));

    const section = await gen.delegationDepthDistribution();
    const depth0 = section.rows.find(r => r.delegation_depth === '0');
    const depth1 = section.rows.find(r => r.delegation_depth === '1');
    const depth3plus = section.rows.find(r => r.delegation_depth === '3+');

    expect(depth0!.session_count).toBe(2);
    expect(depth1!.session_count).toBe(1);
    expect(depth3plus!.session_count).toBe(2);
  });

  it('percentages are formatted as strings with % sign', async () => {
    adapter.insertSession(sessionFixture({ id: 's1', delegation_depth: 0 }));

    const section = await gen.delegationDepthDistribution();
    for (const row of section.rows) {
      expect(String(row.percentage)).toMatch(/%$/);
    }
  });

  it('summary includes total sessions and max depth', async () => {
    adapter.insertSession(sessionFixture({ id: 's1', delegation_depth: 0 }));
    adapter.insertSession(sessionFixture({ id: 's2', delegation_depth: 4 }));

    const section = await gen.delegationDepthDistribution();
    expect(section.summary).toMatch(/2 total session/);
    expect(section.summary).toMatch(/max depth: 4/);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateAll
// ---------------------------------------------------------------------------

describe('ReportGenerator.generateAll()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
  });

  afterEach(() => {
    db.close();
  });

  it('returns AnalyticsReport with all 5 sections', async () => {
    const report = await gen.generateAll();

    expect(report).toHaveProperty('title', 'AgentForge Analytics Report');
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('sections');
    expect(report.sections).toHaveLength(5);
  });

  it('section titles match the expected report names', async () => {
    const report = await gen.generateAll();
    const titles = report.sections.map(s => s.title);

    expect(titles).toContain('Spend by Sprint');
    expect(titles).toContain('Top 10 Most Expensive Agents');
    expect(titles).toContain('Success Rate by Model');
    expect(titles).toContain('Cost Trend (Last 30 Days)');
    expect(titles).toContain('Delegation Depth Distribution');
  });

  it('generatedAt is a valid ISO date string', async () => {
    const report = await gen.generateAll();
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt.substring(0, 24) + report.generatedAt.substring(24));
  });
});

// ---------------------------------------------------------------------------
// Tests: saveReport
// ---------------------------------------------------------------------------

describe('ReportGenerator.saveReport()', () => {
  let adapter: SqliteAdapter;
  let db: AgentDatabase;
  let gen: ReportGenerator;
  let tmpPath: string;

  beforeEach(() => {
    ({ adapter, db, gen } = makeStack());
    tmpPath = join(tmpdir(), `report-test-${Date.now()}.json`);
  });

  afterEach(async () => {
    db.close();
    try { await unlink(tmpPath); } catch { /* ignore */ }
  });

  it('writes valid JSON to the output path', async () => {
    const report = await gen.generateAll();
    await gen.saveReport(report, tmpPath);

    const raw = await readFile(tmpPath, 'utf8');
    const parsed: AnalyticsReport = JSON.parse(raw);

    expect(parsed.title).toBe('AgentForge Analytics Report');
    expect(parsed.sections).toHaveLength(5);
  });
});
