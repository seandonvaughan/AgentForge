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
});
