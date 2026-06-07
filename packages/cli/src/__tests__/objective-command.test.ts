import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerObjectiveCommand } from '../commands/objective.js';
import { registerAllCommands } from '../commands/registry.js';

describe('agentforge objective', () => {
  let projectRoot: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-objective-command-'));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('delegates to cycle run with objective text, budget, and project root', async () => {
    const delegated: Array<Record<string, string>> = [];
    const program = createProgramWithStubbedCycleRun(delegated);

    await program.parseAsync([
      'objective',
      'Improve CLI onboarding',
      '--budget',
      '12.50',
      '--project-root',
      projectRoot,
    ], { from: 'user' });

    expect(delegated).toEqual([
      {
        projectRoot,
        objective: 'Improve CLI onboarding',
        budget: '12.5',
      },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts --max-cost-usd as the budget cap alias', async () => {
    const delegated: Array<Record<string, string>> = [];
    const program = createProgramWithStubbedCycleRun(delegated);

    await program.parseAsync([
      'objective',
      'Improve CLI onboarding',
      '--max-cost-usd',
      '9',
      '--project-root',
      projectRoot,
    ], { from: 'user' });

    expect(delegated).toEqual([
      {
        projectRoot,
        objective: 'Improve CLI onboarding',
        budget: '9',
      },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['0', '-1', 'abc', '12abc', ''])(
    'rejects invalid --budget value %s before delegating',
    async (budget) => {
      const delegated: Array<Record<string, string>> = [];
      const program = createProgramWithStubbedCycleRun(delegated);

      await program.parseAsync([
        'objective',
        'Improve CLI onboarding',
        '--budget',
        budget,
        '--project-root',
        projectRoot,
      ], { from: 'user' });

      expect(delegated).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(consoleError.mock.calls[0]?.[0]).toContain('--budget must be a positive number');
    },
  );

  it('requires an explicit budget cap', async () => {
    const delegated: Array<Record<string, string>> = [];
    const program = createProgramWithStubbedCycleRun(delegated);

    await program.parseAsync([
      'objective',
      'Improve CLI onboarding',
      '--project-root',
      projectRoot,
    ], { from: 'user' });

    expect(delegated).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain('--budget is required');
  });

  it('is registered in the shared command registry and documented in help', () => {
    const program = new Command();
    program.name('agentforge');
    registerAllCommands(program);

    const objective = program.commands.find((command) => command.name() === 'objective');
    expect(objective).toBeDefined();
    expect(program.helpInformation()).toContain('objective');
    expect(objective?.helpInformation()).toContain('Usage: agentforge objective [options] <text>');
    expect(objective?.helpInformation()).toContain('--budget <usd>');
    expect(objective?.helpInformation()).toContain('--max-cost-usd <usd>');
    expect(objective?.helpInformation()).toContain('--project-root <path>');
  });
});

function createProgramWithStubbedCycleRun(delegated: Array<Record<string, string>>): Command {
  const program = new Command();
  program.name('agentforge');
  program.exitOverride();

  const cycle = program
    .command('cycle')
    .description('Stub cycle command');

  cycle
    .command('run')
    .option('--project-root <path>', 'Project root')
    .option('--objective <text>', 'Objective text')
    .option('--budget <usd>', 'Budget')
    .action((options: Record<string, string>) => {
      delegated.push(options);
    });

  registerObjectiveCommand(program);
  return program;
}
