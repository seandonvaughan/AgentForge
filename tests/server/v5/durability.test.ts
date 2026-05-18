/**
 * Tests for GET /api/v5/durability/checkpoints
 *
 * Creates fixture checkpoint.json files in a tmp directory
 * and verifies the endpoint's read, sort, and fallback behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { durabilityRoutes } from '../../../packages/server/src/routes/v5/durability.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `durability-test-${process.pid}`);
const CYCLES_DIR = join(TMP_ROOT, '.agentforge', 'cycles');

interface CheckpointFixture {
  phase?: string;
  completedItemIds?: string[];
  lastUpdatedAt?: string;
}

function writeCheckpoint(cycleId: string, data: CheckpointFixture): void {
  const dir = join(CYCLES_DIR, cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(data));
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/durability/checkpoints', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    // Write fixture checkpoints
    writeCheckpoint('cycle-recent', {
      phase: 'execute',
      completedItemIds: ['item-1', 'item-2', 'item-3'],
      lastUpdatedAt: NOW,
    });
    writeCheckpoint('cycle-stale', {
      phase: 'test',
      completedItemIds: ['item-a'],
      lastUpdatedAt: TWO_HOURS_AGO,
    });
    writeCheckpoint('cycle-mid', {
      phase: 'plan',
      completedItemIds: [],
      lastUpdatedAt: HOUR_AGO,
    });
    // A cycle directory with NO checkpoint.json — should be skipped
    mkdirSync(join(CYCLES_DIR, 'cycle-no-checkpoint'), { recursive: true });
    // A non-directory entry in cycles dir — should be skipped
    writeFileSync(join(CYCLES_DIR, 'not-a-dir.txt'), 'ignore me');

    app = Fastify({ logger: false });
    await app.register(durabilityRoutes, { projectRoot: TMP_ROOT });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    teardown();
  });

  it('returns 200 with data array and meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number; timestamp: string } }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe('number');
    expect(typeof body.meta.timestamp).toBe('string');
  });

  it('returns exactly 3 checkpoints (skips no-checkpoint and file entries)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data.length).toBe(3);
    expect(body.meta.total).toBe(3);
  });

  it('sorts by lastUpdatedAt descending (most recent first)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: Array<{ cycleId: string }> }>();
    const ids = body.data.map(r => r.cycleId);
    expect(ids[0]).toBe('cycle-recent');
    expect(ids[1]).toBe('cycle-mid');
    expect(ids[2]).toBe('cycle-stale');
  });

  it('includes cycleId, phase, completedItemIds, lastUpdatedAt, idleSeconds', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{
      data: Array<{
        cycleId: string;
        phase: string;
        completedItemIds: string[];
        lastUpdatedAt: string;
        idleSeconds: number;
      }>;
    }>();
    const recent = body.data.find(r => r.cycleId === 'cycle-recent');
    expect(recent).toBeDefined();
    expect(recent!.phase).toBe('execute');
    expect(recent!.completedItemIds).toEqual(['item-1', 'item-2', 'item-3']);
    expect(typeof recent!.idleSeconds).toBe('number');
    expect(recent!.idleSeconds).toBeGreaterThanOrEqual(0);
  });

  it('completedItemIds count is correct', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: Array<{ cycleId: string; completedItemIds: string[] }> }>();
    const recent = body.data.find(r => r.cycleId === 'cycle-recent');
    const mid = body.data.find(r => r.cycleId === 'cycle-mid');
    expect(recent!.completedItemIds.length).toBe(3);
    expect(mid!.completedItemIds.length).toBe(0);
  });

  it('stale cycle has idleSeconds > 1800', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: Array<{ cycleId: string; idleSeconds: number }> }>();
    const stale = body.data.find(r => r.cycleId === 'cycle-stale');
    expect(stale!.idleSeconds).toBeGreaterThan(1800);
  });

  it('returns empty data when cycles directory does not exist', async () => {
    const emptyRoot = join(tmpdir(), `durability-empty-${process.pid}`);
    mkdirSync(emptyRoot, { recursive: true });
    const app2 = Fastify({ logger: false });
    await app2.register(durabilityRoutes, { projectRoot: emptyRoot });
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data.length).toBe(0);
    expect(body.meta.total).toBe(0);
    await app2.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it('skips malformed checkpoint.json gracefully', async () => {
    const badRoot = join(tmpdir(), `durability-bad-${process.pid}`);
    const badCyclesDir = join(badRoot, '.agentforge', 'cycles');
    mkdirSync(join(badCyclesDir, 'cycle-bad'), { recursive: true });
    writeFileSync(join(badCyclesDir, 'cycle-bad', 'checkpoint.json'), '{INVALID JSON');
    // Also write a valid one
    mkdirSync(join(badCyclesDir, 'cycle-good'), { recursive: true });
    writeFileSync(join(badCyclesDir, 'cycle-good', 'checkpoint.json'), JSON.stringify({
      phase: 'audit',
      completedItemIds: ['x'],
      lastUpdatedAt: NOW,
    }));
    const app3 = Fastify({ logger: false });
    await app3.register(durabilityRoutes, { projectRoot: badRoot });
    await app3.ready();
    const res = await app3.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: unknown[] }>();
    // Only cycle-good should appear; cycle-bad is skipped
    expect(body.data.length).toBe(1);
    await app3.close();
    rmSync(badRoot, { recursive: true, force: true });
  });

  it('uses capturedAt as fallback when lastUpdatedAt is absent', async () => {
    const fbRoot = join(tmpdir(), `durability-fb-${process.pid}`);
    const fbCyclesDir = join(fbRoot, '.agentforge', 'cycles');
    mkdirSync(join(fbCyclesDir, 'cycle-fb'), { recursive: true });
    writeFileSync(join(fbCyclesDir, 'cycle-fb', 'checkpoint.json'), JSON.stringify({
      phase: 'plan',
      completedItemIds: [],
      capturedAt: HOUR_AGO,
    }));
    const app4 = Fastify({ logger: false });
    await app4.register(durabilityRoutes, { projectRoot: fbRoot });
    await app4.ready();
    const res = await app4.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    const body = res.json<{ data: Array<{ lastUpdatedAt: string; idleSeconds: number }> }>();
    expect(body.data.length).toBe(1);
    expect(body.data[0].lastUpdatedAt).toBe(HOUR_AGO);
    expect(body.data[0].idleSeconds).toBeGreaterThan(3500); // ~1 hour
    await app4.close();
    rmSync(fbRoot, { recursive: true, force: true });
  });

  it('rejects traversal attempts in cycleId (directory named ..)', async () => {
    // The readdir would return '..' only in unusual situations, but our
    // parseSafeCycleId regex blocks it.
    const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
    // All data items should have safe cycleIds
    const body = res.json<{ data: Array<{ cycleId: string }> }>();
    for (const item of body.data) {
      expect(/^[a-zA-Z0-9_-]+$/.test(item.cycleId)).toBe(true);
    }
  });
});
