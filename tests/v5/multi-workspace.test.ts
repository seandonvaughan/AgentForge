import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkspaceAggregator, WorkspaceSummary } from '../../packages/core/src/multi-workspace/index.js';
import { createServerV5 } from '../../packages/server/src/server.js';

// ── Unit tests: WorkspaceAggregator ───────────────────────────────────────────

const makeSummary = (id: string, cost: number, sessions: number): WorkspaceSummary => ({
  workspaceId: id,
  name: `Workspace ${id}`,
  totalCostUsd: cost,
  sessionCount: sessions,
  activeAgents: 1,
  lastActivityAt: new Date().toISOString(),
});

describe('WorkspaceAggregator.aggregate()', () => {
  const agg = new WorkspaceAggregator();

  it('returns empty view for empty input', () => {
    const view = agg.aggregate([]);
    expect(view.workspaces).toHaveLength(0);
    expect(view.combinedCostUsd).toBe(0);
    expect(view.combinedSessionCount).toBe(0);
    expect(view.highestCostWorkspaceId).toBeNull();
    expect(view.costRanking).toHaveLength(0);
  });

  it('computes combinedCostUsd correctly', () => {
    const summaries = [makeSummary('a', 10, 5), makeSummary('b', 20, 3), makeSummary('c', 5, 1)];
    const view = agg.aggregate(summaries);
    expect(view.combinedCostUsd).toBeCloseTo(35);
  });

  it('computes combinedSessionCount correctly', () => {
    const summaries = [makeSummary('a', 10, 5), makeSummary('b', 20, 3)];
    const view = agg.aggregate(summaries);
    expect(view.combinedSessionCount).toBe(8);
  });

  it('identifies highestCostWorkspaceId correctly', () => {
    const summaries = [makeSummary('cheap', 1, 1), makeSummary('expensive', 100, 1)];
    const view = agg.aggregate(summaries);
    expect(view.highestCostWorkspaceId).toBe('expensive');
  });

  it('ranks workspaces by cost (rank 1 = highest)', () => {
    const summaries = [makeSummary('a', 5, 1), makeSummary('b', 50, 1), makeSummary('c', 20, 1)];
    const view = agg.aggregate(summaries);
    const ranking = view.costRanking;
    expect(ranking[0].workspaceId).toBe('b');
    expect(ranking[0].rank).toBe(1);
    expect(ranking[1].workspaceId).toBe('c');
    expect(ranking[1].rank).toBe(2);
    expect(ranking[2].workspaceId).toBe('a');
    expect(ranking[2].rank).toBe(3);
  });

  it('includes generatedAt as valid ISO timestamp', () => {
    const view = agg.aggregate([makeSummary('x', 1, 1)]);
    expect(() => new Date(view.generatedAt)).not.toThrow();
    expect(new Date(view.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('preserves all workspace summaries in the view', () => {
    const summaries = [makeSummary('x', 1, 1), makeSummary('y', 2, 2)];
    const view = agg.aggregate(summaries);
    expect(view.workspaces).toHaveLength(2);
    expect(view.workspaces[0].workspaceId).toBe('x');
    expect(view.workspaces[1].workspaceId).toBe('y');
  });

  it('single workspace gets rank 1 and is highest cost', () => {
    const view = agg.aggregate([makeSummary('solo', 42, 7)]);
    expect(view.highestCostWorkspaceId).toBe('solo');
    expect(view.costRanking[0].rank).toBe(1);
  });
});

describe('WorkspaceAggregator.compare()', () => {
  const agg = new WorkspaceAggregator();

  it('computes costDiffUsd as left minus right', () => {
    const left = makeSummary('l', 30, 5);
    const right = makeSummary('r', 10, 2);
    const cmp = agg.compare(left, right);
    expect(cmp.costDiffUsd).toBeCloseTo(20);
  });

  it('computes sessionCountDiff as left minus right', () => {
    const cmp = agg.compare(makeSummary('l', 10, 8), makeSummary('r', 5, 3));
    expect(cmp.sessionCountDiff).toBe(5);
  });

  it('reports higherCost as "left" when left costs more', () => {
    const cmp = agg.compare(makeSummary('l', 50, 1), makeSummary('r', 10, 1));
    expect(cmp.higherCost).toBe('left');
  });

  it('reports higherCost as "right" when right costs more', () => {
    const cmp = agg.compare(makeSummary('l', 5, 1), makeSummary('r', 20, 1));
    expect(cmp.higherCost).toBe('right');
  });

  it('reports higherCost as "equal" when costs are the same', () => {
    const cmp = agg.compare(makeSummary('l', 10, 1), makeSummary('r', 10, 1));
    expect(cmp.higherCost).toBe('equal');
  });

  it('preserves left and right summaries in comparison object', () => {
    const left = makeSummary('lws', 10, 1);
    const right = makeSummary('rws', 5, 1);
    const cmp = agg.compare(left, right);
    expect(cmp.left.workspaceId).toBe('lws');
    expect(cmp.right.workspaceId).toBe('rws');
  });
});

// ── HTTP route tests ───────────────────────────────────────────────────────────

describe('GET /api/v5/workspaces/summary', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4852, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns 200 with data and meta', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/workspaces/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(typeof body.data.combinedCostUsd).toBe('number');
    expect(typeof body.data.combinedSessionCount).toBe('number');
    expect(Array.isArray(body.data.costRanking)).toBe(true);
    expect(Array.isArray(body.data.workspaces)).toBe(true);
  });

  it('returns at least 2 workspaces in the default view', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/workspaces/summary' });
    const body = JSON.parse(res.body);
    expect(body.data.workspaces.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/v5/workspaces/compare', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4853, listen: false });
  });

  afterAll(() => server.app.close());

  it('returns 400 when leftId or rightId are missing', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/workspaces/compare' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when leftId is unknown', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v5/workspaces/compare?leftId=unknown&rightId=ws-default',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns comparison data for two valid workspaces', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v5/workspaces/compare?leftId=ws-default&rightId=ws-staging',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.left.workspaceId).toBe('ws-default');
    expect(body.data.right.workspaceId).toBe('ws-staging');
    expect(typeof body.data.costDiffUsd).toBe('number');
    expect(['left', 'right', 'equal']).toContain(body.data.higherCost);
  });
});
