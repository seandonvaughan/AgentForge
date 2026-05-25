// packages/core/src/autonomous/loop-guard.ts
//
// Safeguard #1 — cross-cycle loop guard.
//
// The root cause of the 2026-05-25 "2 days of wasted cycles" incident was that
// nothing owned cross-cycle state: `agentforge cycle run` builds one CycleRunner
// and exits, so an external repeat-invoker could fail dozens of cycles in a row
// with zero awareness. This module persists a tiny `.agentforge/loop-state.json`
// and lets CycleRunner.start() HALT before running when the loop is clearly
// unproductive (N consecutive non-completing cycles), instead of re-spinning.
//
// See docs/superpowers/specs/2026-05-25-loop-safeguards-recommendations.md (#1).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface LoopGuardState {
  v: 1;
  /** Number of consecutive cycles that ended without COMPLETING (failed/blocked/killed). */
  consecutiveFailedCycles: number;
  /** Id of the most recent cycle recorded. */
  lastCycleId: string | null;
  /** Outcome of the most recent cycle recorded. */
  lastOutcome: 'completed' | 'failed' | null;
  /** ISO timestamp of the last update. */
  lastUpdatedAt: string;
  /** Set when the guard halted the loop, for operator visibility. */
  haltedReason?: string;
}

export interface LoopGuardConfig {
  /** Halt the loop once this many cycles in a row fail to complete. */
  maxConsecutiveFailedCycles: number;
}

export interface LoopGuardDecision {
  halt: boolean;
  reason?: string;
}

/** Error thrown by the runner when the loop guard halts a run pre-flight. */
export class LoopHaltedError extends Error {
  constructor(public readonly guardReason: string) {
    super(`Loop halted by guard: ${guardReason}`);
    this.name = 'LoopHaltedError';
  }
}

const STATE_FILE = ['.agentforge', 'loop-state.json'] as const;

export function loopStatePath(projectRoot: string): string {
  return join(projectRoot, ...STATE_FILE);
}

export function defaultLoopGuardState(): LoopGuardState {
  return {
    v: 1,
    consecutiveFailedCycles: 0,
    lastCycleId: null,
    lastOutcome: null,
    lastUpdatedAt: new Date(0).toISOString(),
  };
}

/**
 * Decide whether the loop should halt BEFORE starting another cycle. Pure.
 */
export function evaluateLoopGuard(
  state: LoopGuardState,
  config: LoopGuardConfig,
): LoopGuardDecision {
  if (state.consecutiveFailedCycles >= config.maxConsecutiveFailedCycles) {
    return {
      halt: true,
      reason:
        `${state.consecutiveFailedCycles} consecutive cycles failed to complete ` +
        `(limit ${config.maxConsecutiveFailedCycles}). Halting to avoid an unproductive spin. ` +
        `Investigate the most recent cycle, then delete or reset .agentforge/loop-state.json to resume.`,
    };
  }
  return { halt: false };
}

/**
 * Fold a finished cycle's outcome into the guard state. Pure. A completing
 * cycle (gate-approved, work shipped/PR opened) resets the failure streak; any
 * non-completing outcome increments it.
 */
export function recordCycleOutcome(
  state: LoopGuardState,
  outcome: { cycleId: string; completed: boolean },
): LoopGuardState {
  return {
    ...state,
    consecutiveFailedCycles: outcome.completed ? 0 : state.consecutiveFailedCycles + 1,
    lastCycleId: outcome.cycleId,
    lastOutcome: outcome.completed ? 'completed' : 'failed',
    lastUpdatedAt: new Date().toISOString(),
  };
}

/** Read persisted guard state. Returns a default on missing or corrupt files. */
export function readLoopGuardState(projectRoot: string): LoopGuardState {
  try {
    const raw = readFileSync(loopStatePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LoopGuardState>;
    if (parsed && typeof parsed === 'object' && typeof parsed.consecutiveFailedCycles === 'number') {
      return { ...defaultLoopGuardState(), ...parsed };
    }
  } catch {
    // Missing or corrupt — fall through to default so the guard never blocks a run by erroring.
  }
  return defaultLoopGuardState();
}

/** Persist guard state to `.agentforge/loop-state.json`. */
export function writeLoopGuardState(projectRoot: string, state: LoopGuardState): void {
  const path = loopStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Pre-flight check for CycleRunner.start(): if the guard says halt, record the
 * reason and throw LoopHaltedError so the run aborts before any work begins and
 * the process exits non-zero (stopping an external repeat-invoker).
 */
export function assertLoopNotHalted(projectRoot: string, config: LoopGuardConfig): void {
  const state = readLoopGuardState(projectRoot);
  const decision = evaluateLoopGuard(state, config);
  if (decision.halt) {
    const reason = decision.reason ?? 'loop guard halt';
    writeLoopGuardState(projectRoot, { ...state, haltedReason: reason });
    throw new LoopHaltedError(reason);
  }
}

/**
 * Fold a finished cycle's outcome into the persisted guard state. Called by
 * CycleRunner.start() once the terminal stage is known. Never throws.
 */
export function persistCycleOutcome(
  projectRoot: string,
  outcome: { cycleId: string; completed: boolean },
): LoopGuardState {
  const updated = recordCycleOutcome(readLoopGuardState(projectRoot), outcome);
  writeLoopGuardState(projectRoot, updated);
  return updated;
}
