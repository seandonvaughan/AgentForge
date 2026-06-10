/**
 * POST /api/v5/cycles — objective + budgetUsd acceptance and validation.
 *
 * Tests:
 *   - objective + budgetUsd are accepted and round-tripped in the 202 response
 *   - objective is persisted to cycle-config.json
 *   - objective: whitespace-only string is rejected with 400
 *   - objective: empty string is rejected with 400
 *   - objective: string > 4000 chars is rejected with 400
 *   - objective: non-string value is rejected with 400
 *   - budgetUsd: zero is rejected with 400
 *   - budgetUsd: negative is rejected with 400
 *   - budgetUsd: Infinity is rejected with 400
 *   - objective is optional (omitting it succeeds)
 *   - objective value is trimmed before persisting
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// Stub fs so the CLI-entry existence check passes and log-file ops are no-ops.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
    // Return true for the CLI binary existence check; delegate all other paths
    // to the real implementation so mkdirSync/writeFileSync/readFileSync work.
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('packages/cli/dist/bin.js')) return true;
      return actual.existsSync(p);
    }),
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
  it('accepts objective and budgetUsd and returns them in the 202 response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Add search indexing pipeline', budgetUsd: 15 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.objective).toBe('Add search indexing pipeline');
    expect(typeof body.cycleId).toBe('string');
  });

  it('persists objective and budgetUsd to cycle-config.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'Refactor auth module', budgetUsd: 25 },
    });
    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    const configPath = join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['objective']).toBe('Refactor auth module');
    expect(config['budgetUsd']).toBe(25);
  });

  it('trims leading/trailing whitespace from objective before persisting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '  Improve test coverage  ' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { cycleId: string; objective?: string };
    expect(body.objective).toBe('Improve test coverage');
    const configPath = join(tmpRoot, '.agentforge/cycles', body.cycleId, 'cycle-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['objective']).toBe('Improve test coverage');
  });

  it('omitting objective still succeeds (objective is optional)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: 10 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.objective).toBeUndefined();
  });

  it('rejects objective: empty string with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects objective: whitespace-only string with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects objective: string longer than 4000 chars with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'x'.repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('accepts objective exactly 4000 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 'x'.repeat(4000) },
    });
    expect(res.statusCode).toBe(202);
  });

  it('rejects objective: number (non-string) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('objective');
  });

  it('rejects objective: array (non-string) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { objective: ['do stuff'] },
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

  it('rejects budgetUsd: -5 (negative) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd');
  });

  it('rejects budgetUsd: Infinity with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { budgetUsd: Infinity },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('budgetUsd');
  });
});
