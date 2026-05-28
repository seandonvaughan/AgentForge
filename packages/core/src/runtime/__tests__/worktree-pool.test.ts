import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorktreePool } from '../worktree-pool.js';

const execFile = promisify(execFileCb);
const AGENT_SEGMENT_MAX = 64;
const HASH_SEGMENT_LENGTH = 12;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout;
}

function expectedHandleId(agentId: string, sessionId: string): string {
  const safeAgent = agentId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  const compactAgent = (safeAgent || 'unknown').slice(0, AGENT_SEGMENT_MAX);
  const digest = createHash('sha256')
    .update(agentId, 'utf8')
    .update('\u0000', 'utf8')
    .update(sessionId, 'utf8')
    .digest('hex');
  return `agent-${compactAgent}-${digest.slice(0, HASH_SEGMENT_LENGTH)}`;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function comparablePath(path: string): string {
  return toPosixPath(realpathSync.native(path)).toLowerCase();
}

interface RepoTemplate {
  rootDir: string;
  bareDir: string;
  workingDir: string;
}

async function setupRepoTemplate(): Promise<RepoTemplate> {
  const rootDir = mkdtempSync(join(tmpdir(), 'af-worktree-template-'));
  const dir = join(rootDir, 'seed');
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);

  // Write an initial file and commit so HEAD exists and branches can be created.
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'initial']);

  const bareDir = join(rootDir, 'origin.git');
  await execFile('git', ['clone', '--bare', dir, bareDir], { windowsHide: true });

  const workingDir = join(rootDir, 'working');
  await execFile(
    'git',
    ['clone', '--local', '--no-tags', bareDir, workingDir],
    { windowsHide: true },
  );
  await git(workingDir, ['config', 'user.email', 'test@example.com']);
  await git(workingDir, ['config', 'user.name', 'Test']);
  await git(workingDir, ['config', 'commit.gpgsign', 'false']);

  return { rootDir, bareDir, workingDir };
}

/**
 * Copy a prebuilt tiny repo template so each test still gets an isolated origin
 * and working clone without paying for init/commit/clone setup every time.
 */
async function setupRepoWithOrigin(
  template: RepoTemplate,
): Promise<{ workingDir: string; cleanupDirs: string[] }> {
  const testRoot = mkdtempSync(join(tmpdir(), 'af-worktree-test-'));
  const bareDir = join(testRoot, 'origin.git');
  const workingDir = join(testRoot, 'working');

  cpSync(template.bareDir, bareDir, { recursive: true });
  cpSync(template.workingDir, workingDir, { recursive: true });
  await git(workingDir, ['remote', 'set-url', 'origin', bareDir]);

  return { workingDir, cleanupDirs: [testRoot] };
}

