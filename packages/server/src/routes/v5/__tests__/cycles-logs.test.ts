/**
 * Unit tests for the cycle log endpoints:
 *   GET /api/v5/cycles/:id/logs/:name        — read raw log text
 *   GET /api/v5/cycles/:id/logs/:name/stream — SSE tail
 *
 * Key invariants:
 *   - SAFE_LOG_NAMES whitelist rejects any name not in { cli-stdout, tests-raw }
 *   - Invalid cycleId characters are rejected with 400
 *   - Non-existent cycles return 404
 *   - Non-existent log files return 404
 *   - Valid log files are returned as text/plain
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

import { cyclesRoutes } from '../cycles.js';

const CYCLE_ID = 'aabbccdd-1122-3344-5566-778899aabbcc';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-logs-test-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(): string {
  const dir = join(tmpRoot, '.agentforge/cycles', CYCLE_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── SAFE_LOG_NAMES whitelist ──────────────────────────────────────────────────

describe('GET /api/v5/cycles/:id/logs/:name — whitelist enforcement', () => {
  it('rejects name not in SAFE_LOG_NAMES with 400', async () => {
    makeCycleDir();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/cycle`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/Invalid log name/i);
  });

  it('rejects path-traversal attempts with 400', async () => {
    makeCycleDir();
    // "../../etc/passwd" would escape the cycle dir — rejected by whitelist first
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/..%2F..%2Fetc%2Fpasswd`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects arbitrary filenames with 400', async () => {
    const dir = makeCycleDir();
    writeFileSync(join(dir, 'secret.log'), 'secret content');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/secret`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid log name/i);
  });

  it('accepts cli-stdout as a valid log name', async () => {
    const dir = makeCycleDir();
    writeFileSync(join(dir, 'cli-stdout.log'), 'hello\nworld\n');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/cli-stdout`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('hello');
  });

  it('accepts tests-raw as a valid log name', async () => {
    const dir = makeCycleDir();
    writeFileSync(join(dir, 'tests-raw.log'), 'PASS test suite\nFAIL something\n');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/tests-raw`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PASS test suite');
  });
});

// ── cycleId validation ────────────────────────────────────────────────────────

describe('GET /api/v5/cycles/:id/logs/:name — cycle id validation', () => {
  it('rejects invalid cycle id characters with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/../logs/cli-stdout',
    });
    // Fastify will either 404 (no matching route) or the handler returns 400
    expect([400, 404]).toContain(res.statusCode);
  });

  it('returns 404 for a non-existent cycle', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/nonexistentcycle/logs/cli-stdout',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── missing log file ──────────────────────────────────────────────────────────

describe('GET /api/v5/cycles/:id/logs/:name — missing log file', () => {
  it('returns 404 when the log file has not been created yet', async () => {
    makeCycleDir(); // cycle dir exists but cli-stdout.log does not
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/cli-stdout`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });
});

// ── stream endpoint whitelist ─────────────────────────────────────────────────

describe('GET /api/v5/cycles/:id/logs/:name/stream — whitelist enforcement', () => {
  it('rejects invalid log name on stream endpoint with 400', async () => {
    makeCycleDir();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/logs/cycle/stream`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid log name/i);
  });

  it('rejects invalid cycle id on stream endpoint with 400 or 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad!id/logs/cli-stdout/stream',
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});
