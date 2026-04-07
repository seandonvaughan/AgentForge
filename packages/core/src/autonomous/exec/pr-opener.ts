// packages/core/src/autonomous/exec/pr-opener.ts
//
// Thin wrapper around `gh pr create`. Supports dry-run mode for tests.
// Body is passed via stdin (`--body-file -`) so we never have to escape
// markdown for the shell. Uses execFile (not exec) so there is no shell
// interpretation of arguments.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §8.3
// and docs/superpowers/plans/2026-04-06-autonomous-loop.md Task 13.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * v6.7.4: spawn-based gh runner that actually pipes the body to stdin.
 *
 * Why this exists: the original implementation used `execFileAsync('gh', args,
 * { input: req.body })` — but the `input` option is only supported on the
 * SYNCHRONOUS variants of execFile. The async/promisified version silently
 * drops `input`, so gh saw `--body-file -` with no stdin data, hung waiting
 * for content, and then crashed with a confusing "command failed" error.
 * Same root cause as the v6.4.3 fix in agent-runtime.ts. Every autonomous
 * cycle since v6.4 has died here.
 */
function runGh(
  args: string[],
  opts: { cwd: string; input: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`gh timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(`gh exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export class PROpenerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PROpenerError';
  }
}

export interface PROpenRequest {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
  reviewers?: string[];
  dryRun?: boolean;
}

export interface PROpenResult {
  url: string;
  number: number;
  draft: boolean;
}

export interface PROpenerConfig {
  /** Returns the authenticated gh user's login. Defaults to `gh api user --jq .login`. */
  getAuthUser?: () => Promise<string>;
  /** Returns the list of label names that exist on the repo. Defaults to `gh label list`. */
  getRepoLabels?: () => Promise<string[]>;
  /** Warning callback for skipped labels/reviewers. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

export class PROpener {
  private authUserCache: string | null = null;
  private repoLabelsCache: string[] | null = null;

  constructor(
    private readonly cwd: string,
    private readonly config: PROpenerConfig = {},
  ) {}

  async open(req: PROpenRequest): Promise<PROpenResult> {
    if (req.dryRun) {
      return {
        url: `https://github.com/dry-run/autonomous-test/pull/1`,
        number: 1,
        draft: req.draft,
      };
    }

    await this.requireGhInstalled();
    await this.requireGhAuthed();

    // Filter reviewers: drop the authenticated user (GitHub rejects self-review).
    let filteredReviewers: string[] | undefined = req.reviewers;
    if (req.reviewers && req.reviewers.length > 0) {
      try {
        const authUser = await this.getAuthUser();
        filteredReviewers = req.reviewers.filter((r) => r !== authUser);
        const dropped = req.reviewers.filter((r) => r === authUser);
        for (const d of dropped) {
          this.warn(`skipping reviewer "${d}": cannot request review from PR author`);
        }
      } catch (err: any) {
        this.warn(`failed to query authenticated gh user: ${err.message}`);
      }
    }

    // Filter labels: drop any that don't exist on the repo.
    let filteredLabels = req.labels;
    if (req.labels.length > 0) {
      try {
        const existing = await this.getRepoLabels();
        const existingSet = new Set(existing);
        filteredLabels = req.labels.filter((l) => existingSet.has(l));
        const dropped = req.labels.filter((l) => !existingSet.has(l));
        for (const d of dropped) {
          this.warn(`skipping label "${d}": label not found on repo`);
        }
      } catch (err: any) {
        this.warn(`failed to query repo labels: ${err.message}`);
      }
    }

    const args = this.renderArgs({
      ...req,
      labels: filteredLabels,
      reviewers: filteredReviewers,
    });

    try {
      const result = await runGh(args, {
        cwd: this.cwd,
        input: req.body,
        timeoutMs: 60_000,
      });

      const url = result.stdout.trim().split('\n').pop() ?? '';
      if (!url.startsWith('https://')) {
        throw new PROpenerError(`Unexpected gh output: ${result.stdout}`);
      }

      const number = this.parsePrNumber(url);
      return { url, number, draft: req.draft };
    } catch (err: any) {
      if (err instanceof PROpenerError) throw err;
      throw new PROpenerError(`gh pr create failed: ${err.message}`);
    }
  }

  renderArgs(req: Omit<PROpenRequest, 'dryRun'>): string[] {
    const args = [
      'pr',
      'create',
      '--title', req.title,
      '--body-file', '-',
      '--base', req.baseBranch,
      '--head', req.branch,
    ];
    if (req.draft) args.push('--draft');
    for (const label of req.labels) {
      args.push('--label', label);
    }
    if (req.reviewers && req.reviewers.length > 0) {
      for (const reviewer of req.reviewers) {
        args.push('--reviewer', reviewer);
      }
    }
    return args;
  }

  parsePrNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new PROpenerError(`Cannot parse PR number from URL: ${url}`);
    }
    return parseInt(match[1]!, 10);
  }

  private async getAuthUser(): Promise<string> {
    if (this.authUserCache !== null) return this.authUserCache;
    const fn =
      this.config.getAuthUser ??
      (async () => {
        const result = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
          timeout: 10_000,
        });
        return result.stdout.toString().trim();
      });
    this.authUserCache = await fn();
    return this.authUserCache;
  }

  private async getRepoLabels(): Promise<string[]> {
    if (this.repoLabelsCache !== null) return this.repoLabelsCache;
    const fn =
      this.config.getRepoLabels ??
      (async () => {
        const result = await execFileAsync(
          'gh',
          ['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'],
          { cwd: this.cwd, timeout: 15_000 },
        );
        return result.stdout
          .toString()
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      });
    this.repoLabelsCache = await fn();
    return this.repoLabelsCache;
  }

  private warn(msg: string): void {
    if (this.config.onWarn) {
      this.config.onWarn(msg);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[PROpener] ${msg}`);
    }
  }

  private async requireGhInstalled(): Promise<void> {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5_000 });
    } catch {
      throw new PROpenerError('gh CLI not installed. See https://cli.github.com');
    }
  }

  private async requireGhAuthed(): Promise<void> {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    } catch {
      throw new PROpenerError('gh CLI not authenticated. Run `gh auth login`');
    }
  }
}
