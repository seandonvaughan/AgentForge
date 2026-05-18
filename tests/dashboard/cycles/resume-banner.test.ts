/**
 * tests/dashboard/cycles/resume-banner.test.ts
 *
 * Contract tests for the resume banner logic in the /cycles/:id page.
 *
 * We test the data-logic contract (showResumeBanner derivation, copy command
 * construction, TERMINAL_NON_SUCCESS set) directly without spinning up a
 * Svelte renderer or browser — consistent with the pattern used by
 * tests/dashboard/typecheck-failure-banner.test.ts.
 *
 * Coverage:
 *   - Banner shows for failed/crashed/killed/aborted + checkpoint present
 *   - Banner does NOT show for completed (success) + checkpoint present
 *   - Banner does NOT show for terminal-non-success + no checkpoint
 *   - Banner does NOT show for running + checkpoint present
 *   - Resume command is constructed correctly from cycleId
 *   - Checkpoint shape validation (resumeFromPhase, capturedAt, completedPhases)
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Types — mirror interfaces in +page.svelte
// ---------------------------------------------------------------------------

interface CycleCheckpoint {
  resumeFromPhase: string;
  capturedAt: string;
  completedPhases: string[];
}

// ---------------------------------------------------------------------------
// Logic mirrors — inline the $derived computations from +page.svelte
// ---------------------------------------------------------------------------

const TERMINAL_NON_SUCCESS = new Set(['failed', 'crashed', 'killed', 'aborted']);

function shouldShowResumeBanner(stage: string, checkpoint: CycleCheckpoint | null): boolean {
  return TERMINAL_NON_SUCCESS.has(stage.toLowerCase()) && checkpoint !== null;
}

function buildResumeCommand(cycleId: string): string {
  return `agentforge cycle run --resume ${cycleId}`;
}

function extractCheckpoint(cycle: Record<string, unknown>): CycleCheckpoint | null {
  const cp = (cycle as { checkpoint?: CycleCheckpoint })?.checkpoint;
  return cp ?? null;
}

// ---------------------------------------------------------------------------
// Banner visibility — terminal-non-success + checkpoint present
// ---------------------------------------------------------------------------

describe('showResumeBanner — terminal-non-success statuses', () => {
  const checkpoint: CycleCheckpoint = {
    resumeFromPhase: 'execute',
    capturedAt: '2026-05-18T10:00:00.000Z',
    completedPhases: ['audit', 'plan', 'assign'],
  };

  it('shows banner for "failed" + checkpoint present', () => {
    expect(shouldShowResumeBanner('failed', checkpoint)).toBe(true);
  });

  it('shows banner for "crashed" + checkpoint present', () => {
    expect(shouldShowResumeBanner('crashed', checkpoint)).toBe(true);
  });

  it('shows banner for "killed" + checkpoint present', () => {
    expect(shouldShowResumeBanner('killed', checkpoint)).toBe(true);
  });

  it('shows banner for "aborted" + checkpoint present', () => {
    expect(shouldShowResumeBanner('aborted', checkpoint)).toBe(true);
  });

  it('is case-insensitive for stage', () => {
    expect(shouldShowResumeBanner('FAILED', checkpoint)).toBe(true);
    expect(shouldShowResumeBanner('Killed', checkpoint)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Banner visibility — must NOT show for success or missing checkpoint
// ---------------------------------------------------------------------------

describe('showResumeBanner — banner hidden cases', () => {
  const checkpoint: CycleCheckpoint = {
    resumeFromPhase: 'gate',
    capturedAt: '2026-05-18T10:00:00.000Z',
    completedPhases: ['audit', 'plan', 'assign', 'execute', 'test', 'review'],
  };

  it('does NOT show banner for "completed" (success) even with checkpoint', () => {
    expect(shouldShowResumeBanner('completed', checkpoint)).toBe(false);
  });

  it('does NOT show banner when checkpoint is null (terminal-non-success)', () => {
    expect(shouldShowResumeBanner('failed', null)).toBe(false);
    expect(shouldShowResumeBanner('crashed', null)).toBe(false);
  });

  it('does NOT show banner for "running" + checkpoint present', () => {
    expect(shouldShowResumeBanner('running', checkpoint)).toBe(false);
  });

  it('does NOT show banner for "run" stage (in-progress) + checkpoint', () => {
    expect(shouldShowResumeBanner('run', checkpoint)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resume command construction
// ---------------------------------------------------------------------------

describe('buildResumeCommand', () => {
  it('produces the correct agentforge CLI command', () => {
    expect(buildResumeCommand('abc12345')).toBe('agentforge cycle run --resume abc12345');
  });

  it('includes the full cycle id without truncation', () => {
    const id = 'abcdef01-1234-5678-9abc-def012345678';
    const cmd = buildResumeCommand(id);
    expect(cmd).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint extraction from cycle response
// ---------------------------------------------------------------------------

describe('extractCheckpoint', () => {
  it('returns the checkpoint when present in cycle response', () => {
    const cp: CycleCheckpoint = {
      resumeFromPhase: 'test',
      capturedAt: '2026-05-18T12:00:00.000Z',
      completedPhases: ['audit', 'plan', 'assign', 'execute'],
    };
    const cycle: Record<string, unknown> = {
      cycleId: 'abc123',
      status: 'failed',
      checkpoint: cp,
    };
    const result = extractCheckpoint(cycle);
    expect(result).not.toBeNull();
    expect(result!.resumeFromPhase).toBe('test');
    expect(result!.completedPhases).toHaveLength(4);
  });

  it('returns null when checkpoint field is absent', () => {
    const cycle: Record<string, unknown> = {
      cycleId: 'abc123',
      status: 'completed',
    };
    expect(extractCheckpoint(cycle)).toBeNull();
  });

  it('returns null when checkpoint field is undefined', () => {
    const cycle: Record<string, unknown> = {
      cycleId: 'abc123',
      status: 'failed',
      checkpoint: undefined,
    };
    expect(extractCheckpoint(cycle)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: full banner decision from cycle response
// ---------------------------------------------------------------------------

describe('banner decision from cycle response object', () => {
  it('banner shown: failed cycle with checkpoint', () => {
    const cycle: Record<string, unknown> = {
      cycleId: 'deadbeef',
      status: 'failed',
      stage: 'failed',
      checkpoint: {
        resumeFromPhase: 'review',
        capturedAt: '2026-05-18T09:00:00.000Z',
        completedPhases: ['audit', 'plan', 'assign', 'execute', 'test'],
      },
    };
    const stage = (cycle['stage'] as string) ?? 'unknown';
    const checkpoint = extractCheckpoint(cycle);
    expect(shouldShowResumeBanner(stage, checkpoint)).toBe(true);
  });

  it('banner hidden: completed cycle with checkpoint (not a failure)', () => {
    const cycle: Record<string, unknown> = {
      cycleId: 'deadbeef',
      status: 'completed',
      stage: 'completed',
      checkpoint: {
        resumeFromPhase: 'learn',
        capturedAt: '2026-05-18T09:00:00.000Z',
        completedPhases: ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release'],
      },
    };
    const stage = (cycle['stage'] as string) ?? 'unknown';
    const checkpoint = extractCheckpoint(cycle);
    expect(shouldShowResumeBanner(stage, checkpoint)).toBe(false);
  });

  it('banner hidden: failed cycle without checkpoint', () => {
    const cycle: Record<string, unknown> = {
      cycleId: 'deadbeef',
      status: 'failed',
      stage: 'failed',
    };
    const stage = (cycle['stage'] as string) ?? 'unknown';
    const checkpoint = extractCheckpoint(cycle);
    expect(shouldShowResumeBanner(stage, checkpoint)).toBe(false);
  });
});
