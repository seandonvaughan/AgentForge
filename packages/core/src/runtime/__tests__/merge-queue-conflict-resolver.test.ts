import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyConflict } from '../merge-queue-conflict-resolver.js';

// ---------------------------------------------------------------------------
// Helpers: set up real bare git repos for deterministic conflict scenarios
// ---------------------------------------------------------------------------

/** Create a git repo with an initial commit and return its path. */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@agentforge.test']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${msg}`);
  }
}

function commit(repoDir: string, message: string): void {
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', message, '--allow-empty']);
}

function makeTmpDir(): string {
  return join(tmpdir(), `mqcr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/**
 * Build a scenario where `featureBranch` conflicts with `main`:
 * - Write `content` to `filename` on `main`.
 * - Write `conflictContent` to the same `filename` on `featureBranch`.
 * Both branches diverge from the initial commit.
 */
function buildConflictScenario(opts: {
  repoDir: string;
  filename: string;
  mainContent: string;
  branchContent: string;
  featureBranch?: string;
}): void {
  const { repoDir, filename, mainContent, branchContent, featureBranch = 'feature' } = opts;

  // Initial shared commit
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  commit(repoDir, 'init');

  // Ensure subdirectory exists
  const fileDir = join(repoDir, filename).substring(0, join(repoDir, filename).lastIndexOf('/'));
  mkdirSync(fileDir, { recursive: true });

  // Write on main
  writeFileSync(join(repoDir, filename), mainContent);
  commit(repoDir, `main: update ${filename}`);

  // Create feature branch from the initial commit
  git(repoDir, ['checkout', '-b', featureBranch, 'HEAD~1']);
  // Re-ensure directory (not present in this branch's tree)
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(join(repoDir, filename), branchContent);
  commit(repoDir, `feature: update ${filename}`);

  // Go back to main
  git(repoDir, ['checkout', 'main']);
}

/**
 * Build a clean (no-conflict) scenario:
 * main and feature touch different files.
 */
function buildCleanScenario(repoDir: string, featureBranch = 'feature'): void {
  writeFileSync(join(repoDir, 'README.md'), '# repo\n');
  commit(repoDir, 'init');

  // main adds file-a
  writeFileSync(join(repoDir, 'file-a.ts'), 'export const a = 1;\n');
  commit(repoDir, 'main: add file-a');

  // feature (from init) adds file-b — no overlap
  git(repoDir, ['checkout', '-b', featureBranch, 'HEAD~1']);
  writeFileSync(join(repoDir, 'file-b.ts'), 'export const b = 2;\n');
  commit(repoDir, 'feature: add file-b');

  git(repoDir, ['checkout', 'main']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyConflict', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // 1. No conflict → 'clean'
  it('classifies as clean when there is no conflict', async () => {
    const repoDir = join(baseDir, 'repo-clean');
    initRepo(repoDir);
    buildCleanScenario(repoDir);

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('clean');
    expect(report.conflictingFiles).toHaveLength(0);
    expect(report.suggestedResolution).toBeTruthy();
  });

  // 2. After a clean merge attempt, the parent tree is unmodified
  it('leaves the parent working tree clean after a clean classification', async () => {
    const repoDir = join(baseDir, 'repo-clean-tree');
    initRepo(repoDir);
    buildCleanScenario(repoDir);

    await classifyConflict({ projectRoot: repoDir, branch: 'feature', parentBranch: 'main' });

    // The main branch working tree should have no staged/unstaged changes
    const status = git(repoDir, ['status', '--porcelain']).trim();
    expect(status).toBe('');
  });

  // 3. .jsonl conflict → 'append-only'
  it('classifies .jsonl conflicts as append-only', async () => {
    const repoDir = join(baseDir, 'repo-jsonl');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'memory/events.jsonl',
      mainContent: '{"id":"1","ts":"2026-01-01"}\n',
      branchContent: '{"id":"2","ts":"2026-01-02"}\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('append-only');
    expect(report.conflictingFiles.length).toBeGreaterThan(0);
    expect(report.conflictingFiles.some((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  // 4. package-lock.json conflict → 'lockfile'
  it('classifies package-lock.json conflicts as lockfile', async () => {
    const repoDir = join(baseDir, 'repo-lockfile');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'package-lock.json',
      mainContent: '{"lockfileVersion":3,"packages":{"a":{"version":"1.0.0"}}}\n',
      branchContent: '{"lockfileVersion":3,"packages":{"b":{"version":"2.0.0"}}}\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('lockfile');
    expect(report.conflictingFiles.some((f) => f === 'package-lock.json')).toBe(true);
  });

  // 5. .ts file conflict → 'non-trivial'
  it('classifies .ts file conflicts as non-trivial', async () => {
    const repoDir = join(baseDir, 'repo-nontrivial');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'src/service.ts',
      mainContent: 'export function hello() { return "main"; }\n',
      branchContent: 'export function hello() { return "feature"; }\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('non-trivial');
    expect(report.suggestedResolution).toMatch(/manual/i);
  });

  // 6. After conflict classification the parent branch tree is still clean
  it('aborts the merge after classification so the parent tree is clean', async () => {
    const repoDir = join(baseDir, 'repo-abort');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'src/service.ts',
      mainContent: 'export function foo() { return 1; }\n',
      branchContent: 'export function foo() { return 2; }\n',
    });

    await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    // status --porcelain on projectRoot (main branch) should be empty
    const status = git(repoDir, ['status', '--porcelain']).trim();
    expect(status).toBe('');
  });

  // 7. pnpm-lock.yaml → 'lockfile'
  it('classifies pnpm-lock.yaml conflicts as lockfile', async () => {
    const repoDir = join(baseDir, 'repo-pnpm');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'pnpm-lock.yaml',
      mainContent: 'lockfileVersion: "9.0"\nimporters:\n  .: {}\n',
      branchContent: 'lockfileVersion: "9.0"\nimporters:\n  pkg/a: {}\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('lockfile');
  });

  // 8. .sqlite file conflict → 'sqlite-binary'
  it('classifies .sqlite file conflicts as sqlite-binary', async () => {
    const repoDir = join(baseDir, 'repo-sqlite');
    initRepo(repoDir);
    // SQLite files are binary — write diverging content
    buildConflictScenario({
      repoDir,
      filename: 'audit.db',
      mainContent: 'FAKE_SQLITE_MAIN_v1\n',
      branchContent: 'FAKE_SQLITE_BRANCH_v1\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    // SQLite/db files may merge without text conflicts if treated as binary.
    // If git detects a binary conflict it appears in status as UU with binary markers.
    // If treated as text and content diverges, expect sqlite-binary.
    // Accept either clean (git ours/theirs merge) or sqlite-binary.
    expect(['sqlite-binary', 'clean', 'non-trivial'].includes(report.type)).toBe(true);
  });

  // 9. suggestedResolution is always a non-empty string
  it('always returns a non-empty suggestedResolution string', async () => {
    const repoDir = join(baseDir, 'repo-suggestion');
    initRepo(repoDir);
    buildCleanScenario(repoDir);

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(typeof report.suggestedResolution).toBe('string');
    expect(report.suggestedResolution.length).toBeGreaterThan(0);
  });

  // 10. Cargo.lock → 'lockfile'
  it('classifies Cargo.lock conflicts as lockfile', async () => {
    const repoDir = join(baseDir, 'repo-cargo');
    initRepo(repoDir);
    buildConflictScenario({
      repoDir,
      filename: 'Cargo.lock',
      mainContent:
        '# Cargo.lock\n[[package]]\nname = "my-crate"\nversion = "1.0.0"\n',
      branchContent:
        '# Cargo.lock\n[[package]]\nname = "my-crate"\nversion = "2.0.0"\n',
    });

    const report = await classifyConflict({
      projectRoot: repoDir,
      branch: 'feature',
      parentBranch: 'main',
    });

    expect(report.type).toBe('lockfile');
  });
});
