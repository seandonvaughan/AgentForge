// packages/core/src/autonomous/exec/pr-opener.ts
//
// Thin wrapper around `gh pr create`. Supports dry-run mode for tests.
// Body is passed via stdin (`--body-file -`) so we never have to escape
// markdown for the shell. Uses execFile (not exec) so there is no shell
// interpretation of arguments.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §8.3
// and docs/superpowers/plans/2026-04-06-autonomous-loop.md Task 13.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export class PROpener {
  constructor(private readonly cwd: string) {}

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

    const args = this.renderArgs(req);

    try {
      const result = await execFileAsync('gh', args, {
        cwd: this.cwd,
        input: req.body,
        timeout: 60_000,
      } as any);

      const url = result.stdout.toString().trim().split('\n').pop() ?? '';
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
    for (const reviewer of req.reviewers ?? []) {
      args.push('--reviewer', reviewer);
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
