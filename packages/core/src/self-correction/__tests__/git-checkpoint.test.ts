import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCheckpoint } from '../git-checkpoint.js';

const describeWithGit = hasGit() ? describe : describe.skip;

describe('GitCheckpoint dry-run mode', () => {
  it('records checkpoints and reports dry-run rollback messages', () => {
    const checkpoints = new GitCheckpoint();
    const checkpoint = checkpoints.create('1.0', 10);

    expect(checkpoints.latest()?.id).toBe(checkpoint.id);
    expect(checkpoints.rollback(checkpoint.id)).toMatchObject({
      success: true,
      message: `[dry-run] Would rollback to branch ${checkpoint.branch}`,
    });
  });
});

describeWithGit('GitCheckpoint production mode', () => {
  let repo: string | null = null;

  afterEach(() => {
    if (repo) {
      rmSync(repo, { recursive: true, force: true });
      repo = null;
    }
  });

  it('creates a checkpoint branch and rolls back to it from a clean tree', () => {
    repo = createRepo();
    const readmePath = join(repo, 'README.md');

    const checkpoints = new GitCheckpoint({ dryRun: false, cwd: repo });
    const checkpoint = checkpoints.create('2.0', 5);

    expect(git(repo, ['branch', '--list', checkpoint.branch]).trim()).toContain(checkpoint.branch);

    writeFileSync(readmePath, 'second\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'second']);

    const result = checkpoints.rollback(checkpoint.id);

    expect(result.success).toBe(true);
    expect(git(repo, ['branch', '--show-current']).trim()).toBe(checkpoint.branch);
    expect(readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n')).toBe('first\n');
  });

  it('refuses to create a production checkpoint from a dirty tree', () => {
    repo = createRepo();
    writeFileSync(join(repo, 'README.md'), 'dirty\n');

    const checkpoints = new GitCheckpoint({ dryRun: false, cwd: repo });

    expect(() => checkpoints.create('2.1', 5)).toThrow(/working tree is not clean/);
  });

  it('refuses to roll back over dirty work', () => {
    repo = createRepo();
    const checkpoints = new GitCheckpoint({ dryRun: false, cwd: repo });
    const checkpoint = checkpoints.create('2.2', 5);
    writeFileSync(join(repo, 'README.md'), 'dirty\n');

    const result = checkpoints.rollback(checkpoint.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/working tree is not clean/);
  });

  it('requires explicit force to roll back over dirty work', () => {
    repo = createRepo();
    const checkpoints = new GitCheckpoint({ dryRun: false, cwd: repo, force: true });
    const checkpoint = checkpoints.create('2.3', 5);
    writeFileSync(join(repo, 'README.md'), 'dirty\n');

    const result = checkpoints.rollback(checkpoint.id);

    expect(result.success).toBe(true);
    expect(readFileSync(join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('first\n');
  });
});

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentforge-git-checkpoint-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'AgentForge Test']);
  writeFileSync(join(repo, 'README.md'), 'first\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
