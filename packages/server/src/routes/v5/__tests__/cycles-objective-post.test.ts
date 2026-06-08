/**
 * POST /api/v5/cycles — objective + budgetUsd acceptance and persistence.
 *
 * Tests:
 *   - valid objective + budgetUsd are accepted, persisted, and returned
 *   - objective is persisted to cycle-config.json and passed via AUTONOMOUS_OBJECTIVE env var
 *   - invalid objective (empty string, non-string) is rejected with 400
 *   - invalid budgetUsd (zero, negative, non-number) is rejected with 400
 *   - back-compat: neither field present → 202 with no objective key in response
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

// Stub cycle-sessions so tests do not touch ~/.agentforge/sessions.json
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

// Stub child_process.spawn so no real subprocess is started.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      pid: 12345,
      unref: () => {},
    })),
  };
});

// Stub openSync/closeSync so log file creation works without a real CLI.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
  };
});

import { cyclesRoutes } from '../cycles.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-objective-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /api/v5/cycles — objective + budgetUsd', () => {
  it('accepts valid objective + budgetUsd and returns them in the 202 response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Add OAuth2 login flow', budgetUsd: 25 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.objective).toBe('Add OAuth2 login flow');
    expect(typeof body.cycleId).toBe('string');
  });

  it('persists objective and budgetUsd to cycle-config.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Refactor auth module', budgetUsd: 50 },
    });
    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    const configPath = join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['objective']).toBe('Refactor auth module');
    expect(config['budgetUsd']).toBe(50);
  });

  it('passes AUTONOMOUS_OBJECTIVE env var to the subprocess', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Implement rate limiting' },
    });
    expect(res.statusCode).toBe(202);
    const spawnMock = vi.mocked(spawn);
    const env = spawnMock.mock.calls.at(-1)?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(env?.['AUTONOMOUS_OBJECTIVE']).toBe('Implement rate limiting');
  });

  it('trims whitespace from objective before persisting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '  Fix flaky tests  ' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { cycleId: string; objective?: string };
    expect(body.objective).toBe('Fix flaky tests');
    const config = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge/cycles', body.cycleId, 'cycle-config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(config['objective']).toBe('Fix flaky tests');
  });

  it('rejects objective as empty string with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects objective as whitespace-only string with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects objective as a number with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects budgetUsd: 0 with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd');
  });

  it('rejects budgetUsd: -5 with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd');
  });

  it('rejects budgetUsd: "50" (string) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: '50' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd');
  });

  it('back-compat: neither objective nor budgetUsd present → 202, no objective key in response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as Record<string, unknown>;
    // objective should be absent (not even set to null) in the 202 response
    expect('objective' in body).toBe(false);
    expect(typeof body['cycleId']).toBe('string');
  });

  it('cycle-config.json objective is null when no objective is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: 10 },
    });
    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    const config = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(config['objective']).toBeNull();
  });
});
