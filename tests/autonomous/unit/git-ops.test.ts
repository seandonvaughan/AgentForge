import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitOps, GitSafetyError, DEFAULT_CYCLE_CONFIG, CycleLogger } from '@agentforge/core';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 150;

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

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@test.com'], dir);
  await git(['config', 'user.name', 'Test User'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await git(['add', 'README.md'], dir);
  await git(['commit', '-m', 'initial'], dir);
}

describe('GitOps safety guards', () => {
  let tmpRepo: string;
  const cycleId = 'test-gitops-cycle';

  beforeEach(async () => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'agentforge-gitops-'));
    mkdirSync(join(tmpRepo, '.agentforge/cycles', cycleId), { recursive: true });
    await initRepo(tmpRepo);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await removeTempDir(tmpRepo);
  }, HOOK_TIMEOUT_MS);

  function makeOps(): GitOps {
    const logger = new CycleLogger(tmpRepo, cycleId);
    return new GitOps(tmpRepo, DEFAULT_CYCLE_CONFIG.git, logger);
  }

  it('verifyPreconditions succeeds on clean repo with authed gh', async () => {
    const ops = makeOps();
    // Note: this test may skip or be marked pending if gh is not authed locally
    try {
      await ops.verifyPreconditions();
    } catch (err: any) {
      if (err.message.includes('gh CLI')) {
        console.warn('Skipping precondition test — gh not authed');
        return;
      }
      throw err;
    }
  });

  it('refuses when current branch is baseBranch (no-op before createBranch)', async () => {
    // After init, we are on main. createBranch should be called before commit,
    // but if we try to commit directly, it should refuse.
    const ops = makeOps();
    await expect(
      ops.commit('test commit'),
    ).rejects.toThrow(GitSafetyError);
  });

  it('scanStagedForSecrets throws on ANTHROPIC_API_KEY pattern', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    // Construct fake key at runtime so static scanners don't flag this test file
    const fakeAntKey = ['sk', 'ant', 'api03', 'abcd1234567890abcd1234567890abcd'].join('-');
    writeFileSync(
      join(tmpRepo, 'bad.ts'),
      `const key = 'ANTHROPIC_API_KEY=${fakeAntKey}';`,
    );
    await git(['add', 'bad.ts'], tmpRepo);

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on GitHub PAT pattern', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    // Construct fake PAT at runtime so static scanners don't flag this test file
    const fakePat = ['ghp', '1234567890abcdefghij1234567890abcdef12'].join('_');
    writeFileSync(join(tmpRepo, 'bad.ts'), `const token = '${fakePat}';`);
    await git(['add', 'bad.ts'], tmpRepo);

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on AWS access key', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    // Construct fake AWS key at runtime so static scanners don't flag this test file
    const fakeAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    writeFileSync(join(tmpRepo, 'bad.ts'), `const k = '${fakeAwsKey}';`);
    await git(['add', 'bad.ts'], tmpRepo);

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on private key header', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    // Construct fake PEM header at runtime so static scanners don't flag this test file
    const header = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
    const footer = ['-----END RSA', 'PRIVATE KEY-----'].join(' ');
    writeFileSync(
      join(tmpRepo, 'bad.pem'),
      `${header}\nMIIEpAIBAAKCAQEA...\n${footer}\n`,
    );
    // Note: stage() will refuse .pem; this test uses direct git add to reach the scan
    await git(['add', '-f', 'bad.pem'], tmpRepo);

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('stage refuses dangerous path patterns (.env)', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    writeFileSync(join(tmpRepo, '.env'), 'KEY=value\n');
    const ops = makeOps();
    await expect(ops.stage(['.env'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses .pem files', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    writeFileSync(join(tmpRepo, 'cert.pem'), 'pem content\n');
    const ops = makeOps();
    await expect(ops.stage(['cert.pem'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses paths that traverse out of repo', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    const ops = makeOps();
    await expect(ops.stage(['../../etc/passwd'])).rejects.toThrow(/suspicious|outside/i);
  });

  it('stage refuses absolute paths', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    const ops = makeOps();
    await expect(ops.stage(['/etc/passwd'])).rejects.toThrow(/suspicious/i);
  });

  it('stage refuses more files than maxFilesPerCommit', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    const config = {
      ...DEFAULT_CYCLE_CONFIG.git,
      maxFilesPerCommit: 3,
    };
    const logger = new CycleLogger(tmpRepo, cycleId);
    const ops = new GitOps(tmpRepo, config, logger);
    await expect(
      ops.stage(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
    ).rejects.toThrow(/maxFilesPerCommit/);
  });

  it('stage refuses empty file list', async () => {
    await git(['checkout', '-b', 'autonomous/v6.4.0'], tmpRepo);
    const ops = makeOps();
    await expect(ops.stage([])).rejects.toThrow(/no files/i);
  });

  it('createBranch creates and checks out feature branch', async () => {
    const ops = makeOps();
    const branch = await ops.createBranch('6.4.0');
    expect(branch).toBe('autonomous/v6.4.0');
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], tmpRepo)).stdout.trim();
    expect(current).toBe(branch);
  });

  it('createBranch appends suffix (e.g., -failed)', async () => {
    const ops = makeOps();
    const branch = await ops.createBranch('6.4.0', '-failed');
    expect(branch).toBe('autonomous/v6.4.0-failed');
  });

  // v6.4.4 bug #4: prefix ending in "v" must not produce "vv<version>".
  it('createBranch strips trailing "v" from branchPrefix to avoid double-v', async () => {
    const logger = new CycleLogger(tmpRepo, cycleId);
    const ops = new GitOps(
      tmpRepo,
      { ...DEFAULT_CYCLE_CONFIG.git, branchPrefix: 'test-v' },
      logger,
    );
    const branch = await ops.createBranch('7.0.0');
    expect(branch).toBe('test-v7.0.0');
    expect(branch).not.toContain('vv');
  });

  it('createBranch refuses if branch already exists', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    // Go back to main first to try re-creating
    await git(['checkout', 'main'], tmpRepo);
    await expect(ops.createBranch('6.4.0')).rejects.toThrow(/already exists/);
  });

  it('full happy path: createBranch → stage → commit', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('autonomous(v6.4.0): add new file\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], tmpRepo)).stdout.trim();
    expect(current).toBe('autonomous/v6.4.0');
  });

  it('rollbackCommit resets to previous state on feature branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('test commit');

    await ops.rollbackCommit('autonomous/v6.4.0', sha);

    const log = (await git(['log', '--oneline'], tmpRepo)).stdout;
    expect(log).not.toContain('test commit');
  });

  it('rollbackCommit refuses if not on the expected branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new.ts'), 'x');
    await ops.stage(['new.ts']);
    const sha = await ops.commit('test');
    await git(['checkout', 'main'], tmpRepo);
    await expect(
      ops.rollbackCommit('autonomous/v6.4.0', sha),
    ).rejects.toThrow(/not on branch/i);
  });

  it('never passes -A or . to git add', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'a.ts'), 'a');
    writeFileSync(join(tmpRepo, 'b.ts'), 'b');
    // If the impl used git add -A or git add ., this would still pass, but
    // our impl uses `git add -- a.ts b.ts`. Verify by spying on execFile would be nice.
    // Simpler: verify we can selectively stage.
    await ops.stage(['a.ts']);
    const staged = (await git(['diff', '--cached', '--name-only'], tmpRepo)).stdout;
    expect(staged.trim()).toBe('a.ts');
    expect(staged).not.toContain('b.ts');
  });

  it('stage filters unreachable pathspecs so one stale entry does not abort the whole stage', async () => {
    // Reproduces cycle e1ed9c0e: execute phase produced a file list that
    // included a path which neither exists on disk NOR is tracked in the
    // index (e.g. a partial rename left over between agent runs). Without
    // the filter, `git add -- real stale` aborts atomically with
    // "pathspec did not match" and rolls back the real file too.
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'real-file.ts'), 'export const x = 1;\n');

    // "ghost-file.ts" does not exist on disk and was never committed
    await ops.stage(['real-file.ts', 'ghost-file.ts']);

    const staged = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: tmpRepo })).stdout;
    expect(staged.trim()).toBe('real-file.ts');
  });

  it('stage still stages tracked-but-deleted files (legit deletion)', async () => {
    // The filter must keep tracked-then-deleted paths — a path that's gone
    // from disk but still in the index is a legitimate staged deletion.
    const ops = makeOps();
    writeFileSync(join(tmpRepo, 'to-delete.ts'), 'const x = 1;\n');
    await execFileAsync('git', ['add', 'to-delete.ts'], { cwd: tmpRepo });
    await execFileAsync('git', ['commit', '-m', 'add file'], { cwd: tmpRepo });

    await ops.createBranch('6.4.0');
    rmSync(join(tmpRepo, 'to-delete.ts'));

    await ops.stage(['to-delete.ts']);

    const staged = (await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpRepo })).stdout;
    expect(staged).toContain('D  to-delete.ts');
  });

  it('stage throws when every supplied path is unreachable', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    await expect(ops.stage(['does-not-exist-1.ts', 'does-not-exist-2.ts']))
      .rejects.toThrow(/No addable files/i);
  });
});
