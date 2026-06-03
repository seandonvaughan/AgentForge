import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceAdapter } from '../workspace-adapter.js';

const mockNowIso = vi.hoisted(() => vi.fn(() => '2026-06-03T12:00:00.000Z'));

vi.mock('@agentforge/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentforge/shared')>();
  return {
    ...actual,
    nowIso: mockNowIso,
  };
});

function buildAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-hardening' });
}

describe('WorkspaceAdapter hardening', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    mockNowIso.mockReset();
    mockNowIso.mockReturnValue('2026-06-03T12:00:00.000Z');
    adapter = buildAdapter();
  });

  afterEach(() => {
    adapter.close();
  });

  it('sets a 5000ms busy_timeout pragma on open', () => {
    const db = adapter.getRawDb();
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });

  it('getCostsSince returns only indexed created_at matches at or after the cutoff', () => {
    mockNowIso.mockReturnValueOnce('2026-06-03T10:00:00.000Z');
    adapter.recordCost({
      agentId: 'agent-a',
      model: 'sonnet',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
    });

    mockNowIso.mockReturnValueOnce('2026-06-03T11:00:00.000Z');
    adapter.recordCost({
      agentId: 'agent-a',
      model: 'sonnet',
      inputTokens: 30,
      outputTokens: 40,
      costUsd: 0.002,
    });

    mockNowIso.mockReturnValueOnce('2026-06-03T12:00:00.000Z');
    adapter.recordCost({
      agentId: 'agent-b',
      model: 'opus',
      inputTokens: 50,
      outputTokens: 60,
      costUsd: 0.003,
    });

    const midpointIso = '2026-06-03T10:30:00.000Z';
    const costs = adapter.getCostsSince(midpointIso);
    expect(costs).toHaveLength(2);
    expect(costs.map(c => c.cost_usd).sort()).toEqual([0.002, 0.003]);
  });

  it('markStaleJobsAsFailed fails only running jobs updated before the cutoff', () => {
    const oldJob1 = adapter.createRuntimeJob({
      id: 'old-job-1',
      sessionId: 'old-session-1',
      agentId: 'agent-a',
      task: 'old task 1',
      status: 'running',
      createdAt: '2026-06-03T09:00:00.000Z',
    });
    const oldJob2 = adapter.createRuntimeJob({
      id: 'old-job-2',
      sessionId: 'old-session-2',
      agentId: 'agent-a',
      task: 'old task 2',
      status: 'running',
      createdAt: '2026-06-03T09:30:00.000Z',
    });
    const freshJob = adapter.createRuntimeJob({
      id: 'fresh-job',
      sessionId: 'fresh-session',
      agentId: 'agent-a',
      task: 'fresh task',
      status: 'running',
      createdAt: '2026-06-03T11:30:00.000Z',
    });

    const cutoffIso = '2026-06-03T10:00:00.000Z';
    expect(adapter.markStaleJobsAsFailed(cutoffIso)).toBe(2);
    expect(adapter.getRuntimeJob(oldJob1.id)!.status).toBe('failed');
    expect(adapter.getRuntimeJob(oldJob2.id)!.status).toBe('failed');
    expect(adapter.getRuntimeJob(freshJob.id)!.status).toBe('running');
  });

  it('recordSessionOutcome uses nowIso for scorecard last_updated', () => {
    const fixedIso = '2026-06-03T15:45:00.000Z';
    mockNowIso.mockReturnValue(fixedIso);

    adapter.recordSessionOutcome('score-agent', 'completed', 0.004, 123);

    const row = adapter
      .getRawDb()
      .prepare('SELECT last_updated FROM agent_scorecards WHERE agent_id = ?')
      .get('score-agent') as { last_updated: string };
    expect(row.last_updated).toBe(fixedIso);
  });
});
