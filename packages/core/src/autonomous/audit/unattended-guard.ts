// packages/core/src/autonomous/audit/unattended-guard.ts
//
// Pre-flight guard for unattended (AGENTFORGE_UNATTENDED=1) cycle runs.
// Runs 5 checks and throws UnattendedGuardError if any fail.
//
// Checks:
//   1. GH_TOKEN env var present
//   2. Free disk space on .agentforge/ partition ≥ 2 GB
//   3. Budget remaining ≥ perCycleUsd
//   4. Worktree count < 40
//   5. .agentforge/audit.db-wal size < 500 MB

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public contract (shared with server route)
// ---------------------------------------------------------------------------

export interface UnattendedCheckResult {
  check: 'gh_token' | 'disk_space' | 'budget' | 'worktree_count' | 'wal_size';
  passed: boolean;
  detail: string;
  measuredValue: number | string | null;
  threshold: number | string | null;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class UnattendedGuardError extends Error {
  constructor(
    public readonly failedChecks: UnattendedCheckResult[],
    message: string,
  ) {
    super(message);
    this.name = 'UnattendedGuardError';
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Check 1: GH_TOKEN env var present. */
function checkGhToken(): UnattendedCheckResult {
  // Use String.includes is not applicable here — we simply check presence.
  // No regex on env value per CodeQL guidance.
  const token = process.env['GH_TOKEN'];
  const present = typeof token === 'string' && token.length > 0;
  return {
    check: 'gh_token',
    passed: present,
    detail: present ? 'GH_TOKEN is set' : 'GH_TOKEN environment variable is missing',
    measuredValue: present ? 'present' : 'absent',
    threshold: 'present',
  };
}

/** Check 2: df free space ≥ 2 GB on the .agentforge/ partition. */
export async function checkDiskSpace(agentforgeDir: string): Promise<UnattendedCheckResult> {
  const THRESHOLD_KB = 2 * 1024 * 1024; // 2 GB in kilobytes

  // Resolve to absolute path to avoid any path-injection ambiguity.
  // match-then-use: validate the resolved path before passing to execFile.
  const resolved = resolve(agentforgeDir);
  const SAFE_PATH_RE = /^\/[^\0]+$/;
  const safePath = SAFE_PATH_RE.test(resolved) ? resolved : '/';

  let freeKb = 0;
  let raw = '';
  try {
    const { stdout } = await execFileAsync('df', ['-k', safePath]);
    raw = stdout;
    // df -k output:
    //   Filesystem   1K-blocks    Used Available Capacity Mounted on
    //   /dev/disk1   123456789 12345678 111111111      10% /
    // The Available column (index 3) on the data line (index 1).
    const lines = stdout.trim().split('\n');
    const dataLine = lines[1] ?? '';
    const parts = dataLine.trim().split(/\s+/);
    freeKb = parseInt(parts[3] ?? '0', 10);
    if (isNaN(freeKb)) freeKb = 0;
  } catch {
    // df unavailable — treat as unknown, pass conservatively only if we got 0
    freeKb = 0;
    raw = '';
  }

  const passed = freeKb >= THRESHOLD_KB;
  const freeGb = (freeKb / (1024 * 1024)).toFixed(2);
  return {
    check: 'disk_space',
    passed,
    detail: raw.length > 0
      ? `Free space: ${freeGb} GB (need ≥2 GB)`
      : 'Could not determine free disk space',
    measuredValue: freeKb,
    threshold: THRESHOLD_KB,
  };
}

/** Check 3: Budget remaining ≥ perCycleUsd. */
function checkBudget(
  perCycleUsd: number,
  spentUsd: number,
): UnattendedCheckResult {
  const remaining = perCycleUsd - spentUsd;
  const passed = remaining >= perCycleUsd;
  return {
    check: 'budget',
    passed,
    detail: passed
      ? `Budget remaining $${remaining.toFixed(2)} ≥ perCycleUsd $${perCycleUsd.toFixed(2)}`
      : `Budget remaining $${remaining.toFixed(2)} < perCycleUsd $${perCycleUsd.toFixed(2)}`,
    measuredValue: remaining,
    threshold: perCycleUsd,
  };
}

/** Check 4: Worktree count < 40 (hard max from CLAUDE.md). */
function checkWorktreeCount(cwd: string): UnattendedCheckResult {
  const THRESHOLD = 40;
  const worktreeDir = join(cwd, '.git', 'worktrees');
  let count = 0;
  if (existsSync(worktreeDir)) {
    try {
      const entries = readdirSync(worktreeDir, { withFileTypes: true });
      count = entries.filter((e) => e.isDirectory()).length;
    } catch {
      count = 0;
    }
  }
  const passed = count < THRESHOLD;
  return {
    check: 'worktree_count',
    passed,
    detail: passed
      ? `Worktree count: ${count} (limit ${THRESHOLD})`
      : `Worktree count ${count} ≥ limit ${THRESHOLD} — clean stale worktrees before running unattended`,
    measuredValue: count,
    threshold: THRESHOLD,
  };
}

/** Check 5: .agentforge/audit.db-wal size < 500 MB. */
function checkWalSize(agentforgeDir: string): UnattendedCheckResult {
  const THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB
  const walPath = join(agentforgeDir, 'audit.db-wal');
  let sizeBytes = 0;
  let exists = false;
  if (existsSync(walPath)) {
    exists = true;
    try {
      sizeBytes = statSync(walPath).size;
    } catch {
      sizeBytes = 0;
    }
  }
  const passed = !exists || sizeBytes < THRESHOLD_BYTES;
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return {
    check: 'wal_size',
    passed,
    detail: !exists
      ? 'audit.db-wal does not exist (WAL clean)'
      : passed
        ? `audit.db-wal: ${sizeMb} MB (limit 500 MB)`
        : `audit.db-wal: ${sizeMb} MB ≥ 500 MB — run PRAGMA wal_checkpoint(TRUNCATE) before unattended run`,
    measuredValue: sizeBytes,
    threshold: THRESHOLD_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UnattendedGuardOptions {
  /** Project root (cwd of cycle). */
  cwd: string;
  /** perCycleUsd from CycleConfig.budget. */
  perCycleUsd: number;
  /** Accumulated spend so far (0 for a fresh cycle). */
  spentUsd?: number;
  /**
   * Optional audit logger callback. When provided, each check result is
   * emitted as an audit entry so the unattended-checks route and dashboards
   * can surface pre-flight health.
   */
  onCheckResult?: (result: UnattendedCheckResult) => void;
}

/**
 * Run all 5 pre-flight checks.
 * Returns the full list of results regardless of outcome.
 * Throws `UnattendedGuardError` if any check failed.
 */
export async function runUnattendedChecks(
  opts: UnattendedGuardOptions,
): Promise<UnattendedCheckResult[]> {
  const agentforgeDir = join(opts.cwd, '.agentforge');
  const spentUsd = opts.spentUsd ?? 0;

  const results: UnattendedCheckResult[] = [];

  // Run all checks, collecting results even if some fail.
  const checks: UnattendedCheckResult[] = [
    checkGhToken(),
    await checkDiskSpace(agentforgeDir),
    checkBudget(opts.perCycleUsd, spentUsd),
    checkWorktreeCount(opts.cwd),
    checkWalSize(agentforgeDir),
  ];

  for (const result of checks) {
    results.push(result);
    opts.onCheckResult?.(result);
  }

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    const summary = failed.map((f) => `${f.check}: ${f.detail}`).join('; ');
    throw new UnattendedGuardError(failed, `Unattended pre-flight failed (${failed.length} checks): ${summary}`);
  }

  return results;
}

/**
 * Convenience guard called from CycleRunner.start() when
 * AGENTFORGE_UNATTENDED=1.  Throws UnattendedGuardError on any failure.
 */
export async function assertUnattendedSafe(
  cwd: string,
  perCycleUsd: number,
  spentUsd = 0,
  onCheckResult?: (result: UnattendedCheckResult) => void,
): Promise<void> {
  await runUnattendedChecks({ cwd, perCycleUsd, spentUsd, ...(onCheckResult ? { onCheckResult } : {}) });
}
