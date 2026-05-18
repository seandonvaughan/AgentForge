/**
 * Tests for runningWorktrees counter in GET /api/v5/counters
 *
 * Verifies that countRunningWorktrees correctly counts agent-* subdirectories
 * in .agentforge/worktrees/ whose mtime is within the last 30 minutes, and
 * returns 0 when the directory is absent or contains only stale/non-matching entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdapter } from '@agentforge/db';
import { countersRoutes, _resetCache, type CountersResponse } from '../counters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
}

async function buildApp(
  adapter: WorkspaceAdapter,
  projectRoot: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await countersRoutes(app, { adapter, projectRoot });
  await app.ready();
  return app;
}

async function getCounters(app: FastifyInstance): Promise<CountersResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/v5/counters' });
  expect(res.statusCode).toBe(200);
  return res.json() as CountersResponse;
}

/** Create a subdirectory under worktreesDir and optionally backdate its mtime. */
function makeWorktreeDir(
  worktreesDir: string,
  name: string,
  ageMs = 0,
): void {
  const p = join(worktreesDir, name);
  mkdirSync(p, { recursive: true });
  if (ageMs > 0) {
    // Set mtime to `ageMs` milliseconds in the past
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let adapter: WorkspaceAdapter;
let app: FastifyInstance;
let tmpRoot: string;

beforeEach(() => {
  _resetCache();
  tmpRoot = mkdtempSync(join(tmpdir(), 'counters-worktrees-'));
  adapter = makeAdapter();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  _resetCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/counters — runningWorktrees — absent directory', () => {
  it('returns runningWorktrees=0 when .agentforge/worktrees/ does not exist', async () => {
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(0);
  });
});

describe('GET /api/v5/counters — runningWorktrees — empty directory', () => {
  it('returns runningWorktrees=0 when worktrees dir is empty', async () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'worktrees'), { recursive: true });
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(0);
  });
});

describe('GET /api/v5/counters — runningWorktrees — recent agent dirs', () => {
  it('counts 3 fresh agent-* dirs as 3', async () => {
    const worktreesDir = join(tmpRoot, '.agentforge', 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    makeWorktreeDir(worktreesDir, 'agent-foo-abc123');
    makeWorktreeDir(worktreesDir, 'agent-bar-def456');
    makeWorktreeDir(worktreesDir, 'agent-baz-789xyz');
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(3);
  });

  it('ignores dirs whose name does not start with agent-', async () => {
    const worktreesDir = join(tmpRoot, '.agentforge', 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    makeWorktreeDir(worktreesDir, 'agent-active-001');
    makeWorktreeDir(worktreesDir, 'tmp-scratch');      // no agent- prefix
    makeWorktreeDir(worktreesDir, 'main');             // no agent- prefix
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(1);
  });
});

describe('GET /api/v5/counters — runningWorktrees — stale dirs excluded', () => {
  it('excludes agent dirs older than 30 minutes', async () => {
    const worktreesDir = join(tmpRoot, '.agentforge', 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    // Fresh dir (2 minutes old)
    makeWorktreeDir(worktreesDir, 'agent-fresh-111', 2 * 60 * 1000);
    // Stale dir (31 minutes old)
    makeWorktreeDir(worktreesDir, 'agent-stale-222', 31 * 60 * 1000);
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(1);
  });

  it('excludes agent dirs older than 30 minutes and counts zero when all stale', async () => {
    const worktreesDir = join(tmpRoot, '.agentforge', 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    makeWorktreeDir(worktreesDir, 'agent-old-001', 35 * 60 * 1000);
    makeWorktreeDir(worktreesDir, 'agent-old-002', 60 * 60 * 1000);
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(0);
  });
});
