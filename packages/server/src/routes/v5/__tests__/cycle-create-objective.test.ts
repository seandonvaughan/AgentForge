import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync as fsExistsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: () => null,
  list: () => [],
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: () => {},
  markTerminal: () => {},
  stop: async () => ({ ok: true, status: 'killed', message: 'mocked' }),
  isPidAlive: () => false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      pid: 12345,
      once: vi.fn(),
      unref: vi.fn(),
    })),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
      if (String(path).endsWith('packages/cli/dist/bin.js')) return true;
      return actual.existsSync(path);
    }),
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
  };
});

import { cyclesRoutes } from '../cycles.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-create-objective-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('POST /api/v5/cycles objective launch fields', () => {
  it('accepts objective and budgetUsd, persists them, and starts an objective cycle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: {
        objective: 'Ship the objective dashboard launch path',
        budgetUsd: 42.5,
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { cycleId: string; objective?: string; budgetUsd?: number };
    expect(body.objective).toBe('Ship the objective dashboard launch path');
    expect(body.budgetUsd).toBe(42.5);

    const configPath = join(tmpRoot, '.agentforge/cycles', body.cycleId, 'cycle-config.json');
    expect(fsExistsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['objective']).toBe('Ship the objective dashboard launch path');
    expect(config['budgetUsd']).toBe(42.5);

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args).toEqual([
      expect.stringContaining('packages/cli/dist/bin.js'),
      'cycle',
      'run',
      '--objective',
      'Ship the objective dashboard launch path',
    ]);
    const env = spawnMock.mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(env?.['AUTONOMOUS_BUDGET_USD']).toBe('42.5');
  });

  it('rejects invalid objective and budgetUsd values with 400', async () => {
    const blankObjective = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '   ' },
    });
    expect(blankObjective.statusCode).toBe(400);
    expect(blankObjective.json().error).toContain('objective');

    const negativeBudget = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Build objective mode', budgetUsd: -1 },
    });
    expect(negativeBudget.statusCode).toBe(400);
    expect(negativeBudget.json().error).toContain('budgetUsd');
  });

  it('keeps signal-backlog cycle creation working when objective is omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: 12 },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { cycleId: string; objective?: string; budgetUsd?: number };
    expect(body.objective).toBeNull();
    expect(body.budgetUsd).toBe(12);

    const configPath = join(tmpRoot, '.agentforge/cycles', body.cycleId, 'cycle-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['objective']).toBeNull();
    expect(config['budgetUsd']).toBe(12);

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args).toEqual([
      expect.stringContaining('packages/cli/dist/bin.js'),
      'cycle',
      'run',
    ]);
  });
});
