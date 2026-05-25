// tests/autonomous/audit/unattended-guard.test.ts
//
// Tests for the 5 pre-flight unattended-mode checks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Hoist the mock for child_process execFile so we can control df output.
const { mockExecFile } = vi.hoisted(() => {
  return { mockExecFile: vi.fn() };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: mockExecFile };
});

// We import AFTER mocking.
import {
  assertUnattendedSafe,
  runUnattendedChecks,
  UnattendedGuardError,
  type UnattendedCheckResult,
} from '../../../packages/core/src/autonomous/audit/unattended-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(): { cwd: string; agentforgeDir: string; cleanup: () => void } {
  const cwd = join(tmpdir(), `unattended-test-${randomUUID()}`);
  const agentforgeDir = join(cwd, '.agentforge');
  const gitDir = join(cwd, '.git');
  mkdirSync(agentforgeDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  return {
    cwd,
    agentforgeDir,
    cleanup: () => {
      if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Simulate `df -k` returning free KB. macOS/Linux column format. */
function dfOutput(freeKb: number): string {
  return [
    'Filesystem   1K-blocks    Used Available Capacity Mounted on',
    `/dev/disk1s1 976490568 500000 ${freeKb}    50% /`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalGhToken: string | undefined;

beforeEach(() => {
  originalGhToken = process.env['GH_TOKEN'];
  // Reset execFile mock to a sensible default: 4 GB free.
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: dfOutput(4 * 1024 * 1024), stderr: '' });
    },
  );
});

afterEach(() => {
  if (originalGhToken === undefined) {
    delete process.env['GH_TOKEN'];
  } else {
    process.env['GH_TOKEN'] = originalGhToken;
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Check 1: GH_TOKEN
// ---------------------------------------------------------------------------

describe('check: gh_token', () => {
  it('passes when GH_TOKEN is set', async () => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
    const { cwd, cleanup } = makeTmpProject();
    try {
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'gh_token');
      expect(check?.passed).toBe(true);
      expect(check?.measuredValue).toBe('present');
    } finally {
      cleanup();
    }
  });

  it('fails when GH_TOKEN is absent', async () => {
    delete process.env['GH_TOKEN'];
    const { cwd, cleanup } = makeTmpProject();
    try {
      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
    } finally {
      cleanup();
    }
  });

  it('fails when GH_TOKEN is empty string', async () => {
    process.env['GH_TOKEN'] = '';
    const { cwd, cleanup } = makeTmpProject();
    try {
      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Check 2: disk_space
// ---------------------------------------------------------------------------

describe('check: disk_space', () => {
  beforeEach(() => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
  });

  it('passes when df reports ≥2 GB free', async () => {
    // Default mock already returns 4 GB.
    const { cwd, cleanup } = makeTmpProject();
    try {
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'disk_space');
      expect(check?.passed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('fails when df reports <2 GB free', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        // 1 GB — below threshold.
        cb(null, { stdout: dfOutput(1 * 1024 * 1024), stderr: '' });
      },
    );
    const { cwd, cleanup } = makeTmpProject();
    try {
      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
      // Verify the failing check is disk_space.
      try {
        await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      } catch (err) {
        expect(err).toBeInstanceOf(UnattendedGuardError);
        const failed = (err as UnattendedGuardError).failedChecks;
        expect(failed.some((f) => f.check === 'disk_space')).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('fails gracefully when df throws', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error) => void,
      ) => {
        cb(new Error('df not available'));
      },
    );
    const { cwd, cleanup } = makeTmpProject();
    try {
      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
    } finally {
      cleanup();
    }
  });

  it('falls back to statfs when df is unavailable', async () => {
    const enoent = Object.assign(new Error('df not found'), { code: 'ENOENT' });
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error) => void,
      ) => {
        cb(enoent);
      },
    );
    const { cwd, cleanup } = makeTmpProject();
    try {
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'disk_space');
      expect(check?.passed).toBe(true);
      expect(check?.detail).toContain('Free space');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Check 3: budget
// ---------------------------------------------------------------------------

describe('check: budget', () => {
  beforeEach(() => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
  });

  it('passes when spent is 0 (full budget available)', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30, spentUsd: 0 });
      const check = results.find((r) => r.check === 'budget');
      expect(check?.passed).toBe(true);
      expect(check?.measuredValue).toBe(30);
    } finally {
      cleanup();
    }
  });

  it('fails when spent already exceeds perCycleUsd', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      // spent=40 > perCycleUsd=30 → remaining = -10 < 30
      await expect(
        runUnattendedChecks({ cwd, perCycleUsd: 30, spentUsd: 40 }),
      ).rejects.toThrow(UnattendedGuardError);
    } finally {
      cleanup();
    }
  });

  it('fails when remaining < perCycleUsd (partially spent)', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      // spent=5 → remaining=25, but threshold is 30 → fail
      await expect(
        runUnattendedChecks({ cwd, perCycleUsd: 30, spentUsd: 5 }),
      ).rejects.toThrow(UnattendedGuardError);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Check 4: worktree_count
// ---------------------------------------------------------------------------

describe('check: worktree_count', () => {
  beforeEach(() => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
  });

  it('passes when worktrees dir does not exist', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      // No .git/worktrees dir — count is 0
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'worktree_count');
      expect(check?.passed).toBe(true);
      expect(check?.measuredValue).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('passes when worktree count < 40', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      // Create 5 worktree directories.
      const wtDir = join(cwd, '.git', 'worktrees');
      mkdirSync(wtDir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        mkdirSync(join(wtDir, `wt-${i}`));
      }
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'worktree_count');
      expect(check?.passed).toBe(true);
      expect(check?.measuredValue).toBe(5);
    } finally {
      cleanup();
    }
  });

  it('fails when worktree count ≥ 40', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      const wtDir = join(cwd, '.git', 'worktrees');
      mkdirSync(wtDir, { recursive: true });
      for (let i = 0; i < 40; i++) {
        mkdirSync(join(wtDir, `wt-${i}`));
      }
      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Check 5: wal_size
// ---------------------------------------------------------------------------

describe('check: wal_size', () => {
  beforeEach(() => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
  });

  it('passes when audit.db-wal does not exist', async () => {
    const { cwd, cleanup } = makeTmpProject();
    try {
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'wal_size');
      expect(check?.passed).toBe(true);
      expect(check?.measuredValue).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('passes when audit.db-wal is small', async () => {
    const { cwd, agentforgeDir, cleanup } = makeTmpProject();
    try {
      writeFileSync(join(agentforgeDir, 'audit.db-wal'), 'small wal content');
      const results = await runUnattendedChecks({ cwd, perCycleUsd: 30 });
      const check = results.find((r) => r.check === 'wal_size');
      expect(check?.passed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('fails when audit.db-wal ≥ 500 MB', async () => {
    const { cwd, agentforgeDir, cleanup } = makeTmpProject();
    try {
      // Write a file that is exactly 500 MB + 1 byte using a sparse file approach.
      // node:fs writeFileSync with a large Buffer would be slow; instead we use
      // a workaround: write a small sentinel and then call truncate to set the
      // apparent file size without occupying disk blocks on most filesystems.
      const walPath = join(agentforgeDir, 'audit.db-wal');
      const TARGET_BYTES = 500 * 1024 * 1024 + 1; // 500 MB + 1
      const { openSync, ftruncateSync, closeSync } = await import('node:fs');
      const fd = openSync(walPath, 'w');
      ftruncateSync(fd, TARGET_BYTES);
      closeSync(fd);

      await expect(runUnattendedChecks({ cwd, perCycleUsd: 30 })).rejects.toThrow(
        UnattendedGuardError,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// assertUnattendedSafe — all pass
// ---------------------------------------------------------------------------

describe('assertUnattendedSafe', () => {
  it('resolves without throwing when all checks pass', async () => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
    const { cwd, cleanup } = makeTmpProject();
    try {
      await expect(assertUnattendedSafe(cwd, 30)).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('invokes onCheckResult callback for each check', async () => {
    process.env['GH_TOKEN'] = 'ghp_testtoken';
    const { cwd, cleanup } = makeTmpProject();
    try {
      const collected: UnattendedCheckResult[] = [];
      await runUnattendedChecks({
        cwd,
        perCycleUsd: 30,
        onCheckResult: (r) => collected.push(r),
      });
      expect(collected).toHaveLength(5);
      const checkNames = collected.map((c) => c.check);
      expect(checkNames).toContain('gh_token');
      expect(checkNames).toContain('disk_space');
      expect(checkNames).toContain('budget');
      expect(checkNames).toContain('worktree_count');
      expect(checkNames).toContain('wal_size');
    } finally {
      cleanup();
    }
  });

  it('UnattendedGuardError exposes failedChecks array', async () => {
    delete process.env['GH_TOKEN'];
    const { cwd, cleanup } = makeTmpProject();
    try {
      let caughtError: UnattendedGuardError | undefined;
      try {
        await assertUnattendedSafe(cwd, 30);
      } catch (err) {
        if (err instanceof UnattendedGuardError) caughtError = err;
      }
      expect(caughtError).toBeDefined();
      expect(caughtError!.failedChecks.length).toBeGreaterThan(0);
      expect(caughtError!.failedChecks[0]!.check).toBe('gh_token');
    } finally {
      cleanup();
    }
  });
});
