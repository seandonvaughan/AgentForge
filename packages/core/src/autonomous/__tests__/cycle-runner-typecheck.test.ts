// packages/core/src/autonomous/__tests__/cycle-runner-typecheck.test.ts
//
// Unit tests for STAGE 3.5 — pre-verify typecheck.
//
// Coverage:
//   - KillSwitch.checkBuildResult   (success / failure / soft-mode / sticky)
//   - KillSwitch.checkTypeCheckResult (success / failure / soft-mode)
//   - DEFAULT_CYCLE_CONFIG commands  (buildCommand / typeCheckCommand match spec)
//
// The CycleRunner wires these together in runPreVerifyTypeCheck(); the kill-switch
// methods are the authoritative decision points, so testing them directly gives
// tight coverage without spinning up a full cycle mock.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KillSwitch } from '../kill-switch.js';
import { CycleStage } from '../types.js';
import type { CycleConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(qualityOverrides: Partial<CycleConfig['quality']> = {}): CycleConfig {
  return {
    budget: { perCycleUsd: 200, perItemUsd: 1.5, perAgentUsd: 60, allowOverageApproval: true },
    limits: {
      maxItemsPerSprint: 20,
      maxDurationMinutes: 180,
      maxConsecutiveFailures: 5,
      maxExecutePhaseFailureRate: 0.5,
      maxExecutePhaseParallelism: 10,
      maxItemRetries: 1,
    },
    quality: {
      testPassRateFloor: 0.95,
      allowRegression: false,
      requireBuildSuccess: true,
      requireTypeCheckSuccess: true,
      ...qualityOverrides,
    },
    git: {
      branchPrefix: 'autonomous/',
      baseBranch: 'main',
      refuseCommitToBaseBranch: true,
      includeDiagnosticBranchOnFailure: false,
      maxFilesPerCommit: 100,
    },
    pr: { draft: false, assignReviewer: null, labelPrefix: 'autonomous', labels: [], titleTemplate: '' },
    sourcing: { lookbackDays: 7, minProposalConfidence: 0.6, includeTodoMarkers: true, todoMarkerPattern: '' },
    testing: {
      command: 'pnpm exec vitest run',
      timeoutMinutes: 20,
      reporter: 'json',
      saveRawLog: false,
      buildCommand: 'pnpm build',
      typeCheckCommand: 'pnpm exec tsc -b --noEmit --pretty false',
    },
    scoring: { agentId: 'backlog-scorer', maxRetries: 3, fallbackToStatic: true },
    logging: { logDir: '/tmp/cycles', retainCycles: 5 },
    safety: {
      stopFilePath: '/tmp/STOP',
      secretScanEnabled: false,
      verifyCleanWorkingTreeBeforeStart: false,
      workingTreeWhitelist: [],
    },
    retry: { maxAutoRetries: 1, requireApprovalAfter: 1, reExecuteOnRetry: false },
  } as unknown as CycleConfig;
}

/** Stub signal handlers so multiple KillSwitch instances don't stack listeners. */
beforeEach(() => {
  vi.spyOn(KillSwitch.prototype, 'installSignalHandlers').mockReturnValue(undefined);
});

function makeKillSwitch(qualityOverrides?: Partial<CycleConfig['quality']>): KillSwitch {
  return new KillSwitch(makeConfig(qualityOverrides), 'test-cycle-id', Date.now(), '/tmp');
}

// ---------------------------------------------------------------------------
// KillSwitch.checkBuildResult
// ---------------------------------------------------------------------------

describe('KillSwitch.checkBuildResult', () => {
  it('returns null when the build succeeds', () => {
    const ks = makeKillSwitch();
    expect(ks.checkBuildResult({ success: true })).toBeNull();
  });

  it('trips with buildFailure when build fails and requireBuildSuccess is true', () => {
    const ks = makeKillSwitch({ requireBuildSuccess: true });
    const trip = ks.checkBuildResult({ success: false, error: 'TS2304: cannot find name X' });
    expect(trip).not.toBeNull();
    expect(trip!.reason).toBe('buildFailure');
    expect(trip!.detail).toBe('TS2304: cannot find name X');
    expect(trip!.stageAtTrip).toBe(CycleStage.VERIFY);
  });

  it('returns null when build fails but requireBuildSuccess is false (soft mode)', () => {
    const ks = makeKillSwitch({ requireBuildSuccess: false });
    // Soft mode: build error is logged but does not kill the cycle.
    expect(ks.checkBuildResult({ success: false, error: 'build error' })).toBeNull();
  });

  it('uses a fallback detail message when no error text is supplied', () => {
    const ks = makeKillSwitch({ requireBuildSuccess: true });
    const trip = ks.checkBuildResult({ success: false });
    expect(trip!.detail).toBe('build failed');
  });

  it('is sticky — returns the original trip on all subsequent calls', () => {
    const ks = makeKillSwitch({ requireBuildSuccess: true });
    const first = ks.checkBuildResult({ success: false, error: 'first error' });
    // A later "success" call still returns the same tripped state.
    const second = ks.checkBuildResult({ success: true });
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// KillSwitch.checkTypeCheckResult
// ---------------------------------------------------------------------------

describe('KillSwitch.checkTypeCheckResult', () => {
  it('returns null when typecheck succeeds', () => {
    const ks = makeKillSwitch();
    expect(ks.checkTypeCheckResult({ success: true })).toBeNull();
  });

  it('trips with typeCheckFailure when typecheck fails and requireTypeCheckSuccess is true', () => {
    const ks = makeKillSwitch({ requireTypeCheckSuccess: true });
    const trip = ks.checkTypeCheckResult({ success: false, error: 'Type error: Property x does not exist on type Y' });
    expect(trip).not.toBeNull();
    expect(trip!.reason).toBe('typeCheckFailure');
    expect(trip!.stageAtTrip).toBe(CycleStage.VERIFY);
  });

  it('returns null when typecheck fails but requireTypeCheckSuccess is false', () => {
    const ks = makeKillSwitch({ requireTypeCheckSuccess: false });
    expect(ks.checkTypeCheckResult({ success: false, error: 'type error' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CYCLE_CONFIG — commands must match the sprint spec exactly
// ---------------------------------------------------------------------------

describe('DEFAULT_CYCLE_CONFIG typecheck commands', () => {
  it('buildCommand builds all workspace packages (not just core)', async () => {
    const { DEFAULT_CYCLE_CONFIG } = await import('../config-loader.js');
    // Must be `pnpm build` (full workspace) so every cross-package .d.ts exists
    // before the typecheck step.  The previous `pnpm --filter @agentforge/core build`
    // left 7 other referenced packages unbuilt, causing tsc --noEmit to fail on
    // unresolved imports from @agentforge/shared, @agentforge/db, etc.
    expect(DEFAULT_CYCLE_CONFIG.testing.buildCommand).toBe('pnpm build');
  });

  it('typeCheckCommand uses -b flag for project-reference graph and disables ANSI output', async () => {
    const { DEFAULT_CYCLE_CONFIG } = await import('../config-loader.js');
    // The -b flag puts TypeScript in build mode, which walks the full project-reference
    // graph from the root tsconfig.json.  Without -b, tsc --noEmit ignores project
    // references and fails on cross-package imports even when packages are built.
    expect(DEFAULT_CYCLE_CONFIG.testing.typeCheckCommand).toBe('pnpm exec tsc -b --noEmit --pretty false');
  });
});

// ---------------------------------------------------------------------------
// parseCommandArgs — shell tokenizer used by defaultTypeCheck
// ---------------------------------------------------------------------------
// These tests guard against regressing the fix for the MAJOR split(' ') bug
// (gate-verdict 447f0e64): naive split(' ') breaks commands that contain
// quoted arguments with interior spaces (e.g. `pnpm --filter "@agentforge/core" build`).

describe('parseCommandArgs', () => {
  it('splits a simple space-separated command', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs('pnpm exec tsc --noEmit')).toEqual([
      'pnpm', 'exec', 'tsc', '--noEmit',
    ]);
  });

  it('strips double quotes and preserves the quoted token as a single arg', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs('pnpm --filter "@agentforge/core" build')).toEqual([
      'pnpm', '--filter', '@agentforge/core', 'build',
    ]);
  });

  it('strips single quotes and preserves the quoted token as a single arg', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs("pnpm --filter '@agentforge/core' build")).toEqual([
      'pnpm', '--filter', '@agentforge/core', 'build',
    ]);
  });

  it('collapses consecutive whitespace between tokens', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs('pnpm  build')).toEqual(['pnpm', 'build']);
  });

  it('returns an empty array for an empty string', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs('')).toEqual([]);
  });

  it('handles a quoted token containing spaces correctly (the regression case)', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    // This is the exact pattern that `split(' ')` broke: the quoted arg contains
    // a scope with an @ and slash that should remain a single token.
    const argv = parseCommandArgs('pnpm --filter "@agentforge/core" build');
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe('pnpm');
    expect(argv[1]).toBe('--filter');
    expect(argv[2]).toBe('@agentforge/core');
    expect(argv[3]).toBe('build');
  });

  it('handles the default buildCommand without quotes correctly', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    // The default command has no quotes — verify backward compatibility.
    expect(parseCommandArgs('pnpm --filter @agentforge/core build')).toEqual([
      'pnpm', '--filter', '@agentforge/core', 'build',
    ]);
  });

  it('handles tab characters as whitespace delimiters', async () => {
    const { parseCommandArgs } = await import('../cycle-runner.js');
    expect(parseCommandArgs('pnpm\texec\ttsc')).toEqual(['pnpm', 'exec', 'tsc']);
  });
});
