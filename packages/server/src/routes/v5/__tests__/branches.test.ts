/**
 * Tests for GET /api/v5/autonomous-branches and
 *          DELETE /api/v5/autonomous-branches/*
 *
 * Uses a real git repo initialised in a temporary directory so that the
 * `git for-each-ref` and `git branch -D` calls in dashboard-stubs exercise
 * actual git plumbing without command mocking.
 *
 * The `gh pr list` call inside listAutonomousBranches is best-effort and will
 * gracefully fail in this environment (no GH auth), giving null PR fields.
 * That fallback path is verified implicitly by every GET test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dashboardStubRoutes } from '../dashboard-stubs.js';

// ── Git helpers ────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 150;
const execFileAsync = promisify(execFile);

vi.setConfig({ hookTimeout: HOOK_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function removeTempDir(dir?: string): Promise<void> {
  if (!dir) return;

  for (let attempt = 0; attempt <= CLEANUP_RETRIES; attempt += 1) {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: CLEANUP_RETRY_DELAY_MS,
      });
      return;
    } catch (err) {
      if (attempt === CLEANUP_RETRIES) {
        console.warn(`Failed to remove temp repo ${dir}:`, err);
        return;
      }
      await delay(CLEANUP_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

async function checkedGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  try {
    await execFileAsync('git', args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

/**
 * Initialise a bare-minimum git repo in `dir` with a single empty commit on
 * the default branch so that additional branches can be created from it.
 */
async function initGitRepo(dir: string): Promise<void> {
  // Suppress global/system git config noise in CI by scoping identity locally
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@agentforge.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@agentforge.test',
  };

  await checkedGit(['init', '-b', 'main', dir], { env: gitEnv });
  await checkedGit(['config', 'user.email', 'test@agentforge.test'], { cwd: dir });
  await checkedGit(['config', 'user.name', 'Test'], { cwd: dir });
  await checkedGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // An initial commit is required before `git branch` can create new refs
  await checkedGit(['commit', '--allow-empty', '-m', 'chore: init'], { cwd: dir, env: gitEnv });
}

/** Create a local branch from HEAD (no checkout). */
async function createBranch(dir: string, name: string): Promise<void> {
  await checkedGit(['branch', name], { cwd: dir });
}

// ── Test fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-branches-'));
  await initGitRepo(tmpRoot);
  app = Fastify({ logger: false });
  await dashboardStubRoutes(app, { projectRoot: tmpRoot });
  await app.ready();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  let closeError: unknown;
  try {
    if (app) await app.close();
  } catch (err) {
    closeError = err;
  }

  await removeTempDir(tmpRoot);

  if (closeError) {
    throw closeError;
  }
}, HOOK_TIMEOUT_MS);

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
    await createBranch(tmpRoot, 'autonomous/v6.8.0-sprint-001');

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
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    await createBranch(tmpRoot, 'autonomous/v6.8.1');
    await createBranch(tmpRoot, 'autonomous/v6.9.0-alpha');

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
    await createBranch(tmpRoot, 'feature/my-feature');
    await createBranch(tmpRoot, 'fix/bug-123');
    await createBranch(tmpRoot, 'autonomous/v6.8.0');

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
    await createBranch(tmpRoot, 'autonomous/sprint-42a67677');

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
    await createBranch(tmpRoot, 'autonomous/v6.8.0');

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
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    await createBranch(tmpRoot, 'autonomous/v6.8.1');

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
