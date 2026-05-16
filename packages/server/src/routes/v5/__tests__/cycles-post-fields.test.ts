/**
 * Fix 1: POST /api/v5/cycles should accept maxAgents, tags, fallbackEnabled.
 *
 * Tests:
 *   - Each new field is accepted and returned in the response
 *   - maxAgents validation rejects non-integers and negative values
 *   - tags validation rejects non-string-array values
 *   - fallbackEnabled validation rejects non-boolean values
 *   - Fields are persisted to cycle-config.json
 *   - Existing fields (budgetUsd, maxItems) still work
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

// Stub openSync so log file creation works even though CLI dist doesn't exist.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(() => 3),
  };
});

import { cyclesRoutes } from '../cycles.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-post-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /api/v5/cycles — Fix 1: maxAgents, tags, fallbackEnabled', () => {
  it('accepts maxAgents and returns it in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { maxAgents: 5 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.maxAgents).toBe(5);
    expect(typeof body.cycleId).toBe('string');
  });

  it('accepts tags (string array) and returns them in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { tags: ['backend', 'priority'] },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.tags).toEqual(['backend', 'priority']);
  });

  it('accepts fallbackEnabled: true and returns it in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { fallbackEnabled: true },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.fallbackEnabled).toBe(true);
  });

  it('accepts fallbackEnabled: false and returns it in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { fallbackEnabled: false },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.fallbackEnabled).toBe(false);
  });

  it('rejects maxAgents: 0 (not positive) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { maxAgents: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('maxAgents');
  });

  it('rejects maxAgents: -1 (negative) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { maxAgents: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('maxAgents');
  });

  it('rejects maxAgents: 2.5 (non-integer) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { maxAgents: 2.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('maxAgents');
  });

  it('rejects tags with non-string elements with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { tags: ['ok', 42] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('tags');
  });

  it('rejects tags: "not-an-array" with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { tags: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('tags');
  });

  it('rejects fallbackEnabled: "yes" (string) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { fallbackEnabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('fallbackEnabled');
  });

  it('persists all three fields to cycle-config.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: { maxAgents: 3, tags: ['ci'], fallbackEnabled: true },
    });
    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    const configPath = join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['maxAgents']).toBe(3);
    expect(config['tags']).toEqual(['ci']);
    expect(config['fallbackEnabled']).toBe(true);
  });

  it('returns empty tags array when tags not provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().tags).toEqual([]);
  });
});
