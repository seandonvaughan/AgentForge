// packages/core/src/runtime/agent-commit.ts
//
// T4.3 — Auto-commit & push for coder-class agents.
//
// After an agent finishes work in its isolated worktree, call
// `commitAgentWork` to:
//   1. Stage all changes (`git add -A`)
//   2. Commit with a structured message
//   3. Capture commit metadata (sha, diff stat)
//   4. Push the branch to origin (skipped when no remote exists)
//   5. Emit an `agent.branch.pushed` bus event so the pr-merge-manager (T4.4)
//      can open a draft PR.
//
// Set AGENT_AUTOCOMMIT_DISABLED=1 to opt out (useful in smoke runs / tests
// that do not want side-effects).

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { MessageBusV2 } from '../message-bus/message-bus.js';
import type { AgentBranchPushedPayload } from '../message-bus/types.js';
import { nowIso } from '@agentforge/shared';

const execFile = promisify(execFileCb);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentCommitOptions {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Branch name that is checked out in the worktree. */
  branch: string;
  /** Base branch this work was forked from (default: 'main'). */
  baseBranch?: string;
  /** Agent identifier — used in the commit message and bus event. */
  agentId: string;
  /** Session / cycle id — included in the bus event. */
  sessionId?: string;
  /** Cycle id — included in the bus event payload. */
  cycleId?: string;
  /** Sprint item ids the agent worked on. */
  itemIds: string[];
  /** Optional bus to emit `agent.branch.pushed` on after a successful push. */
  bus?: MessageBusV2;
}

export interface AgentCommitResult {
  /** HEAD commit sha after the commit. */
  commitSha: string;
  /** Number of files touched (from `git diff --name-only`). */
  filesChanged: number;
  /** First 500 chars of `git diff --stat` output. */
  diffSummary: string;
  /** ISO timestamp when the operation completed. */
  pushedAt: string;
  /** Branch that was committed/pushed. */
  branch: string;
  /**
   * True when origin remote does not exist.
   * The commit was created locally but NOT pushed.
   */
  localOnly: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Run a git command in the given directory using execFile (never exec). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

/** Sanitize a branch name to only allow [a-zA-Z0-9_/-]. */
function sanitizeBranch(input: string): string {
  return input.replace(/[^a-zA-Z0-9_/-]/g, '_');
}

/** Return true when origin remote is configured in the given worktree. */
async function hasOriginRemote(worktreePath: string): Promise<boolean> {
  try {
    const out = await git(worktreePath, ['remote']);
    return out.split('\n').map((s) => s.trim()).includes('origin');
  } catch {
    return false;
  }
}

/** Return true when there are any staged or unstaged changes. */
async function hasChanges(worktreePath: string): Promise<boolean> {
  try {
    const out = await git(worktreePath, ['status', '--porcelain']);
    return out.length > 0;
  } catch {
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Commit all changes in `worktreePath`, push to origin, and emit an
 * `agent.branch.pushed` event on the provided bus.
 *
 * Returns `null` when:
 * - `AGENT_AUTOCOMMIT_DISABLED` env var is set to a truthy value, OR
 * - the worktree is clean (no changes to commit).
 *
 * When the worktree's git repo has no `origin` remote (e.g. in unit tests
 * that create bare local repos without a remote), the push step is skipped
 * and the result has `localOnly: true`.  The bus event is still emitted with
 * `localOnly: true` so consumers can distinguish test/local runs.
 */
export async function commitAgentWork(
  opts: AgentCommitOptions,
): Promise<AgentCommitResult | null> {
  // ── Opt-out gate ────────────────────────────────────────────────────────────
  if (process.env['AGENT_AUTOCOMMIT_DISABLED']) {
    return null;
  }

  const {
    worktreePath,
    agentId,
    itemIds,
    bus,
  } = opts;

  const baseBranch = opts.baseBranch ?? 'main';
  const sessionId = opts.sessionId ?? '';
  const cycleId = opts.cycleId ?? '';
  const branch = sanitizeBranch(opts.branch);

  // ── Clean-worktree check ────────────────────────────────────────────────────
  if (!(await hasChanges(worktreePath))) {
    return null;
  }

  // ── Stage all changes ────────────────────────────────────────────────────────
  await git(worktreePath, ['add', '-A']);

  // ── Commit ──────────────────────────────────────────────────────────────────
  // Build a structured commit message:  agent(<agentId>): <itemIds>
  const itemsSummary = itemIds.length > 0 ? itemIds.join(', ') : 'no-items';
  const commitMsg = `agent(${agentId}): ${itemsSummary}`;

  await git(worktreePath, [
    'commit',
    '-m',
    commitMsg,
    '--no-verify',
    '--no-gpg-sign',
  ]);

  // ── Capture SHA ──────────────────────────────────────────────────────────────
  const commitSha = await git(worktreePath, ['rev-parse', 'HEAD']);

  // ── Capture diff stat ────────────────────────────────────────────────────────
  let rawDiffStat = '';
  let filesChanged = 0;
  try {
    rawDiffStat = await git(worktreePath, ['diff', '--stat', 'HEAD~1..HEAD']);
  } catch {
    // Initial commit has no HEAD~1 — use diff against empty tree instead.
    try {
      rawDiffStat = await git(worktreePath, [
        'diff',
        '--stat',
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904', // empty tree sha
        'HEAD',
      ]);
    } catch {
      rawDiffStat = '';
    }
  }

  try {
    const names = await git(worktreePath, ['diff', '--name-only', 'HEAD~1..HEAD']);
    filesChanged = names.split('\n').filter(Boolean).length;
  } catch {
    try {
      const names = await git(worktreePath, [
        'diff',
        '--name-only',
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        'HEAD',
      ]);
      filesChanged = names.split('\n').filter(Boolean).length;
    } catch {
      filesChanged = 0;
    }
  }

  const diffSummary = rawDiffStat.slice(0, 500);

  // ── Push (or skip when no origin) ───────────────────────────────────────────
  const originExists = await hasOriginRemote(worktreePath);
  let localOnly = false;

  if (originExists) {
    await git(worktreePath, ['push', '--force-with-lease', 'origin', branch]);
  } else {
    localOnly = true;
  }

  const pushedAt = nowIso();

  // ── Emit bus event ───────────────────────────────────────────────────────────
  if (bus) {
    const payload: AgentBranchPushedPayload = {
      cycleId,
      agentId,
      sessionId,
      branch,
      baseBranch,
      commitSha,
      filesChanged,
      diffSummary,
      pushedAt,
      itemIds,
      ...(localOnly ? { localOnly: true } : {}),
    };

    bus.publish({
      from: agentId as import('@agentforge/shared').AgentId,
      to: 'system',
      topic: 'agent.branch.pushed',
      category: 'task',
      payload,
    });
  }

  return {
    commitSha,
    filesChanged,
    diffSummary,
    pushedAt,
    branch,
    localOnly,
  };
}
