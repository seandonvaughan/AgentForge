// packages/core/src/autonomous/exec/git-ops.ts
//
// SAFETY-CRITICAL: This module is the line of defense between the autonomous
// development cycle and the user's main branch. Every public method enforces
// a safety guard that has a corresponding negative test in
// tests/autonomous/unit/git-ops.test.ts.
//
// Ten safety guarantees encoded in `GitOps`:
// 1. Never runs in a non-git directory.
// 2. Never commits if there are no changes.
// 3. Never commits directly to `main` (or configured `baseBranch`).
// 4. Never uses `git add -A` or `git add .` — only explicit paths.
// 5. Refuses paths that escape the repo root (traversal prevention).
// 6. Refuses paths matching dangerous patterns (`.env`, `.pem`, `id_rsa`, etc.).
// 7. Scans staged diff for common secret patterns before committing.
// 8. Verifies post-commit that we're still on the feature branch (catches
//    git hooks moving HEAD).
// 9. Uses `git commit -F -` (stdin) for commit messages — no shell interpolation.
// 10. All subprocess calls use `execFile`, never `exec` — no shell parsing.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §8.2
// and docs/superpowers/plans/2026-04-06-autonomous-loop.md Task 11.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';
import type { CycleConfig } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

const execFileAsync = promisify(execFile);

/**
 * Run git with input piped to stdin. Used for `git commit -F -` so we can
 * pass the commit message without shell escaping or temp files. The
 * promisified `execFile` does NOT honor the `input` option (that only works
 * on the *Sync variants), so we go through `spawn` ourselves.
 */
function gitWithStdin(
  args: string[],
  cwd: string,
  input: string,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveP({ stdout, stderr });
      } else {
        const err: any = new Error(
          `git ${args.join(' ')} exited with code ${code}: ${stderr}`,
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        rejectP(err);
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export class GitSafetyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GitSafetyError';
  }
}

const DANGEROUS_PATHS = [
  /^\.env$/,
  /^\.env\./,
  /credentials\.json$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /\.secret$/,
];

const SECRET_PATTERNS = [
  /ANTHROPIC_API_KEY\s*=\s*['"]?sk-ant-/,
  /OPENAI_API_KEY\s*=\s*['"]?sk-/,
  /ghp_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];

export class GitOps {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['git'],
    private readonly logger: CycleLogger,
  ) {}

  async verifyPreconditions(): Promise<void> {
    // 1. In a git repo
    try {
      await this.git(['rev-parse', '--show-toplevel']);
    } catch {
      throw new GitSafetyError('Not a git repository');
    }

    // 2. Current branch is not the base branch (only a warning at precondition stage)
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (this.config.refuseCommitToBaseBranch && currentBranch === this.config.baseBranch) {
      // OK at precondition — we'll create feature branch next. Just verify the check works.
    }

    // 3. gh CLI is authenticated
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    } catch {
      throw new GitSafetyError('gh CLI is not authenticated. Run `gh auth login` first.');
    }
  }

  async stage(files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new GitSafetyError('No files to stage');
    }
    if (files.length > this.config.maxFilesPerCommit) {
      throw new GitSafetyError(
        `REFUSED: ${files.length} files exceeds maxFilesPerCommit (${this.config.maxFilesPerCommit})`,
      );
    }

    const repoRoot = resolve(this.cwd);
    for (const file of files) {
      if (file.startsWith('/') || file.includes('..')) {
        throw new GitSafetyError(`REFUSED: suspicious path: ${file}`);
      }

      const absolute = resolve(this.cwd, file);
      const rel = relative(repoRoot, absolute);
      if (rel.startsWith('..') || rel.startsWith('/')) {
        throw new GitSafetyError(`REFUSED: path outside repo: ${file}`);
      }

      for (const pattern of DANGEROUS_PATHS) {
        if (pattern.test(file)) {
          throw new GitSafetyError(`REFUSED: dangerous pattern: ${file}`);
        }
      }
    }

    // Explicit `--` separator, never `-A` or `.`
    await this.git(['add', '--', ...files]);

    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout
      .split('\n')
      .filter(Boolean);
    this.logger.logGitEvent({ type: 'staged', files: staged });
  }

  async scanStagedForSecrets(): Promise<void> {
    const diff = (await this.git(['diff', '--cached'])).stdout;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(diff)) {
        throw new GitSafetyError(`REFUSED: secret pattern matched (${pattern.source})`);
      }
    }
  }

  async commit(message: string): Promise<string> {
    // Refuse direct commit to base branch
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (this.config.refuseCommitToBaseBranch && currentBranch === this.config.baseBranch) {
      throw new GitSafetyError(
        `REFUSED: refuse to commit directly to ${this.config.baseBranch}. Create a feature branch first.`,
      );
    }

    // Secret scan before commit
    await this.scanStagedForSecrets();

    // Commit via stdin to avoid shell escaping
    await gitWithStdin(['commit', '-F', '-'], this.cwd, message);

    const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();

    // Verify post-commit branch (catches git hook weirdness)
    const branchAfter = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branchAfter === this.config.baseBranch) {
      throw new GitSafetyError(
        `POST-COMMIT PANIC: landed on ${this.config.baseBranch}`,
      );
    }

    this.logger.logGitEvent({ type: 'committed', sha, message });
    return sha;
  }

  async createBranch(version: string, suffix: string = ''): Promise<string> {
    // v6.4.4 bug #4: strip trailing "v" from prefix so "autonomous-v" +
    // "7.0.0" doesn't produce "autonomous-vv7.0.0".
    const normalizedPrefix = this.config.branchPrefix.replace(/v$/, '');
    const branch = `${normalizedPrefix}v${version}${suffix}`;

    // Check if branch already exists
    try {
      await this.git(['rev-parse', '--verify', `refs/heads/${branch}`]);
      throw new GitSafetyError(
        `REFUSED: branch ${branch} already exists — previous cycle may be uncleaned`,
      );
    } catch (err: any) {
      if (err instanceof GitSafetyError) throw err;
      // Expected: git rev-parse fails if branch does not exist
    }

    await this.git(['checkout', '-b', branch, this.config.baseBranch]);
    this.logger.logGitEvent({ type: 'branch-created', branch });
    return branch;
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', '-u', 'origin', branch]);
    this.logger.logGitEvent({ type: 'pushed', branch });
  }

  async rollbackCommit(branch: string, sha: string): Promise<void> {
    const current = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (current !== branch) {
      throw new GitSafetyError(`Cannot rollback: not on branch ${branch} (current: ${current})`);
    }
    await this.git(['reset', '--hard', `${sha}~1`]);
    this.logger.logGitEvent({ type: 'rolled-back', branch, fromSha: sha });
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // Always execFile, never exec — no shell interpretation
    const result = await execFileAsync('git', args, {
      cwd: this.cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
}
