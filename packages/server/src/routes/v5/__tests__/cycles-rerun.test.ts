/**
 * Fix 4: POST /api/v5/cycles/:id/rerun
 *
 * Tests:
 *   - Spawns a new cycle (202 response with new cycleId)
 *   - New cycleId is different from source cycleId
 *   - sourceCycleId is present in response
 *   - Inherits config from cycle-config.json (budget, maxItems, tags, maxAgents, fallbackEnabled, baseBranch)
 *   - Source cycle id is captured in new cycle-config.json metadata
 *   - Audit-logged via appendAuditEntry
 *   - Invalid source id returns 400
 *   - Works even when source cycle-config.json is absent (uses defaults)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: () => null,
  list: () => [],
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: vi.fn(),
  markTerminal: vi.fn(),
  stop: async () => ({ ok: true, status: 'killed', message: 'mocked' }),
  isPidAlive: () => false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      pid: 99999,
      unref: () => {},
    })),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
  };
});

import { cyclesRoutes } from '../cycles.js';

const SOURCE_ID = 'dddddddd-0000-0000-0000-000000000001';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-rerun-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  mkdirSync(join(tmpRoot, '.agentforge'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeSourceCycle(id: string, config?: Record<string, unknown>): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  if (config) {
    writeFileSync(join(dir, 'cycle-config.json'), JSON.stringify(config));
  }
  return dir;
}

describe('POST /api/v5/cycles/:id/rerun — Fix 4', () => {
  it('spawns a new cycle and returns 202 with a new cycleId', async () => {
    makeSourceCycle(SOURCE_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(typeof body.cycleId).toBe('string');
    expect(body.cycleId).not.toBe(SOURCE_ID);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.windowsHide).toBe(true);
  });

  it('response includes sourceCycleId pointing to the original', async () => {
    makeSourceCycle(SOURCE_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().sourceCycleId).toBe(SOURCE_ID);
  });

  it('inherits budgetUsd and maxItems from source cycle-config.json', async () => {
    makeSourceCycle(SOURCE_ID, {
      cycleId: SOURCE_ID,
      budgetUsd: 300,
      maxItems: 10,
      tags: ['inherited'],
      maxAgents: 4,
      fallbackEnabled: true,
      baseBranch: 'codex/codex-version',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });

    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };

    // The new cycle dir should have cycle-config.json with inherited values
    const configPath = join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['budgetUsd']).toBe(300);
    expect(config['maxItems']).toBe(10);
    expect(config['maxAgents']).toBe(4);
    expect(config['tags']).toEqual(['inherited']);
    expect(config['fallbackEnabled']).toBe(true);
    expect(config['baseBranch']).toBe('codex/codex-version');
  });

  it('captures sourceCycleId in new cycle-config.json metadata', async () => {
    makeSourceCycle(SOURCE_ID, { cycleId: SOURCE_ID, budgetUsd: 100 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });

    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    const configPath = join(tmpRoot, '.agentforge/cycles', cycleId, 'cycle-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config['sourceCycleId']).toBe(SOURCE_ID);
  });

  it('creates an audit entry for the rerun action', async () => {
    makeSourceCycle(SOURCE_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });
    expect(res.statusCode).toBe(202);

    // Read audit entry directly from SQLite (audit route not registered on this app).
    const auditDbPath = join(tmpRoot, '.agentforge', 'audit.db');
    expect(existsSync(auditDbPath)).toBe(true);
    const db = new Database(auditDbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'cycle.rerun'").all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(rows[0]!['details_json'] as string) as Record<string, unknown>;
    expect(details['sourceCycleId']).toBe(SOURCE_ID);
  });

  it('returns 400 for an invalid source cycle id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/bad.id/rerun',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid');
  });

  it('works even when source has no cycle-config.json (uses empty defaults)', async () => {
    makeSourceCycle(SOURCE_ID); // no config file

    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });

    expect(res.statusCode).toBe(202);
    const { cycleId } = res.json() as { cycleId: string };
    expect(typeof cycleId).toBe('string');
    expect(cycleId).not.toBe(SOURCE_ID);
  });

  it('works even when source cycle dir does not exist', async () => {
    // No source dir created — rerun should still spawn a new cycle
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${SOURCE_ID}/rerun`,
    });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().cycleId).toBe('string');
  });
});
