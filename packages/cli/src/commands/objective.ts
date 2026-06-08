/**
 * `agentforge objective "<text>" --budget <usd> [--project-root <path>]`
 *
 * Thin alias that decomposes a high-level objective into a dependency-ordered
 * sprint and runs it as a single autonomous cycle.  Delegates to
 * `cycle run --objective <text> --budget <usd>` so all cycle launch controls,
 * budget enforcement, and worktree isolation are inherited automatically.
 *
 * Iron-law compliance:
 *  - `--budget` is REQUIRED (no unlimited runs).
 *  - Budget is validated to be a finite positive number before delegation.
 */

import { Command } from 'commander';
import { registerCycleCommand } from './autonomous.js';

interface ObjectiveActionOptions {
  budget: string;
  projectRoot: string;
}

async function runObjectiveAction(
  text: string,
  opts: ObjectiveActionOptions,
): Promise<void> {
  const budget = Number.parseFloat(opts.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error(
      `Invalid --budget value: "${opts.budget}". Must be a positive number (e.g. --budget 10).`,
    );
    process.exitCode = 1;
    return;
  }

  // Build a delegate sub-program containing only the cycle command so we can
  // forward to `cycle run --objective <text> --budget <usd>` without importing
  // bin.ts (which would create a top-level circular reference: bin → registry →
  // objective → bin).
  //
  // exitOverride() converts Commander's process.exit() calls (on unknown flags
  // or missing required options) into thrown CommanderErrors so they don't
  // terminate the parent process unexpectedly during tests.
  const delegate = new Command().exitOverride();
  registerCycleCommand(delegate);

  try {
    await delegate.parseAsync([
      'node',
      'agentforge',
      'cycle',
      'run',
      '--objective',
      text,
      '--budget',
      String(budget),
      '--project-root',
      opts.projectRoot,
    ]);
  } catch {
    // exitOverride() causes Commander parse/validation errors to throw; the
    // downstream cycle action sets process.exitCode directly rather than calling
    // process.exit(), so this catch is only needed for Commander-level failures.
  }
}

export function registerObjectiveCommand(program: Command): void {
  program
    .command('objective')
    .description(
      'Run an objective-mode autonomous cycle — decompose <text> into a dependency-ordered sprint',
    )
    .argument('<text>', 'High-level objective text to decompose and execute')
    .requiredOption(
      '--budget <usd>',
      'Per-cycle budget cap in USD (required; all objective runs must have an explicit limit)',
    )
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(runObjectiveAction);
}
