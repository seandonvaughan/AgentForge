/**
 * Fix 3: POST /api/v5/cycles/:id/cancel
 *
 * Tests:
 *   - Happy path: running cycle is cancelled, returns ok: true, status: 'killed'
 *   - Idempotency: cancelling an already-terminal cycle returns 409
 *   - Writes kill-switch.json to cycle dir
 *   - Audit-logged via appendAuditEntry
 *   - Invalid cycle id (unsafe chars) returns 400
 *   - Cycle terminal via cycle.json stage also returns 409
 *   - SSE event emitted on cancel
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// Stub cycle-sessions: default is no session; tests override sessionFixture.
let sessionFixture: Record<string, unknown> | null = null;

vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: (id: string) =>
    sessionFixture && (sessionFixture as Record<string, unknown>)['cycleId'] === id
      ? sessionFixture
      : null,
  list: () => (sessionFixture ? [sessionFixture] : []),
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: () => {},
  markTerminal: vi.fn(),
  stop: vi.fn(async () => ({ ok: true, status: 'killed', message: 'mocked stop' })),
  isPidAlive: () => false,
}));

import { cyclesRoutes } from '../cycles.js';

const CYCLE_ID = 'cccccccc-0000-0000-0000-000000000001';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cancel-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  // Create the .agentforge dir so audit.db can be initialised
  mkdirSync(join(tmpRoot, '.agentforge'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
  sessionFixture = null;
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  sessionFixture = null;
  vi.clearAllMocks();
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('POST /api/v5/cycles/:id/cancel — Fix 3', () => {
  it('happy path: cancels a running cycle and returns ok: true', async () => {
    makeCycleDir(CYCLE_ID);
    sessionFixture = {
      cycleId: CYCLE_ID,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'running',
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cycleId).toBe(CYCLE_ID);
    expect(body.status).toBe('killed');
  });

  it('idempotency: cancelling an already-killed cycle returns 409', async () => {
    makeCycleDir(CYCLE_ID);
    sessionFixture = {
      cycleId: CYCLE_ID,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'killed',
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('terminal');
    expect(res.json().status).toBe('killed');
  });

  it('idempotency: cancelling an already-completed cycle returns 409', async () => {
    makeCycleDir(CYCLE_ID);
    sessionFixture = {
      cycleId: CYCLE_ID,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'completed',
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    expect(res.statusCode).toBe(409);
  });

  it('writes kill-switch.json to the cycle dir on cancel', async () => {
    const dir = makeCycleDir(CYCLE_ID);
    sessionFixture = {
      cycleId: CYCLE_ID,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'running',
    };

    await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    const killSwitchPath = join(dir, 'kill-switch.json');
    expect(existsSync(killSwitchPath)).toBe(true);
  });

  it('creates an audit entry in audit.db when cancel succeeds', async () => {
    makeCycleDir(CYCLE_ID);
    sessionFixture = {
      cycleId: CYCLE_ID,
      pid: 9999,
      pgid: 9999,
      workspaceId: 'default',
      workspaceRoot: tmpRoot,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'running',
    };

    await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    // Verify audit entry directly in the SQLite DB — the audit route is not
    // registered on this app instance (only cyclesRoutes is).
    const auditDbPath = join(tmpRoot, '.agentforge', 'audit.db');
    expect(existsSync(auditDbPath)).toBe(true);
    const db = new Database(auditDbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'cycle.cancel' AND target = ?").all(CYCLE_ID) as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!['actor']).toBe('api');
    expect(rows[0]!['target']).toBe(CYCLE_ID);
  });

  it('returns 400 for an invalid cycle id (unsafe chars)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/bad.id/cancel',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid');
  });

  it('returns 409 when cycle.json shows a terminal stage (no session record)', async () => {
    const dir = makeCycleDir(CYCLE_ID);
    writeFileSync(
      join(dir, 'cycle.json'),
      JSON.stringify({ cycleId: CYCLE_ID, stage: 'completed' }),
    );
    // No session fixture — simulates a server restart after cycle completed

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    expect(res.statusCode).toBe(409);
  });

  it('cancels with no session record (marks killed in registry)', async () => {
    makeCycleDir(CYCLE_ID);
    // No sessionFixture — no session record at all

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/cancel`,
    });

    // Should succeed (best-effort cancel with no session)
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
