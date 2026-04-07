import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitOps, GitSafetyError } from '../../../packages/core/src/autonomous/exec/git-ops.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';
import { CycleLogger } from '../../../packages/core/src/autonomous/cycle-logger.js';

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

describe('GitOps safety guards', () => {
  let tmpRepo: string;
  const cycleId = 'test-gitops-cycle';

  beforeEach(async () => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'agentforge-gitops-'));
    mkdirSync(join(tmpRepo, '.agentforge/cycles', cycleId), { recursive: true });
    await initRepo(tmpRepo);
  });

  afterEach(() => {
    if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true });
  });

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
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(
      join(tmpRepo, 'bad.ts'),
      `const key = 'ANTHROPIC_API_KEY=sk-ant-api03-abcd1234567890abcd1234567890abcd';`,
    );
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on GitHub PAT pattern', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'bad.ts'), `const token = 'ghp_1234567890abcdefghij1234567890abcdef12';`);
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on AWS access key', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'bad.ts'), `const k = 'AKIAIOSFODNN7EXAMPLE';`);
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on private key header', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(
      join(tmpRepo, 'bad.pem'),
      `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n`,
    );
    // Note: stage() will refuse .pem; this test uses direct git add to reach the scan
    await execFileAsync('git', ['add', '-f', 'bad.pem'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('stage refuses dangerous path patterns (.env)', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, '.env'), 'KEY=value\n');
    const ops = makeOps();
    await expect(ops.stage(['.env'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses .pem files', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'cert.pem'), 'pem content\n');
    const ops = makeOps();
    await expect(ops.stage(['cert.pem'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses paths that traverse out of repo', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage(['../../etc/passwd'])).rejects.toThrow(/suspicious|outside/i);
  });

  it('stage refuses absolute paths', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage(['/etc/passwd'])).rejects.toThrow(/suspicious/i);
  });

  it('stage refuses more files than maxFilesPerCommit', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
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
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage([])).rejects.toThrow(/no files/i);
  });

  it('createBranch creates and checks out feature branch', async () => {
    const ops = makeOps();
    const branch = await ops.createBranch('6.4.0');
    expect(branch).toBe('autonomous/v6.4.0');
    const current = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo })).stdout.trim();
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
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });
    await expect(ops.createBranch('6.4.0')).rejects.toThrow(/already exists/);
  });

  it('full happy path: createBranch → stage → commit', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('autonomous(v6.4.0): add new file\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const current = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo })).stdout.trim();
    expect(current).toBe('autonomous/v6.4.0');
  });

  it('rollbackCommit resets to previous state on feature branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('test commit');

    await ops.rollbackCommit('autonomous/v6.4.0', sha);

    const log = (await execFileAsync('git', ['log', '--oneline'], { cwd: tmpRepo })).stdout;
    expect(log).not.toContain('test commit');
  });

  it('rollbackCommit refuses if not on the expected branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new.ts'), 'x');
    await ops.stage(['new.ts']);
    const sha = await ops.commit('test');
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });
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
    const staged = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: tmpRepo })).stdout;
    expect(staged.trim()).toBe('a.ts');
    expect(staged).not.toContain('b.ts');
  });
});
