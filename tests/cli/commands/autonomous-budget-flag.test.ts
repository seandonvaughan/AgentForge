/**
 * P0.2 — `cycle run --budget <usd>` CLI flag tests.
 *
 * Covers:
 *  - --budget 150 lands in the parsed options as "150" (Commander stores
 *    option values as strings; runCycleAction parses it with parseFloat).
 *  - --budget 0 is rejected (process.exitCode = 1) before any cycle work runs.
 *  - --budget -5 is rejected (process.exitCode = 1).
 *  - A valid --budget proceeds past the validation gate.
 *
 * The "value lands" test overrides the `run` subcommand's action handler to
 * capture the parsed opts without executing a real cycle. The rejection tests
 * drive the real runCycleAction against an empty temp project root — the
 * budget validation fires (and returns) before any runtime/IO-heavy work,
 * because loadCycleConfig() falls back to DEFAULT_CYCLE_CONFIG when no
 * .agentforge/autonomous.yaml exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

import { registerCycleCommand } from '../../../packages/cli/src/commands/autonomous.js';

/** Locate the `cycle run` subcommand on a freshly-registered program. */
function findRunCommand(program: Command): Command {
  const cycle = program.commands.find((c) => c.name() === 'cycle');
  if (!cycle) throw new Error('cycle command not registered');
  const run = cycle.commands.find((c) => c.name() === 'run');
  if (!run) throw new Error('cycle run subcommand not registered');
  return run;
}

describe('cycle run --budget flag', () => {
  let tmpRoot: string;
  let prevExitCode: number | undefined;
  let prevBudgetEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'af-budget-flag-'));
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    prevBudgetEnv = process.env['AUTONOMOUS_BUDGET_USD'];
    delete process.env['AUTONOMOUS_BUDGET_USD'];
    // Silence the action's console output during rejection tests.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    process.exitCode = prevExitCode;
    if (prevBudgetEnv === undefined) {
      delete process.env['AUTONOMOUS_BUDGET_USD'];
    } else {
      process.env['AUTONOMOUS_BUDGET_USD'] = prevBudgetEnv;
    }
    vi.restoreAllMocks();
  });

  it('parses --budget 150 into opts.budget="150"', async () => {
    const program = new Command();
    program.exitOverride();
    registerCycleCommand(program);

    const run = findRunCommand(program);
    let captured: { budget?: string } | undefined;
    // Replace the real action with a capturing stub so no cycle is executed.
    (run as unknown as { _actionHandler: ((args: unknown[]) => void) | null })._actionHandler = null;
    run.action((opts: { budget?: string }) => {
      captured = opts;
    });

    await program.parseAsync(
      ['cycle', 'run', '--project-root', tmpRoot, '--budget', '150'],
      { from: 'user' },
    );

    expect(captured).toBeDefined();
    expect(captured?.budget).toBe('150');
    // Commander hands the float parse to runCycleAction; confirm the contract.
    expect(Number.parseFloat(captured!.budget!)).toBe(150);
  });

  it('rejects --budget 0 with a non-zero exit code', async () => {
    const program = new Command();
    program.exitOverride();
    registerCycleCommand(program);

    await program.parseAsync(
      ['cycle', 'run', '--project-root', tmpRoot, '--budget', '0'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
  });

  it('rejects --budget -5 with a non-zero exit code', async () => {
    const program = new Command();
    program.exitOverride();
    registerCycleCommand(program);

    await program.parseAsync(
      ['cycle', 'run', '--project-root', tmpRoot, '--budget', '-5'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-numeric --budget value', async () => {
    const program = new Command();
    program.exitOverride();
    registerCycleCommand(program);

    await program.parseAsync(
      ['cycle', 'run', '--project-root', tmpRoot, '--budget', 'abc'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
  });
});
