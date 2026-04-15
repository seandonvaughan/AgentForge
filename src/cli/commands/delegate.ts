import type { Command } from "commander";
import { delegateRunCompatibility } from "../compat/package-run-services.js";

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
  console.warn("[compat] `delegate` is a root compatibility wrapper. Prefer `agentforge run delegate` from the package CLI.");
  await delegateRunCompatibility(taskParts, options);
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
