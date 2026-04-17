import type { Command } from "commander";
import { showGeneratedTeam } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

async function teamAction(options: {
  verbose?: boolean;
}): Promise<void> {
  warnDeprecation("[compat] `team` is a root compatibility wrapper. Prefer the package-canonical `agentforge team` surface.");
  try {
    const exitCode = await showGeneratedTeam(
      process.cwd(),
      options.verbose ? { verbose: true } : {},
    );
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export default function registerTeamCommand(program: Command): void {
  program
    .command("team")
    .description("Compatibility wrapper for package-canonical `team`")
    .option("--verbose", "Show detailed agent info")
    .action(teamAction);
}
