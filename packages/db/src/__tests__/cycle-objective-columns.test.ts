import { describe, it, expect, afterEach } from 'vitest';
import { WorkspaceAdapter } from '../workspace-adapter.js';

let adapter: WorkspaceAdapter | undefined;

function buildAdapter(): WorkspaceAdapter {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'cycle-objective-test' });
  return adapter;
}

afterEach(() => {
  adapter?.close();
  adapter = undefined;
});

describe('WorkspaceAdapter cycle launch config persistence', () => {
  it('creates cycle objective and budget columns in the workspace schema', () => {
    const ad = buildAdapter();
    const columns = ad.getRawDb().prepare('PRAGMA table_info(cycles)').all() as Array<{ name: string; type: string }>;

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'objective', type: 'TEXT' }),
        expect.objectContaining({ name: 'budget_usd', type: 'REAL' }),
        expect.objectContaining({ name: 'config_json', type: 'TEXT' }),
      ]),
    );
  });

  it('round-trips objective and budgetUsd on the cycle row and launch config', () => {
    const ad = buildAdapter();

    const row = ad.persistCycleLaunchConfig({
      cycleId: 'cycle-objective-1',
      objective: 'Ship objective launches through the DB adapter',
      budgetUsd: 12.5,
      config: { runtimeMode: 'codex-cli', fastMode: true },
      createdAt: '2026-06-06T10:00:00.000Z',
      updatedAt: '2026-06-06T10:00:00.000Z',
    });

    expect(row.id).toBe('cycle-objective-1');
    expect(row.objective).toBe('Ship objective launches through the DB adapter');
    expect(row.budget_usd).toBe(12.5);
    expect(JSON.parse(row.config_json)).toEqual({
      runtimeMode: 'codex-cli',
      fastMode: true,
      objective: 'Ship objective launches through the DB adapter',
      budgetUsd: 12.5,
    });

    const fetched = ad.getCycle('cycle-objective-1');
    expect(fetched?.objective).toBe(row.objective);
    expect(fetched?.budget_usd).toBe(row.budget_usd);
  });

  it('does not clear existing optional fields when retrying with partial config', () => {
    const ad = buildAdapter();
    ad.persistCycleLaunchConfig({
      cycleId: 'cycle-objective-retry',
      objective: 'Keep launch metadata',
      budgetUsd: 7,
      config: { runtimeMode: 'codex-cli' },
      createdAt: '2026-06-06T10:00:00.000Z',
      updatedAt: '2026-06-06T10:00:00.000Z',
    });

    const retry = ad.persistCycleLaunchConfig({
      cycleId: 'cycle-objective-retry',
      config: { workspaceId: 'default' },
      updatedAt: '2026-06-06T10:05:00.000Z',
    });

    expect(retry.objective).toBe('Keep launch metadata');
    expect(retry.budget_usd).toBe(7);
    expect(JSON.parse(retry.config_json)).toEqual({
      runtimeMode: 'codex-cli',
      workspaceId: 'default',
      objective: 'Keep launch metadata',
      budgetUsd: 7,
    });
  });
});
