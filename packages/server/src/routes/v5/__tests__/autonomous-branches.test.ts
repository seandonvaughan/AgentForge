/**
 * Tests for the autonomous-branches route module (Fix 1: v2 mock-data audit).
 * 14 cases: validateBranchName unit tests, GET happy paths, DELETE with/without force.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { autonomousBranchesRoutes, validateBranchName } from '../autonomous-branches.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
vi.setConfig({ hookTimeout: HOOK_TIMEOUT_MS, testTimeout: TEST_TIMEOUT_MS });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@agentforge.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@agentforge.test' };

async function checkedGit(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  await execFileAsync('git', args, { cwd: opts.cwd, env: opts.env ?? gitEnv, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
}
async function initGitRepo(dir: string): Promise<void> {
  await checkedGit(['init', '-b', 'main', dir]);
  await checkedGit(['config', 'user.email', 'test@agentforge.test'], { cwd: dir });
  await checkedGit(['config', 'user.name', 'Test'], { cwd: dir });
  await checkedGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await checkedGit(['commit', '--allow-empty', '-m', 'chore: init'], { cwd: dir });
}
async function createBranch(dir: string, name: string): Promise<void> { await checkedGit(['branch', name], { cwd: dir }); }

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-ab-'));
  await initGitRepo(tmpRoot);
  app = Fastify({ logger: false });
  await autonomousBranchesRoutes(app, { projectRoot: tmpRoot });
  await app.ready();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}, HOOK_TIMEOUT_MS);

describe('validateBranchName()', () => {
  it('returns null for a valid autonomous/* name', () => { expect(validateBranchName('autonomous/v6.8.0')).toBeNull(); });
  it('returns null for names with dots, dashes, underscores', () => { expect(validateBranchName('autonomous/v6.8.0-sprint_001.alpha')).toBeNull(); });
  it('rejects names not starting with autonomous/', () => { expect(validateBranchName('main')).toContain('autonomous/'); });
  it('rejects feature/* names', () => { expect(validateBranchName('feature/my-feature')).not.toBeNull(); });
  it('rejects names with semicolons', () => { expect(validateBranchName('autonomous/bad;branch')).toContain('Invalid branch name format'); });
  it('rejects names with spaces', () => { expect(validateBranchName('autonomous/bad branch')).toContain('Invalid branch name format'); });
  it('rejects path traversal sequences', () => { expect(validateBranchName('autonomous/../etc/passwd')).toContain('Invalid branch name format'); });
});

describe('GET /api/v5/autonomous-branches', () => {
  it('returns 200 with empty list when no autonomous branches exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number; updatedAt: string } }>();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
  it('returns updatedAt ISO timestamp in meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    expect(new Date(res.json<{ meta: { updatedAt: string } }>().meta.updatedAt).getTime()).toBeGreaterThan(0);
  });
  it('returns full AutonomousBranch shape including sha + ahead/behind', async () => {
    await createBranch(tmpRoot, 'autonomous/v6.8.0-sprint-001');
    const res = await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' });
    expect(res.statusCode).toBe(200);
    const branch = res.json<{ data: Array<{ name: string; cycle: string; lastCommitSha: string; lastCommitAt: string; ageMs: number; aheadOfMain: number; behindMain: number; status: string; prNumber: number | null; prUrl: string | null }>; meta: { total: number } }>().data[0]!;
    expect(branch.name).toBe('autonomous/v6.8.0-sprint-001');
    expect(branch.cycle).toBe('v6.8.0-sprint-001');
    expect(branch.lastCommitSha.length).toBeGreaterThan(0);
    expect(new Date(branch.lastCommitAt).getTime()).toBeGreaterThan(0);
    expect(branch.ageMs).toBeGreaterThanOrEqual(0);
    expect(typeof branch.aheadOfMain).toBe('number');
    expect(typeof branch.behindMain).toBe('number');
    expect(['open-pr', 'merged', 'active', 'stale']).toContain(branch.status);
    expect(branch.prNumber).toBeNull();
    expect(branch.prUrl).toBeNull();
  }, TEST_TIMEOUT_MS);
  it('lists multiple autonomous/* branches', async () => {
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    await createBranch(tmpRoot, 'autonomous/v6.8.1');
    await createBranch(tmpRoot, 'autonomous/v6.9.0-alpha');
    const body = (await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: Array<{ name: string }>; meta: { total: number } }>();
    expect(body.meta.total).toBe(3);
    expect(body.data.map((b) => b.name).sort()).toEqual(['autonomous/v6.8.0', 'autonomous/v6.8.1', 'autonomous/v6.9.0-alpha']);
  }, TEST_TIMEOUT_MS);
  it('excludes non-autonomous branches', async () => {
    await createBranch(tmpRoot, 'feature/my-feature');
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    const body = (await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: Array<{ name: string }>; meta: { total: number } }>();
    expect(body.meta.total).toBe(1);
  }, TEST_TIMEOUT_MS);
  it('derives cycle by stripping autonomous/ prefix', async () => {
    await createBranch(tmpRoot, 'autonomous/sprint-42a67677');
    const body = (await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: Array<{ cycle: string }> }>();
    expect(body.data[0]!.cycle).toBe('sprint-42a67677');
  }, TEST_TIMEOUT_MS);
  it('returns aheadOfMain=0 and behindMain=0 for branch at same commit as main', async () => {
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    const body = (await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: Array<{ aheadOfMain: number; behindMain: number }> }>();
    expect(body.data[0]!.aheadOfMain).toBe(0);
    expect(body.data[0]!.behindMain).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe('DELETE /api/v5/autonomous-branches/*', () => {
  it('rejects deletion outside autonomous/ namespace (400)', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/main' })).statusCode).toBe(400);
  });
  it('rejects shell-dangerous characters (400)', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/autonomous/bad;branch' })).statusCode).toBe(400);
  });
  it('rejects path-traversal sequences (400)', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/autonomous/../etc/passwd' })).statusCode).toBe(400);
  });
  it('successfully deletes with ?force=true', async () => {
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    const del = await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/autonomous/v6.8.0?force=true' });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ ok: boolean; deleted: string }>()).toMatchObject({ ok: true, deleted: 'autonomous/v6.8.0' });
    expect((await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: unknown[] }>().data).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
  it('returns 500 for non-existent branch with force=true', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/autonomous/does-not-exist?force=true' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toMatch(/Delete failed/);
  }, TEST_TIMEOUT_MS);
  it('only deletes the targeted branch', async () => {
    await createBranch(tmpRoot, 'autonomous/v6.8.0');
    await createBranch(tmpRoot, 'autonomous/v6.8.1');
    await app.inject({ method: 'DELETE', url: '/api/v5/autonomous-branches/autonomous/v6.8.0?force=true' });
    const body = (await app.inject({ method: 'GET', url: '/api/v5/autonomous-branches' })).json<{ data: Array<{ name: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe('autonomous/v6.8.1');
  }, TEST_TIMEOUT_MS);
});
