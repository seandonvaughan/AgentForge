import type { Command } from 'commander';

interface ObjectiveOptions {
  budget?: string;
  maxCostUsd?: string;
  projectRoot: string;
}

export function registerObjectiveCommand(program: Command): void {
  program
    .command('objective <text>')
    .description('Run one autonomous cycle from a high-level objective')
    .option('--budget <usd>', 'Per-cycle budget in USD')
    .option('--max-cost-usd <usd>', 'Maximum objective cycle cost in USD (alias for --budget)')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (text: string, options: ObjectiveOptions, command: Command) => {
      const objective = text.trim();
      if (objective.length === 0) {
        console.error('Error: objective text must not be empty.');
        process.exitCode = 1;
        return;
      }

      const budgetOption = resolveBudgetOption(options);
      if (budgetOption === null) {
        process.exitCode = 1;
        return;
      }

      const budgetUsd = parseBudgetUsd(budgetOption.value);
      if (budgetUsd === null) {
        console.error(`Error: ${budgetOption.flag} must be a positive number, got "${budgetOption.value}".`);
        process.exitCode = 1;
        return;
      }

      const root = command.parent;
      if (!root) {
        throw new Error('objective command is not attached to a parent program');
      }

      await root.parseAsync([
        'cycle',
        'run',
        '--project-root',
        options.projectRoot,
        '--objective',
        objective,
        '--budget',
        String(budgetUsd),
      ], { from: 'user' });
    });
}

function resolveBudgetOption(options: ObjectiveOptions): { flag: string; value: string } | null {
  if (options.budget === undefined && options.maxCostUsd === undefined) {
    console.error('Error: --budget is required.');
    return null;
  }
  if (options.budget !== undefined && options.maxCostUsd !== undefined) {
    const budget = Number(options.budget.trim());
    const maxCostUsd = Number(options.maxCostUsd.trim());
    if (!Number.isFinite(budget) || !Number.isFinite(maxCostUsd) || budget !== maxCostUsd) {
      console.error('Error: --budget and --max-cost-usd must match when both are provided.');
      return null;
    }
  }

  return options.budget !== undefined
    ? { flag: '--budget', value: options.budget }
    : { flag: '--max-cost-usd', value: options.maxCostUsd as string };
}

function parseBudgetUsd(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(trimmed)) {
    return null;
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}
