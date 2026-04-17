import type { Command } from "commander";
import { delegateTask } from "@agentforge/core";
import {
  parseRuntimeMode,
  parseBudget,
  parseLimit,
  printDelegateResponse,
  warnDeprecation,
} from "../utils/run-helpers.js";

async function delegateAction(
  taskParts: string[],
  options: {
    projectRoot?: string;
    runtime?: string;
    tool?: string[];
    budget?: string;
    limit?: string;
    run?: boolean;
  },
): Promise<void> {
  warnDeprecation("[compat] `delegate` is a root compatibility wrapper. Prefer `agentforge run delegate` from the package CLI.");

  const runtimeMode = parseRuntimeMode(options.runtime ?? 'auto');
  const budgetUsd = parseBudget(options.budget);
  const limit = parseLimit(options.limit ?? '5');
  if (!runtimeMode || budgetUsd === null || limit === null) {
    process.exitCode = 1;
    return;
  }

  const task = taskParts.join(' ').trim();
  if (!task) {
    console.error('Task is required.');
    process.exitCode = 1;
    return;
  }

  try {
    const delegated = await delegateTask({
      projectRoot: options.projectRoot ?? process.cwd(),
      task,
      limit,
      run: options.run ?? false,
      runtimeMode,
      ...(options.tool?.length ? { allowedTools: options.tool } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });

    printDelegateResponse(delegated, Boolean(options.run));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

export default function registerDelegateCommand(program: Command): void {
  program
    .command("delegate")
    .description("Compatibility wrapper for package-canonical `run delegate`")
    .argument("<task...>", "Task description")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--runtime <mode>", "Execution runtime (auto|sdk|claude-code-compat)", "auto")
    .option("--tool <tool...>", "Allowed Claude Code tools for claude-code-compat mode")
    .option("--budget <usd>", "Budget hint when running the selected agent")
    .option("--limit <count>", "Maximum recommendations to show", "5")
    .option("--run", "Execute the best match instead of recommendation-only mode")
    .action(delegateAction);
}
