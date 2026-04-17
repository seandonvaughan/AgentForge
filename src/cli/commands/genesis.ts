import type { Command } from "commander";
import { genesisTeamService } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

async function genesisAction(options: {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}): Promise<void> {
  warnDeprecation("[compat] `genesis` is a root compatibility wrapper. Prefer `agentforge team genesis` from the package CLI.");
  try {
    const exitCode = await genesisTeamService(process.cwd(), {
      ...(options.interview ? { interview: true } : {}),
      ...(options.domains ? { domains: options.domains } : {}),
      ...(options.yes ? { yes: true } : {}),
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export default function registerGenesisCommand(program: Command): void {
  program
    .command("genesis")
    .description("Compatibility wrapper for package-canonical `team genesis`")
    .option("--interview", "Force interview mode even if project files exist")
    .option("--domains <domains>", "Comma-separated list of domains to activate (e.g. software,business)")
    .option("--yes", "Skip approval gate (useful for CI/CD)")
    .action(genesisAction);
}
