/**
 * Tests for runningWorktrees counter in GET /api/v5/counters
 *
 * Verifies that countRunningWorktrees correctly counts registered agent-* git
 * worktrees in .agentforge/worktrees/ whose mtime is within the last 30
 * minutes, and returns 0 for absent, stale, unregistered, or non-matching
 * entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceAdapter } from '@agentforge/db';
import { countersRoutes, _resetCache, type CountersResponse } from '../counters.js';

const execFileAsync = promisify(execFile);

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

async function initGitRepo(projectRoot: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, 'README.md'), '# test\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: projectRoot });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: projectRoot });
}

async function makeRegisteredWorktree(
  projectRoot: string,
  name: string,
  ageMs = 0,
): Promise<void> {
  const worktreePath = join(projectRoot, '.agentforge', 'worktrees', name);
  mkdirSync(join(projectRoot, '.agentforge', 'worktrees'), { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '-b', `test-${name}`, worktreePath, 'HEAD'], {
    cwd: projectRoot,
  });
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(worktreePath, t, t);
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let adapter: WorkspaceAdapter;
let app: FastifyInstance | undefined;
let tmpRoot: string;

beforeEach(() => {
  _resetCache();
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'counters-worktrees-')));
  adapter = makeAdapter();
});

afterEach(async () => {
  await app?.close();
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
  it('counts 3 fresh registered agent-* worktrees as 3', async () => {
    await initGitRepo(tmpRoot);
    await makeRegisteredWorktree(tmpRoot, 'agent-foo-abc123');
    await makeRegisteredWorktree(tmpRoot, 'agent-bar-def456');
    await makeRegisteredWorktree(tmpRoot, 'agent-baz-789xyz');
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(3);
  });

  it('ignores registered worktrees whose name does not start with agent-', async () => {
    await initGitRepo(tmpRoot);
    await makeRegisteredWorktree(tmpRoot, 'agent-active-001');
    await makeRegisteredWorktree(tmpRoot, 'tmp-scratch');
    await makeRegisteredWorktree(tmpRoot, 'main');
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(1);
  });

  it('ignores unregistered orphan agent-* directories', async () => {
    await initGitRepo(tmpRoot);
    await makeRegisteredWorktree(tmpRoot, 'agent-active-001');
    mkdirSync(join(tmpRoot, '.agentforge', 'worktrees', 'agent-orphan-999'), { recursive: true });

    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(1);
  });
});

describe('GET /api/v5/counters — runningWorktrees — stale dirs excluded', () => {
  it('excludes registered agent worktrees older than 30 minutes', async () => {
    await initGitRepo(tmpRoot);
    await makeRegisteredWorktree(tmpRoot, 'agent-fresh-111', 2 * 60 * 1000);
    await makeRegisteredWorktree(tmpRoot, 'agent-stale-222', 31 * 60 * 1000);
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(1);
  });

  it('excludes registered agent worktrees older than 30 minutes and counts zero when all stale', async () => {
    await initGitRepo(tmpRoot);
    await makeRegisteredWorktree(tmpRoot, 'agent-old-001', 35 * 60 * 1000);
    await makeRegisteredWorktree(tmpRoot, 'agent-old-002', 60 * 60 * 1000);
    app = await buildApp(adapter, tmpRoot);
    const body = await getCounters(app);
    expect(body.runningWorktrees).toBe(0);
  });
});
