import type { Command } from "commander";
import { invokeAgentRun } from "@agentforge/core";
import {
  parseRuntimeMode,
  parseBudget,
  printInvokeResponse,
  isAgentLookupError,
  warnDeprecation,
} from "../utils/run-helpers.js";

async function invokeAction(options: {
  agent: string;
  task: string;
  projectRoot?: string;
  runtime?: string;
  tool?: string[];
  budget?: string;
}): Promise<void> {
  warnDeprecation("[compat] `invoke` is a root compatibility wrapper. Prefer `agentforge run invoke` from the package CLI.");

  const runtimeMode = parseRuntimeMode(options.runtime ?? 'auto');
  const budgetUsd = parseBudget(options.budget);
  if (!runtimeMode || budgetUsd === null) {
    process.exitCode = 1;
    return;
  }

  try {
    const response = await invokeAgentRun({
      projectRoot: options.projectRoot ?? process.cwd(),
      agent: options.agent,
      task: options.task,
      runtimeMode,
      ...(options.tool?.length ? { allowedTools: options.tool } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });

    printInvokeResponse(response);
  } catch (error) {
    if (isAgentLookupError(error)) {
      console.error(error.message);
      if (error.availableAgents.length > 0) {
        console.error(
          `Available:    ${error.availableAgents
            .map((agent) => agent.agentId)
            .join(', ')}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
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
    .option("--budget <usd>", "Maximum USD spend for this session (default: 1.00)")
    .action(invokeAction);
}
