import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreePool } from '../worktree-pool.js';

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

async function setupRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'af-worktree-test-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);

  // Write an initial file and commit so HEAD exists and branches can be created.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'initial']);

  return dir;
}

/**
 * Create a bare clone so `origin` resolves and `git worktree add -b ... origin/main` works.
 * Returns the path of the working clone (which has origin pointing to the bare repo).
 */
async function setupRepoWithOrigin(): Promise<{ workingDir: string; cleanupDirs: string[] }> {
  const sourceDir = await setupRepo();

  // Create a bare clone.
  const bareDir = mkdtempSync(join(tmpdir(), 'af-worktree-bare-'));
  await git(sourceDir, ['clone', '--bare', sourceDir, bareDir]);

  // Create a fresh working clone from the bare dir.
  const workingDir = mkdtempSync(join(tmpdir(), 'af-worktree-working-'));
  rmSync(workingDir, { recursive: true, force: true });
  await execFile('git', ['clone', bareDir, workingDir]);
  await git(workingDir, ['config', 'user.email', 'test@example.com']);
  await git(workingDir, ['config', 'user.name', 'Test']);
  await git(workingDir, ['config', 'commit.gpgsign', 'false']);

  return { workingDir, cleanupDirs: [sourceDir, bareDir, workingDir] };
}

describe('WorktreePool', () => {
  let workingDir: string;
  let cleanupDirs: string[];

  beforeEach(async () => {
    const setup = await setupRepoWithOrigin();
    workingDir = setup.workingDir;
    cleanupDirs = setup.cleanupDirs;
  }, 30_000); // allow up to 30s for git clone setup (slow after stress test)

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

    expect(handle.id).toBe('agent-coder-sess1');
    expect(handle.agentId).toBe('coder');
    expect(handle.sessionId).toBe('sess1');
    expect(handle.branch).toBe('autonomous/agent-coder-sess1');
    expect(handle.path).toBe(join(workingDir, '.agentforge/worktrees', 'agent-coder-sess1'));
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

    expect(handle.branch).toBe('codex/agent-coder-sess-codex');
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
    const { writeFileSync } = await import('node:fs');

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
  });

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
  });

  // -------------------------------------------------------------------------
  // 12. GC respects unmerged commits — skips the worktree
  // -------------------------------------------------------------------------
  it('gc skips worktrees whose branch has unmerged commits', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const { writeFileSync } = await import('node:fs');

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
  });

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

  // -------------------------------------------------------------------------
  // 15. Sanitization: special chars in agentId/sessionId are replaced with _
  // -------------------------------------------------------------------------
  it('sanitizes agentId and sessionId replacing special chars with underscore', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const handle = await pool.allocate({
      agentId: 'react/component.engineer',
      sessionId: 'cycle@2026#5',
    });

    expect(handle.id).toMatch(/^[a-zA-Z0-9_/-]+$/);
    expect(handle.branch).toMatch(/^[a-zA-Z0-9_/-]+$/);
    expect(existsSync(handle.path)).toBe(true);

    await pool.release(handle.id);
  });

  // -------------------------------------------------------------------------
  // 16. STRESS: 25 parallel allocations — all unique, no race conditions
  // -------------------------------------------------------------------------
  it('stress: allocate 25 worktrees in parallel — all unique paths, no races', async () => {
    const pool = new WorktreePool({ projectRoot: workingDir });
    const COUNT = 25;

    const start = Date.now();
    const handles = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        pool.allocate({ agentId: `agent${i}`, sessionId: `stress${i}` }),
      ),
    );
    const elapsed = Date.now() - start;

    // All 25 should have been allocated.
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

    // Should complete well within 60s (25 parallel git ops on macOS).
    expect(elapsed).toBeLessThan(60_000);
    console.log(`[stress] 25 parallel allocations completed in ${elapsed}ms`);

    // Release all in parallel.
    await Promise.all(handles.map((h) => pool.release(h.id)));
    expect(pool.getStats().active).toBe(0);
  }, 90_000); // generous timeout for 25 real git worktree ops
});
