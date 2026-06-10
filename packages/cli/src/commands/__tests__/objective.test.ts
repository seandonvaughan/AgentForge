/**
 * Tests for `agentforge objective <text> --budget <usd>`.
 *
 * Covers:
 *  - Command registration (name, required/optional options, description)
 *  - Budget validation failure (zero, negative, non-numeric)
 *  - That the alias correctly forwards objective text, budget, and projectRoot
 *    to the cycle-run path (via buildObjectiveCycleArgs and action stub)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerObjectiveCommand, buildObjectiveCycleArgs } from '../objective.js';

describe('registerObjectiveCommand', () => {
  let program: Command;
  let prevExitCode: number | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'af-objective-'));
    prevExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
    program = new Command();
    program.exitOverride();
    registerObjectiveCommand(program);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  // ── Registration ────────────────────────────────────────────────────────────

  it('registers a command named "objective"', () => {
    const cmd = program.commands.find((c) => c.name() === 'objective');
    expect(cmd).toBeDefined();
  });

  it('has a required --budget option', () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    const opt = cmd.options.find((o) => o.long === '--budget');
    expect(opt).toBeDefined();
    expect(opt?.mandatory).toBe(true);
  });

  it('has an optional --project-root option', () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    const opt = cmd.options.find((o) => o.long === '--project-root');
    expect(opt).toBeDefined();
    expect(opt?.mandatory).toBeFalsy();
  });

  // ── Help text ───────────────────────────────────────────────────────────────

  it('includes "objective-mode" in the description', () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    expect(cmd.description()).toContain('objective-mode');
  });

  it('mentions the budget flag in the description', () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    expect(cmd.description()).toContain('--budget');
  });

  // ── Budget validation failures ──────────────────────────────────────────────

  it('rejects --budget 0 with exitCode 1', async () => {
    await program.parseAsync(
      ['objective', 'do something', '--budget', '0'],
      { from: 'user' },
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects --budget -5 with exitCode 1', async () => {
    await program.parseAsync(
      ['objective', 'do something', '--budget', '-5'],
      { from: 'user' },
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-numeric --budget with exitCode 1', async () => {
    await program.parseAsync(
      ['objective', 'do something', '--budget', 'notanumber'],
      { from: 'user' },
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects an infinite --budget with exitCode 1', async () => {
    await program.parseAsync(
      ['objective', 'do something', '--budget', 'Infinity'],
      { from: 'user' },
    );
    expect(process.exitCode).toBe(1);
  });

  // ── Forwarding: spy/stub the runner ────────────────────────────────────────

  it('forwards objective text, budget, and projectRoot to the runner', async () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    let capturedText: string | undefined;
    let capturedOpts: { budget?: string; projectRoot?: string } | undefined;

    // Stub the runner so no real cycle executes — same pattern used in
    // tests/cli/commands/autonomous-budget-flag.test.ts.
    (cmd as unknown as { _actionHandler: null })._actionHandler = null;
    cmd.action((text: string, opts: { budget?: string; projectRoot?: string }) => {
      capturedText = text;
      capturedOpts = opts;
    });

    await program.parseAsync(
      ['objective', 'build the observability layer', '--budget', '200', '--project-root', tmpRoot],
      { from: 'user' },
    );

    expect(capturedText).toBe('build the observability layer');
    expect(capturedOpts?.budget).toBe('200');
    expect(capturedOpts?.projectRoot).toBe(tmpRoot);
  });

  it('budget string parses to a positive float', async () => {
    const cmd = program.commands.find((c) => c.name() === 'objective')!;
    let capturedBudget: string | undefined;

    (cmd as unknown as { _actionHandler: null })._actionHandler = null;
    cmd.action((_text: string, opts: { budget?: string }) => {
      capturedBudget = opts.budget;
    });

    await program.parseAsync(
      ['objective', 'deploy the new pipeline', '--budget', '49.95'],
      { from: 'user' },
    );

    expect(capturedBudget).toBe('49.95');
    expect(Number.parseFloat(capturedBudget!)).toBe(49.95);
  });
});

// ── buildObjectiveCycleArgs ─────────────────────────────────────────────────

describe('buildObjectiveCycleArgs', () => {
  it('returns autonomous:cycle as the first element', () => {
    const args = buildObjectiveCycleArgs({
      text: 'add observability',
      budget: 300,
      projectRoot: '/my/project',
    });
    expect(args[0]).toBe('autonomous:cycle');
  });

  it('includes --objective with the text', () => {
    const args = buildObjectiveCycleArgs({
      text: 'add observability',
      budget: 300,
      projectRoot: '/my/project',
    });
    const idx = args.indexOf('--objective');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('add observability');
  });

  it('includes --budget with the numeric value as string', () => {
    const args = buildObjectiveCycleArgs({
      text: 'add observability',
      budget: 300,
      projectRoot: '/my/project',
    });
    const idx = args.indexOf('--budget');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('300');
  });

  it('includes --project-root with the projectRoot', () => {
    const args = buildObjectiveCycleArgs({
      text: 'add observability',
      budget: 300,
      projectRoot: '/my/project',
    });
    const idx = args.indexOf('--project-root');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('/my/project');
  });

  it('includes --dry-run when dryRun is true', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
      dryRun: true,
    });
    expect(args).toContain('--dry-run');
  });

  it('omits --dry-run when dryRun is false', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
      dryRun: false,
    });
    expect(args).not.toContain('--dry-run');
  });

  it('omits --dry-run when dryRun is undefined', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
    });
    expect(args).not.toContain('--dry-run');
  });

  it('includes --model-cap when provided', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
      modelCap: 'sonnet',
    });
    expect(args).toContain('--model-cap');
    expect(args[args.indexOf('--model-cap') + 1]).toBe('sonnet');
  });

  it('includes --effort-cap when provided', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
      effortCap: 'high',
    });
    expect(args).toContain('--effort-cap');
    expect(args[args.indexOf('--effort-cap') + 1]).toBe('high');
  });

  it('includes --max-agents when provided', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
      maxAgents: '8',
    });
    expect(args).toContain('--max-agents');
    expect(args[args.indexOf('--max-agents') + 1]).toBe('8');
  });

  it('omits optional flags when not provided', () => {
    const args = buildObjectiveCycleArgs({
      text: 'test',
      budget: 50,
      projectRoot: '/project',
    });
    expect(args).not.toContain('--model-cap');
    expect(args).not.toContain('--effort-cap');
    expect(args).not.toContain('--max-agents');
  });
});
