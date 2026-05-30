/**
 * Unit tests for the pure VERIFY-gate planning functions.
 *
 * Every function under test is side-effect-free, so these run without spawning
 * vitest or touching the filesystem. See docs/superpowers/plans/2026-05-28-verify-gate-runner.md.
 *
 * DEVIATION FROM PLAN: buildVitestArgs must NOT emit `--minWorkers`. vitest 4.x
 * rejects it with a fatal `CACError: Unknown option --minWorkers` before any
 * test runs (this is the exact bug that broke the VERIFY gate, fixed in P0).
 */
import { describe, expect, it } from 'vitest';
import {
  computeWorkers,
  matchesCoreGlobs,
  selectGateMode,
  isOomExit,
  nextWorkersOnOom,
  buildVitestArgs,
  resolveVerifyConfig,
} from '../../scripts/verify-test-planner.mjs';

describe('computeWorkers', () => {
  it('is bounded by memory when memory is the tighter constraint', () => {
    // (10 - 2) / 1 = 8 byMem; cores-1 = 7 → min = 7
    expect(computeWorkers(10, 8, { reserveGb: 2, perWorkerGb: 1 })).toBe(7);
  });

  it('is bounded by CPUs when memory is plentiful', () => {
    // (32 - 2) / 1 = 30 byMem; cores-1 = 3 → 3
    expect(computeWorkers(32, 4, { reserveGb: 2, perWorkerGb: 1 })).toBe(3);
  });

  it('never returns less than 1 even under memory pressure', () => {
    // (2 - 2)/1 = 0 → clamped to 1
    expect(computeWorkers(2, 8, { reserveGb: 2, perWorkerGb: 1 })).toBe(1);
  });

  it('honors a larger per-worker budget', () => {
    // (10 - 2) / 2 = 4 byMem; cores-1 = 7 → 4
    expect(computeWorkers(10, 8, { reserveGb: 2, perWorkerGb: 2 })).toBe(4);
  });
});

const CORE = ['packages/core/src/runtime/**', 'packages/shared/**'];

describe('matchesCoreGlobs', () => {
  it('matches a file under a /** prefix glob', () => {
    expect(matchesCoreGlobs('packages/core/src/runtime/types.ts', CORE)).toBe(true);
  });
  it('normalizes Windows backslashes before matching', () => {
    expect(matchesCoreGlobs('packages\\shared\\src\\index.ts', CORE)).toBe(true);
  });
  it('does not match files outside the globs', () => {
    expect(matchesCoreGlobs('packages/cli/src/bin.ts', CORE)).toBe(false);
  });
});

describe('selectGateMode', () => {
  const base = { coreGlobs: CORE, cycleIndex: 1, deepGateEveryNCycles: 5, affectedMode: 'auto' };

  it('returns related for a non-core diff in auto mode', () => {
    expect(selectGateMode({ ...base, changedFiles: ['packages/cli/src/bin.ts'] })).toBe('related');
  });
  it('forces full when a changed file is under coreGlobs', () => {
    expect(selectGateMode({ ...base, changedFiles: ['packages/core/src/runtime/x.ts'] })).toBe('full');
  });
  it('forces full on the deep-gate cadence (every Nth cycle)', () => {
    expect(selectGateMode({ ...base, cycleIndex: 5, changedFiles: ['packages/cli/src/bin.ts'] })).toBe('full');
  });
  it('forces full when the changed-file list is empty (unknown diff)', () => {
    expect(selectGateMode({ ...base, changedFiles: [] })).toBe('full');
  });
  it('honors affectedMode=full and affectedMode=related overrides', () => {
    expect(selectGateMode({ ...base, affectedMode: 'full', changedFiles: ['packages/cli/x.ts'] })).toBe('full');
    expect(selectGateMode({ ...base, affectedMode: 'related', changedFiles: ['packages/core/src/runtime/x.ts'] })).toBe('related');
  });
});

describe('isOomExit', () => {
  it('is true for SIGKILL (137) and SIGABRT (134) and the signals themselves', () => {
    expect(isOomExit(137, null)).toBe(true);
    expect(isOomExit(134, null)).toBe(true);
    expect(isOomExit(null, 'SIGKILL')).toBe(true);
    expect(isOomExit(null, 'SIGABRT')).toBe(true);
  });
  it('is false for clean and ordinary test failures', () => {
    expect(isOomExit(0, null)).toBe(false);
    expect(isOomExit(1, null)).toBe(false);
  });
});

describe('nextWorkersOnOom', () => {
  it('halves the worker count, floored, never below 1', () => {
    expect(nextWorkersOnOom(6)).toBe(3);
    expect(nextWorkersOnOom(3)).toBe(1);
    expect(nextWorkersOnOom(1)).toBe(1);
  });
});

describe('buildVitestArgs', () => {
  it('builds full-suite run args with NO --minWorkers (vitest 4 rejects it fatally)', () => {
    const args = buildVitestArgs({ mode: 'full', changedFiles: [], workers: 4 });
    expect(args).toEqual(['run', '--maxWorkers=4']);
    expect(args).not.toContain('--minWorkers=1');
    expect(args.some((a) => a.startsWith('--minWorkers'))).toBe(false);
  });
  it('builds affected (related) args with the changed files and no --minWorkers', () => {
    const args = buildVitestArgs({ mode: 'related', changedFiles: ['a.ts', 'b.ts'], workers: 2 });
    expect(args).toEqual(['related', '--run', 'a.ts', 'b.ts', '--maxWorkers=2']);
    expect(args.some((a) => a.startsWith('--minWorkers'))).toBe(false);
  });
  it('falls back to a full run when related mode has no changed files', () => {
    expect(buildVitestArgs({ mode: 'related', changedFiles: [], workers: 2 }))
      .toEqual(['run', '--maxWorkers=2']);
  });
});

describe('resolveVerifyConfig', () => {
  it('fills defaults when given an empty/undefined testing block', () => {
    expect(resolveVerifyConfig(undefined)).toEqual({
      affectedMode: 'auto',
      deepGateEveryNCycles: 5,
      coreGlobs: [
        'packages/core/src/runtime/**',
        'packages/core/src/autonomous/**',
        'packages/shared/**',
      ],
      reserveGb: 2.0,
      perWorkerGb: 1.0,
      heapCapMb: 2048,
    });
  });

  it('honors provided overrides and rejects invalid affectedMode', () => {
    const cfg = resolveVerifyConfig({
      affectedMode: 'bogus',
      deepGateEveryNCycles: 3,
      coreGlobs: ['packages/core/src/runtime/**'],
      memory: { reserveGb: 3, perWorkerGb: 1.5, heapCapMb: 4096 },
    });
    expect(cfg.affectedMode).toBe('auto'); // invalid → default
    expect(cfg.deepGateEveryNCycles).toBe(3);
    expect(cfg.coreGlobs).toEqual(['packages/core/src/runtime/**']);
    expect(cfg.reserveGb).toBe(3);
    expect(cfg.perWorkerGb).toBe(1.5);
    expect(cfg.heapCapMb).toBe(4096);
  });
});
