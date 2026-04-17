import type { Command } from "commander";
import { showGeneratedTeam } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

async function statusAction(): Promise<void> {
  warnDeprecation("[compat] `status` is a root compatibility wrapper. Prefer `agentforge team` from the package CLI.");
  try {
    const exitCode = await showGeneratedTeam(process.cwd(), {});
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export default function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Compatibility wrapper for package-canonical team inspection")
    .action(statusAction);
}
