/**
 * Safeguard #1 — cross-cycle loop guard.
 *
 * Root cause of the 2-day spin: nothing owned cross-cycle state, so the loop
 * could fail dozens of cycles in a row without noticing. This guard persists a
 * small `.agentforge/loop-state.json` and HALTs the loop after N consecutive
 * non-completing cycles, instead of re-spinning forever.
 *
 * See docs/superpowers/specs/2026-05-25-loop-safeguards-recommendations.md (#1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultLoopGuardState,
  evaluateLoopGuard,
  recordCycleOutcome,
  readLoopGuardState,
  writeLoopGuardState,
  assertLoopNotHalted,
  persistCycleOutcome,
  LoopHaltedError,
  type LoopGuardState,
} from '../loop-guard.js';

describe('evaluateLoopGuard', () => {
  it('does not halt when consecutive failed cycles are below the limit', () => {
    const state: LoopGuardState = { ...defaultLoopGuardState(), consecutiveFailedCycles: 2 };
    const result = evaluateLoopGuard(state, { maxConsecutiveFailedCycles: 3 });
    expect(result.halt).toBe(false);
  });

  it('halts with a reason naming the count when the limit is reached', () => {
    const state: LoopGuardState = { ...defaultLoopGuardState(), consecutiveFailedCycles: 3 };
    const result = evaluateLoopGuard(state, { maxConsecutiveFailedCycles: 3 });
    expect(result.halt).toBe(true);
    expect(result.reason ?? '').toContain('3');
  });
});

describe('recordCycleOutcome', () => {
  it('increments consecutiveFailedCycles when a cycle did not complete', () => {
    const next = recordCycleOutcome(defaultLoopGuardState(), { cycleId: 'c1', completed: false });
    expect(next.consecutiveFailedCycles).toBe(1);
    expect(next.lastOutcome).toBe('failed');
    expect(next.lastCycleId).toBe('c1');
  });

  it('resets consecutiveFailedCycles to 0 when a cycle completes', () => {
    const start: LoopGuardState = { ...defaultLoopGuardState(), consecutiveFailedCycles: 2 };
    const next = recordCycleOutcome(start, { cycleId: 'c2', completed: true });
    expect(next.consecutiveFailedCycles).toBe(0);
    expect(next.lastOutcome).toBe('completed');
  });
});

describe('loop-guard persistence', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-loopguard-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a default state when no file exists', () => {
    expect(readLoopGuardState(root).consecutiveFailedCycles).toBe(0);
  });

  it('round-trips state through write then read', () => {
    const s: LoopGuardState = {
      ...defaultLoopGuardState(),
      consecutiveFailedCycles: 2,
      lastCycleId: 'c9',
    };
    writeLoopGuardState(root, s);
    const read = readLoopGuardState(root);
    expect(read.consecutiveFailedCycles).toBe(2);
    expect(read.lastCycleId).toBe('c9');
  });

  it('tolerates a corrupt state file by falling back to default', () => {
    mkdirSync(join(root, '.agentforge'), { recursive: true });
    writeFileSync(join(root, '.agentforge', 'loop-state.json'), '{ not valid json');
    expect(readLoopGuardState(root).consecutiveFailedCycles).toBe(0);
  });
});

describe('assertLoopNotHalted (pre-flight)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-loopguard-assert-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws LoopHaltedError and records the reason when the limit is reached', () => {
    writeLoopGuardState(root, { ...defaultLoopGuardState(), consecutiveFailedCycles: 3 });
    expect(() =>
      assertLoopNotHalted(root, { maxConsecutiveFailedCycles: 3 }),
    ).toThrowError(LoopHaltedError);
    expect(readLoopGuardState(root).haltedReason).toBeTruthy();
  });

  it('does not throw when under the limit', () => {
    writeLoopGuardState(root, { ...defaultLoopGuardState(), consecutiveFailedCycles: 1 });
    expect(() =>
      assertLoopNotHalted(root, { maxConsecutiveFailedCycles: 3 }),
    ).not.toThrow();
  });
});

describe('persistCycleOutcome', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-loopguard-persist-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('increments the failure streak on disk across non-completing cycles', () => {
    persistCycleOutcome(root, { cycleId: 'c1', completed: false });
    persistCycleOutcome(root, { cycleId: 'c2', completed: false });
    expect(readLoopGuardState(root).consecutiveFailedCycles).toBe(2);
  });

  it('resets the failure streak on disk when a cycle completes', () => {
    persistCycleOutcome(root, { cycleId: 'c1', completed: false });
    persistCycleOutcome(root, { cycleId: 'c2', completed: true });
    expect(readLoopGuardState(root).consecutiveFailedCycles).toBe(0);
  });
});