describe('WorktreePool', () => {
  let repoTemplate: RepoTemplate;
  let workingDir: string;
  let cleanupDirs: string[] = [];

  beforeAll(async () => {
    repoTemplate = await setupRepoTemplate();
  }, 30_000);

  beforeEach(async () => {
    cleanupDirs = [];
    const setup = await setupRepoWithOrigin(repoTemplate);
    workingDir = setup.workingDir;
    cleanupDirs = setup.cleanupDirs;
  }, 30_000); // allow headroom when real-git tests run under full-suite Windows load

  afterAll(() => {
    try {
      rmSync(repoTemplate.rootDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  afterEach(() => {
    // Best-effort cleanup.
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1. Allocate: produces a handle with correct shape
  // -------------------------------------------------------------------------
  it('allocate returns a handle with expected fields', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess1' });

    expect(handle.id).toBe(expectedHandleId('coder', 'sess1'));
    expect(handle.agentId).toBe('coder');
    expect(handle.sessionId).toBe('sess1');
    expect(handle.branch).toBe(`autonomous/${handle.id}`);
    expect(handle.path).toBe(join(workingDir, '.agentforge/worktrees', handle.id));
    expect(handle.allocatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // -------------------------------------------------------------------------
  // 2. Allocate: the path exists on disk
  // -------------------------------------------------------------------------
  it('allocate creates the worktree directory on disk', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess2' });
    expect(existsSync(handle.path)).toBe(true);
  });

  it('does not link root node_modules into allocated worktrees', async () => {
    const rootNodeModules = join(workingDir, 'node_modules');
    mkdirSync(rootNodeModules, { recursive: true });

    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'deps' });

    expect(existsSync(join(handle.path, 'node_modules'))).toBe(false);
    await pool.release(handle.id);
    expect(existsSync(rootNodeModules)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Allocate: the branch exists in the repository
  // -------------------------------------------------------------------------
  it('allocate creates the branch in the repository', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess3' });
    const branches = await git(workingDir, ['branch', '--list', handle.branch]);
    expect(branches.trim()).toContain(handle.branch);
  });

  it('uses the configured branch prefix for agent worktree branches', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir, branchPrefix: 'codex/' });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess-codex' });

    expect(handle.branch).toBe(`codex/${handle.id}`);
    const branches = await git(workingDir, ['branch', '--list', handle.branch]);
    expect(branches.trim()).toContain(handle.branch);
  });

  // -------------------------------------------------------------------------
  // 4. Allocate: worktree HEAD matches origin/main
  // -------------------------------------------------------------------------
  it('allocate checks out HEAD matching origin/main', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess4' });

    const wtHead = (await git(handle.path, ['rev-parse', 'HEAD'])).trim();
    const originHead = (
      await git(workingDir, ['rev-parse', 'origin/main'])
    ).trim();
    expect(wtHead).toBe(originHead);
  });

  it('allocates an explicit retry branch from a source ref and preserves it on release', async () => {
    const retryBranch = 'codex/rejected-branch';

    await git(workingDir, ['checkout', '-b', retryBranch]);
    writeFileSync(join(workingDir, 'rejected.txt'), 'attempt 1\n');
    await git(workingDir, ['add', 'rejected.txt']);
    await git(workingDir, ['commit', '-m', 'rejected attempt']);
    const rejectedHead = (await git(workingDir, ['rev-parse', 'HEAD'])).trim();
    await git(workingDir, ['push', 'origin', retryBranch]);
    await git(workingDir, ['checkout', 'main']);

    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({
      agentId: 'coder',
      sessionId: 'retry-rejected',
      branchName: retryBranch,
      sourceRef: `origin/${retryBranch}`,
      deleteBranchOnRelease: false,
    });

    expect(handle.branch).toBe(retryBranch);
    expect(handle.sourceRef).toBe(`origin/${retryBranch}`);
    expect(handle.deleteBranchOnRelease).toBe(false);
    expect(handle.baselineHead).toBe(rejectedHead);
    expect((await git(handle.path, ['rev-parse', 'HEAD'])).trim()).toBe(rejectedHead);
    expect(existsSync(join(handle.path, 'rejected.txt'))).toBe(true);

    await pool.release(handle.id);

    expect(existsSync(handle.path)).toBe(false);
    expect((await git(workingDir, ['branch', '--list', retryBranch])).trim()).toContain(retryBranch);
  });

  // -------------------------------------------------------------------------
  // 5. Release: removes the worktree directory
  // -------------------------------------------------------------------------
  it('release removes the worktree directory', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess5' });
    expect(existsSync(handle.path)).toBe(true);

    await pool.release(handle.id);
    expect(existsSync(handle.path)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Release: removes the branch (when fully merged)
  // -------------------------------------------------------------------------
  it('release deletes the branch when there are no unmerged commits', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'sess6' });
    await pool.release(handle.id);

    const branches = await git(workingDir, ['branch', '--list', handle.branch]);
    expect(branches.trim()).toBe('');
  });

  it('re-allocates a removed worktree when the agent branch already exists', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir, branchPrefix: 'codex/' });

    const first = await pool.allocate({ agentId: 'coder', sessionId: 'retry1' });
    writeFileSync(join(first.path, 'agent-change.txt'), 'retry branch work\n');
    await git(first.path, ['add', '.']);
    await git(first.path, ['commit', '-m', 'agent work']);

    await pool.release(first.id);
    expect(existsSync(first.path)).toBe(false);
    expect((await git(workingDir, ['branch', '--list', first.branch])).trim()).toContain(first.branch);

    const second = await pool.allocate({ agentId: 'coder', sessionId: 'retry1' });
    expect(second.id).toBe(first.id);
    expect(second.branch).toBe(first.branch);
    expect(existsSync(second.path)).toBe(true);
    expect((await git(second.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(first.branch);

    await git(workingDir, ['worktree', 'remove', '--force', second.path]);
    await git(workingDir, ['branch', '-D', second.branch]);
  });

  it('refuses to reuse a stale directory that is not a git worktree', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const stalePath = join(
      workingDir,
      '.agentforge/worktrees',
      expectedHandleId('coder', 'stale1'),
    );
    mkdirSync(stalePath, { recursive: true });

    await expect(
      pool.allocate({ agentId: 'coder', sessionId: 'stale1' }),
    ).rejects.toThrow('not a registered git worktree');
    expect(existsSync(stalePath)).toBe(true);
  });

  it('refuses to reuse an existing registered worktree for a different explicit branch', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'explicit-branch-stale' });
    const retryPool = new WorktreePool({ projectRoot: workingDir });

    await git(workingDir, ['fetch', 'origin', 'main']);
    await expect(
      retryPool.allocate({
        agentId: 'coder',
        sessionId: 'explicit-branch-stale',
        branchName: 'codex/rejected-branch',
        sourceRef: 'origin/main',
        deleteBranchOnRelease: false,
      }),
    ).rejects.toThrow('cannot reuse it for codex/rejected-branch');

    await pool.release(handle.id);
  });

  // -------------------------------------------------------------------------
  // 7. Idempotent allocate: same id → same handle
  // -------------------------------------------------------------------------
  it('allocating the same id twice returns the same handle (idempotent)', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const h1 = await pool.allocate({ agentId: 'coder', sessionId: 'sessA' });
    const h2 = await pool.allocate({ agentId: 'coder', sessionId: 'sessA' });

    expect(h2.id).toBe(h1.id);
    expect(h2.path).toBe(h1.path);
    expect(h2.branch).toBe(h1.branch);
  });

  // -------------------------------------------------------------------------
  // 8. Different ids → distinct paths and branches
  // -------------------------------------------------------------------------
  it('two different allocations produce distinct paths and branches', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const h1 = await pool.allocate({ agentId: 'coder', sessionId: 'sessB' });
    const h2 = await pool.allocate({ agentId: 'reviewer', sessionId: 'sessC' });

    expect(h1.path).not.toBe(h2.path);
    expect(h1.branch).not.toBe(h2.branch);
  });

  // -------------------------------------------------------------------------
  // 9. listActive: returns only worktrees under rootDir
  // -------------------------------------------------------------------------
  it('listActive returns only worktrees under the pool rootDir', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const h1 = await pool.allocate({ agentId: 'coder', sessionId: 'sessD' });
    const h2 = await pool.allocate({ agentId: 'reviewer', sessionId: 'sessE' });

    const active = await pool.listActive();
    const ids = active.map((wt) => wt.id);
    expect(ids).toContain(h1.id);
    expect(ids).toContain(h2.id);

    // The main working tree (workingDir itself) should NOT appear in results.
    const paths = active.map((wt) => wt.path);
    expect(paths).not.toContain(workingDir);
  });

  it('listActive reconstructs readable agentId from registered compact worktrees', async () => {
    const allocator = new WorktreePool({ projectRoot: workingDir });
    const created = await allocator.allocate({
      agentId: 'executor-runtime-engineer',
      sessionId: 'sess-recover-1',
    });

    // Simulate dashboard recovery in a fresh process with an empty cache.
    const recoveringPool = new WorktreePool({ projectRoot: workingDir });
    const active = await recoveringPool.listActive();
    const recovered = active.find((item) => item.id === created.id);

    expect(recovered).toBeDefined();
    expect(recovered?.agentId).toBe('executor-runtime-engineer');
    expect(recovered?.sessionId).toMatch(/^[a-f0-9]{12}$/);
    expect(recovered?.branch).toBe(created.branch);

    await allocator.release(created.id);
  });

  it('listActive preserves the trailing segment for legacy ids that look like compact hashes', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const branch = 'autonomous/agent-coder-deadbeefcafe';
    const worktreePath = join(workingDir, '.agentforge', 'worktrees', 'agent-coder-deadbeefcafe');

    await git(workingDir, [
      'worktree',
      'add',
      '--no-track',
      '-b',
      branch,
      worktreePath,
      'origin/main',
    ]);

    const active = await pool.listActive();
    const recovered = active.find((item) => item.id === 'agent-coder-deadbeefcafe');

    expect(recovered).toBeDefined();
    expect(recovered?.agentId).toBe('coder');
    expect(recovered?.sessionId).toBe('deadbeefcafe');

    await git(workingDir, ['worktree', 'remove', '--force', worktreePath]);
    await git(workingDir, ['branch', '-D', branch]);
  });

  // -------------------------------------------------------------------------
  // 10. GC by age: keeps recent, removes old
  // -------------------------------------------------------------------------
  it('gc removes worktrees older than olderThanMs and keeps recent ones', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });

    // Allocate two worktrees.
    const old = await pool.allocate({ agentId: 'coder', sessionId: 'old1' });
    const recent = await pool.allocate({ agentId: 'reviewer', sessionId: 'recent1' });

    // Backdate the "old" handle's allocatedAt by hacking the private map.
    // We access it via the pool's internal handle map for test purposes.
    // Since the map is private, we use a cast.
    const internalHandles = (pool as unknown as { handles: Map<string, typeof old> })
      .handles;
    internalHandles.set(old.id, {
      ...old,
      allocatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
    });

    const { removed } = await pool.gc({ olderThanMs: 24 * 60 * 60 * 1000 });

    expect(removed).toContain(old.id);
    expect(removed).not.toContain(recent.id);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(recent.path)).toBe(true);

    // cleanup
    await pool.release(recent.id);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 11. GC by count: keeps last N
  // -------------------------------------------------------------------------
  it('gc keeps only the last N worktrees by keepLast', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });

    const h1 = await pool.allocate({ agentId: 'a1', sessionId: 's1' });
    const h2 = await pool.allocate({ agentId: 'a2', sessionId: 's2' });
    const h3 = await pool.allocate({ agentId: 'a3', sessionId: 's3' });

    // Backdate h1 and h2 so they sort as oldest.
    const internalHandles = (pool as unknown as { handles: Map<string, typeof h1> })
      .handles;
    internalHandles.set(h1.id, {
      ...h1,
      allocatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    internalHandles.set(h2.id, {
      ...h2,
      allocatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    const { removed } = await pool.gc({ keepLast: 1 });

    // Two oldest should be removed; h3 (most recent) should be kept.
    expect(removed).toContain(h1.id);
    expect(removed).toContain(h2.id);
    expect(removed).not.toContain(h3.id);
    expect(existsSync(h3.path)).toBe(true);

    // cleanup
    await pool.release(h3.id);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 12. GC respects unmerged commits — skips the worktree
  // -------------------------------------------------------------------------
  it('gc skips worktrees whose branch has unmerged commits', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });

    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'dirty1' });

    // Add a commit on the worktree branch that is not on origin/main.
    writeFileSync(join(handle.path, 'new-file.txt'), 'some work\n');
    await git(handle.path, ['add', '.']);
    await git(handle.path, ['commit', '-m', 'uncommitted work']);

    // Backdate so GC would normally remove it.
    const internalHandles = (pool as unknown as { handles: Map<string, typeof handle> })
      .handles;
    internalHandles.set(handle.id, {
      ...handle,
      allocatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const { removed } = await pool.gc({ olderThanMs: 24 * 60 * 60 * 1000 });

    // Should NOT be removed because the branch has unmerged commits.
    expect(removed).not.toContain(handle.id);
    expect(existsSync(handle.path)).toBe(true);

    // Force clean up after test.
    await git(workingDir, ['worktree', 'remove', '--force', handle.path]);
    await git(workingDir, ['branch', '-D', handle.branch]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 13. Stats counters update correctly
  // -------------------------------------------------------------------------
  it('stats counters update per operation', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });

    expect(pool.getStats().active).toBe(0);
    expect(pool.getStats().totalAllocations).toBe(0);

    const h1 = await pool.allocate({ agentId: 'c1', sessionId: 's1' });
    const h2 = await pool.allocate({ agentId: 'c2', sessionId: 's2' });

    expect(pool.getStats().active).toBe(2);
    expect(pool.getStats().totalAllocations).toBe(2);

    await pool.release(h1.id);

    expect(pool.getStats().active).toBe(1);
    expect(pool.getStats().totalReleases).toBe(1);

    await pool.release(h2.id);

    expect(pool.getStats().active).toBe(0);
    expect(pool.getStats().totalReleases).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 14. Custom rootDir is respected
  // -------------------------------------------------------------------------
  it('custom rootDir is respected in paths', async () => {
    const pool = new WorktreePool({
      projectRoot: workingDir,
      rootDir: '.mypool/workers',
    });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'custom1' });

    expect(toPosixPath(handle.path)).toContain('.mypool/workers');
    expect(existsSync(handle.path)).toBe(true);

    await pool.release(handle.id);
  });

  it('supports a rootDir outside the parent checkout', async () => {
    const pool = new WorktreePool({
      projectRoot: workingDir,
      rootDir: join('..', '.agentforge-worktrees', 'outside-root'),
    });
    const handle = await pool.allocate({ agentId: 'coder', sessionId: 'outside-root' });

    expect(relative(workingDir, handle.path).startsWith('..')).toBe(true);
    expect(comparablePath((await git(handle.path, ['rev-parse', '--show-toplevel'])).trim()))
      .toBe(comparablePath(handle.path));

    await pool.release(handle.id);
  });

  // -------------------------------------------------------------------------
  // 15. Deterministic compact naming: special chars are encoded into stable hash
  // -------------------------------------------------------------------------
  it('uses short deterministic ids and safe branch names for special-character ids', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({
      agentId: 'react/component.engineer',
      sessionId: 'cycle@2026#5',
    });

    expect(handle.id).toBe(expectedHandleId('react/component.engineer', 'cycle@2026#5'));
    expect(handle.id).toMatch(/^agent-[a-zA-Z0-9_-]+-[a-f0-9]{12}$/);
    expect(handle.branch).toBe(`autonomous/${handle.id}`);
    expect(handle.branch).toMatch(/^[a-zA-Z0-9_/-]+$/);
    expect(existsSync(handle.path)).toBe(true);

    await pool.release(handle.id);
  });

  it('keeps common AgentForge agent ids readable inside deterministic worktree ids', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });

    const executorHandle = await pool.allocate({
      agentId: 'executor-runtime-engineer',
      sessionId: 'cycle-readable-1',
    });
    const svelteHandle = await pool.allocate({
      agentId: 'svelte-component-atoms-engineer',
      sessionId: 'cycle-readable-2',
    });

    expect(executorHandle.id).toMatch(/^agent-executor-runtime-engineer-[a-f0-9]{12}$/);
    expect(svelteHandle.id).toMatch(/^agent-svelte-component-atoms-engineer-[a-f0-9]{12}$/);

    const active = await pool.listActive();
    const activeById = new Map(active.map((item) => [item.id, item]));
    expect(activeById.get(executorHandle.id)?.agentId).toBe('executor-runtime-engineer');
    expect(activeById.get(svelteHandle.id)?.agentId).toBe('svelte-component-atoms-engineer');

    await pool.release(executorHandle.id);
    await pool.release(svelteHandle.id);
  });

  it('keeps worktree paths short for very long agent and session ids', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const longAgentId = `agent-${'a'.repeat(500)}`;
    const longSessionId = `session-${'b'.repeat(500)}`;

    const handle = await pool.allocate({
      agentId: longAgentId,
      sessionId: longSessionId,
    });

    expect(handle.id).toBe(expectedHandleId(longAgentId, longSessionId));
    expect(handle.id.length).toBeLessThanOrEqual('agent-'.length + AGENT_SEGMENT_MAX + 1 + HASH_SEGMENT_LENGTH);
    expect(handle.id).toMatch(/^agent-[a-zA-Z0-9_-]{1,64}-[a-f0-9]{12}$/);
    expect(handle.path.length).toBeLessThan(220);
    expect(existsSync(handle.path)).toBe(true);

    await pool.release(handle.id);
  });

  it('is deterministic for retries and unique across different long ids', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const longAgentId = `agent-${'x'.repeat(400)}`;
    const sessionA = `session-${'y'.repeat(400)}-A`;
    const sessionB = `session-${'y'.repeat(400)}-B`;

    const first = await pool.allocate({ agentId: longAgentId, sessionId: sessionA });
    await pool.release(first.id);

    const second = await pool.allocate({ agentId: longAgentId, sessionId: sessionA });
    const third = await pool.allocate({ agentId: longAgentId, sessionId: sessionB });

    expect(second.id).toBe(first.id);
    expect(second.branch).toBe(first.branch);
    expect(third.id).not.toBe(first.id);
    expect(third.branch).not.toBe(first.branch);

    await pool.release(second.id);
    await pool.release(third.id);
  });

  it('keeps truncated visible agent collisions unique via the hash suffix', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const sharedPrefix = `agent-${'x'.repeat(80)}`;
    const agentA = `${sharedPrefix}-A`;
    const agentB = `${sharedPrefix}-B`;

    const first = await pool.allocate({ agentId: agentA, sessionId: 'same-session' });
    const second = await pool.allocate({ agentId: agentB, sessionId: 'same-session' });

    expect(first.id.slice(0, 'agent-'.length + AGENT_SEGMENT_MAX)).toBe(
      second.id.slice(0, 'agent-'.length + AGENT_SEGMENT_MAX),
    );
    expect(first.id).not.toBe(second.id);
    expect(first.branch).not.toBe(second.branch);

    await pool.release(first.id);
    await pool.release(second.id);
  });

  // -------------------------------------------------------------------------
  // 16. STRESS: parallel allocations - all unique, no race conditions
  // -------------------------------------------------------------------------
  it('stress: allocate concurrent worktrees in parallel - all unique paths, no races', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const COUNT = 10;

    const start = Date.now();
    const handles = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        pool.allocate({ agentId: `agent${i}`, sessionId: `stress${i}` }),
      ),
    );
    const elapsed = Date.now() - start;

    // All requested worktrees should have been allocated.
    expect(handles).toHaveLength(COUNT);

    // All paths should be unique.
    const paths = new Set(handles.map((h) => h.path));
    expect(paths.size).toBe(COUNT);

    // All branches should be unique.
    const branches = new Set(handles.map((h) => h.branch));
    expect(branches.size).toBe(COUNT);

    // All directories should exist on disk.
    for (const h of handles) {
      expect(existsSync(h.path)).toBe(true);
    }

    // Stats should reflect all allocations.
    expect(pool.getStats().active).toBe(COUNT);
    expect(pool.getStats().totalAllocations).toBe(COUNT);

    // Should complete within two minutes even when the full suite is also
    // running other real git worktree tests on Windows.
    expect(elapsed).toBeLessThan(120_000);
    console.log(`[stress] ${COUNT} parallel allocations completed in ${elapsed}ms`);

    // Release all in parallel.
    await Promise.all(handles.map((h) => pool.release(h.id)));
    expect(pool.getStats().active).toBe(0);
  }, 180_000); // generous timeout for 25 real git worktree ops under full-suite load
});
