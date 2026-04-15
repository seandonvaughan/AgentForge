import type { Command } from "commander";
import { invokeRunCompatibility } from "../compat/package-run-services.js";

async function invokeAction(options: {
  agent: string;
  task: string;
  projectRoot?: string;
  runtime?: string;
  tool?: string[];
  loop?: boolean;
  budget?: string;
}): Promise<void> {
  console.warn("[compat] `invoke` is a root compatibility wrapper. Prefer `agentforge run invoke` from the package CLI.");
  await invokeRunCompatibility(options);
}

export default function registerInvokeCommand(program: Command): void {
  program
    .command("invoke")
    .description("Compatibility wrapper for package-canonical `run invoke`")
    .requiredOption("--agent <agent>", "Name of the agent to invoke")
    .requiredOption("--task <task>", "Task description")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--runtime <mode>", "Execution runtime (auto|sdk|claude-code-compat)", "auto")
    .option("--tool <tool...>", "Allowed Claude Code tools for claude-code-compat mode")
    .option("--loop", "Deprecated compatibility flag; use `agentforge cycle run`")
    .option("--budget <usd>", "Maximum USD spend for this session (default: 1.00)")
    .action(invokeAction);
}
