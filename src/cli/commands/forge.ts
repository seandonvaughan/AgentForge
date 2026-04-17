import type { Command } from "commander";
import { forgeTeamService } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

async function forgeAction(options: {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}): Promise<void> {
  warnDeprecation("[compat] `forge` is a root compatibility wrapper. Prefer `agentforge team forge` from the package CLI.");
  try {
    const exitCode = await forgeTeamService(process.cwd(), {
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.verbose ? { verbose: true } : {}),
      ...(options.domains ? { domains: options.domains } : {}),
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export default function registerForgeCommand(program: Command): void {
  program
    .command("forge")
    .description("Compatibility wrapper for package-canonical `team forge`")
    .option("--dry-run", "Show what would be generated without writing files")
    .option("--verbose", "Show detailed analysis output")
    .option("--domains <domains>", "Comma-separated list of domains to activate (e.g. software,business)")
    .action(forgeAction);
}
