/**
 * P0.4 — KEYSTONE: `resolveWorktreeMode` decides whether the cycle runs in
 * isolated worktrees (and therefore whether a WorktreePool is constructed and
 * threaded to the CycleRunner).
 *
 * Objective/epic mode must enable worktrees (so children run in isolation and
 * the cycle releases ONE PR from the integration branch). Plain single-PR runs
 * must NOT (they commit from the main tree as before). multi-PR mode keeps its
 * existing behaviour. `--no-worktrees` / AUTONOMOUS_DISABLE_WORKTREES=1 always
 * short-circuit.
 */

import { describe, it, expect } from 'vitest';
import { resolveWorktreeMode } from '../../../packages/cli/src/commands/autonomous.js';

describe('resolveWorktreeMode (P0.4)', () => {
  it('objective mode enables worktrees on a single-PR cycle', () => {
    const r = resolveWorktreeMode({
      prMode: 'single',
      objectiveMode: true,
      disableWorktreesFlag: false,
      disableWorktreesEnv: false,
    });
    expect(r.worktreesSupportedForMode).toBe(true);
    expect(r.worktreesDisabled).toBe(false);
  });

  it('plain single-PR (non-objective) run does NOT enable worktrees', () => {
    const r = resolveWorktreeMode({
      prMode: 'single',
      objectiveMode: false,
      disableWorktreesFlag: false,
      disableWorktreesEnv: false,
    });
    expect(r.worktreesSupportedForMode).toBe(false);
    expect(r.worktreesDisabled).toBe(true);
  });

  it('multi-PR mode enables worktrees (regression — unchanged)', () => {
    const r = resolveWorktreeMode({
      prMode: 'multi',
      objectiveMode: false,
      disableWorktreesFlag: false,
      disableWorktreesEnv: false,
    });
    expect(r.worktreesSupportedForMode).toBe(true);
    expect(r.worktreesDisabled).toBe(false);
  });

  it('--no-worktrees short-circuits even in objective mode', () => {
    const r = resolveWorktreeMode({
      prMode: 'single',
      objectiveMode: true,
      disableWorktreesFlag: true,
      disableWorktreesEnv: false,
    });
    expect(r.worktreesDisabled).toBe(true);
  });

  it('AUTONOMOUS_DISABLE_WORKTREES=1 short-circuits even in objective mode', () => {
    const r = resolveWorktreeMode({
      prMode: 'single',
      objectiveMode: true,
      disableWorktreesFlag: false,
      disableWorktreesEnv: true,
    });
    expect(r.worktreesDisabled).toBe(true);
  });
});
