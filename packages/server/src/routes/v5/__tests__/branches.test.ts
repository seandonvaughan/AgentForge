/**
 * Tests for GET /api/v5/autonomous-branches and
 *          DELETE /api/v5/autonomous-branches/*
 *
 * Uses a real git repo initialised in a temporary directory so that the
 * `git for-each-ref` and `git branch -D` calls in dashboard-stubs exercise
 * actual git plumbing — no spawnSync mocking needed.
 *
 * The `gh pr list` call inside listAutonomousBranches is best-effort and will
 * gracefully fail in this environment (no GH auth), giving null PR fields.
 * That fallback path is verified implicitly by every GET test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dashboardStubRoutes } from '../dashboard-stubs.js';

// ── Git helpers ────────────────────────────────────────────────────────────

/**
 * Initialise a bare-minimum git repo in `dir` with a single empty commit on
 * the default branch so that additional branches can be created from it.
 */
function initGitRepo(dir: string): void {
  // Suppress global/system git config noise in CI by scoping identity locally
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@agentforge.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@agentforge.test',
  };

  spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8', env: gitEnv });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@agentforge.test'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { encoding: 'utf-8' });
  // An initial commit is required before `git branch` can create new refs
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'chore: init'], {
    encoding: 'utf-8',
    env: gitEnv,
  });
}

/** Create a local branch from HEAD (no checkout). */
function createBranch(dir: string, name: string): void {
  spawnSync('git', ['-C', dir, 'branch', name], { encoding: 'utf-8' });
}

// ── Test fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-branches-'));
  initGitRepo(tmpRoot);
  app = Fastify({ logger: false });
  await dashboardStubRoutes(app, { projectRoot: tmpRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── GET /api/v5/autonomous-branches ───────────────────────────────────────

describe('GET /api/v5/autonomous-branches', () => {
  it('returns 200 with an empty list when no autonomous branches exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('returns the expected branch shape for a single autonomous/* branch', async () => {
    createBranch(tmpRoot, 'autonomous/v6.8.0-sprint-001');

    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Array<{
        name: string;
        cycle: string;
        lastCommitAt: string;
        ageMs: number;
        status: string;
        prNumber: number | null;
        prUrl: string | null;
      }>;
      meta: { total: number };
    };

    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);

    const branch = body.data[0]!;
    expect(branch.name).toBe('autonomous/v6.8.0-sprint-001');
    expect(branch.cycle).toBe('v6.8.0-sprint-001');
    expect(typeof branch.lastCommitAt).toBe('string');
    expect(new Date(branch.lastCommitAt).getTime()).toBeGreaterThan(0);
    expect(typeof branch.ageMs).toBe('number');
    expect(branch.ageMs).toBeGreaterThanOrEqual(0);
    expect(['open-pr', 'merged', 'active', 'stale']).toContain(branch.status);
    // gh is unavailable in test env — PR fields must be null
    expect(branch.prNumber).toBeNull();
    expect(branch.prUrl).toBeNull();
  });

  it('lists multiple autonomous/* branches', async () => {
    createBranch(tmpRoot, 'autonomous/v6.8.0');
    createBranch(tmpRoot, 'autonomous/v6.8.1');
    createBranch(tmpRoot, 'autonomous/v6.9.0-alpha');

    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    const body = JSON.parse(res.body) as { data: Array<{ name: string }>; meta: { total: number } };

    expect(res.statusCode).toBe(200);
    expect(body.meta.total).toBe(3);
    const names = body.data.map((b) => b.name).sort();
    expect(names).toEqual([
      'autonomous/v6.8.0',
      'autonomous/v6.8.1',
      'autonomous/v6.9.0-alpha',
    ]);
  });

  it('excludes non-autonomous branches from the result', async () => {
    createBranch(tmpRoot, 'feature/my-feature');
    createBranch(tmpRoot, 'fix/bug-123');
    createBranch(tmpRoot, 'autonomous/v6.8.0');

    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    const body = JSON.parse(res.body) as { data: Array<{ name: string }>; meta: { total: number } };

    expect(res.statusCode).toBe(200);
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.name).toBe('autonomous/v6.8.0');
  });

  it('includes an updatedAt timestamp in meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    const body = JSON.parse(res.body) as { meta: { updatedAt: string } };

    expect(body.meta.updatedAt).toBeTruthy();
    expect(new Date(body.meta.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('derives cycle name by stripping the autonomous/ prefix', async () => {
    createBranch(tmpRoot, 'autonomous/sprint-42a67677');

    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    const body = JSON.parse(res.body) as { data: Array<{ cycle: string }> };

    expect(body.data[0]!.cycle).toBe('sprint-42a67677');
  });
});

// ── DELETE /api/v5/autonomous-branches/* ─────────────────────────────────

describe('DELETE /api/v5/autonomous-branches/*', () => {
  it('rejects deletion of a branch outside the autonomous/ namespace (400)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v5/autonomous-branches/main',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/autonomous\//);
  });

  it('rejects branch names with shell-dangerous characters (400)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      // Semicolon is not allowed by the server-side regex
      url: '/api/v5/autonomous-branches/autonomous/bad;branch',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain('Invalid branch name format');
  });

  it('successfully deletes an existing autonomous branch and removes it from the list', async () => {
    createBranch(tmpRoot, 'autonomous/v6.8.0');

    // Confirm it appears in the listing before deletion
    const beforeRes = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    expect(JSON.parse(beforeRes.body).data).toHaveLength(1);

    // Delete
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v5/autonomous-branches/autonomous/v6.8.0',
    });
    expect(delRes.statusCode).toBe(200);
    const delBody = JSON.parse(delRes.body) as { ok: boolean; deleted: string };
    expect(delBody.ok).toBe(true);
    expect(delBody.deleted).toBe('autonomous/v6.8.0');

    // Confirm it no longer appears in the listing
    const afterRes = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    expect(JSON.parse(afterRes.body).data).toHaveLength(0);
  });

  it('returns 500 when trying to delete a non-existent branch', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v5/autonomous-branches/autonomous/does-not-exist',
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/Delete failed/);
  });

  it('only deletes the targeted branch, leaving others intact', async () => {
    createBranch(tmpRoot, 'autonomous/v6.8.0');
    createBranch(tmpRoot, 'autonomous/v6.8.1');

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v5/autonomous-branches/autonomous/v6.8.0',
    });
    expect(delRes.statusCode).toBe(200);

    const listRes = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    const body = JSON.parse(listRes.body) as { data: Array<{ name: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe('autonomous/v6.8.1');
  });
});
