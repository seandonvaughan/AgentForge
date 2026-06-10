/**
 * `agentforge objective <text>` — thin alias for the objective-mode cycle run.
 *
 * Operators launch objective cycles via:
 *
 *   agentforge objective "add observability to the executor" --budget 300
 *
 * The command validates the --budget value, then delegates to
 * `autonomous:cycle --objective <text> --budget <usd> --project-root <path>`,
 * reusing the exact same action handler in autonomous.ts without duplicating
 * the cycle-run logic.
 *
 * Use `agentforge cycle preview --objective <text>` to inspect the epic plan
 * before committing to execution.
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import { registerAutonomousCommand } from './autonomous.js';

interface ObjectiveOptions {
  budget: string;
  projectRoot?: string;
  dryRun: boolean;
  modelCap?: string;
  effortCap?: string;
  maxAgents?: string;
}

/**
 * Build the args array that `objective` forwards to `autonomous:cycle`.
 *
 * Exported so tests can verify the alias wires the correct flags without
 * executing a real cycle.
 */
export function buildObjectiveCycleArgs(opts: {
  text: string;
  budget: number;
  projectRoot: string;
  dryRun?: boolean;
  modelCap?: string;
  effortCap?: string;
  maxAgents?: string;
}): string[] {
  return [
    'autonomous:cycle',
    '--objective', opts.text,
    '--budget', String(opts.budget),
    '--project-root', opts.projectRoot,
    ...(opts.dryRun ? ['--dry-run'] : []),
    ...(opts.modelCap ? ['--model-cap', opts.modelCap] : []),
    ...(opts.effortCap ? ['--effort-cap', opts.effortCap] : []),
    ...(opts.maxAgents ? ['--max-agents', opts.maxAgents] : []),
  ];
}

export function registerObjectiveCommand(program: Command): void {
  program
    .command('objective <text>')
    .description(
      'Run an objective-mode autonomous cycle.\n\n' +
      'Decomposes a high-level goal into a wave-ordered epic and executes it ' +
      'as a single cohesive PR.\n\n' +
      'The --budget flag is required and caps total spend for this cycle.\n' +
      'Use "agentforge cycle preview --objective <text>" to inspect the plan first.',
    )
    .requiredOption(
      '--budget <usd>',
      'Per-cycle budget in USD (required, must be a positive number)',
    )
    .option(
      '--project-root <path>',
      'Project root (default: current directory)',
    )
    .option('--dry-run', 'Skip opening the PR; still run all other stages', false)
    .option('--model-cap <tier>', 'Cap model tier: fable, opus, sonnet, or haiku')
    .option('--effort-cap <effort>', 'Cap effort: low, medium, high, xhigh, or max')
    .option('--max-agents <count>', 'Override maximum execute-phase parallel agents')
    .action(async (text: string, opts: ObjectiveOptions): Promise<void> => {
      const budget = Number.parseFloat(opts.budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        console.error(
          `Error: --budget must be a positive number, got "${opts.budget}".`,
        );
        process.exitCode = 1;
        return;
      }

      const projectRoot = resolve(opts.projectRoot ?? process.cwd());

      // Delegate to the autonomous:cycle action via a mini-program so the
      // objective/epic run path in autonomous.ts is reused verbatim — no
      // logic duplication.
      const mini = new Command();
      registerAutonomousCommand(mini);
      await mini.parseAsync(
        buildObjectiveCycleArgs({
          text,
          budget,
          projectRoot,
          dryRun: opts.dryRun,
          ...(opts.modelCap !== undefined ? { modelCap: opts.modelCap } : {}),
          ...(opts.effortCap !== undefined ? { effortCap: opts.effortCap } : {}),
          ...(opts.maxAgents !== undefined ? { maxAgents: opts.maxAgents } : {}),
        }),
        { from: 'user' },
      );
    });
}
