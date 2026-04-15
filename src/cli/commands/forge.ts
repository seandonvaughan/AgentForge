import type { Command } from "commander";
import { forgeTeamCompatibility } from "../compat/package-team-services.js";

async function forgeAction(options: {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}): Promise<void> {
  console.warn("[compat] `forge` is a root compatibility wrapper. Prefer `agentforge team forge` from the package CLI.");
  await forgeTeamCompatibility({
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.verbose ? { verbose: true } : {}),
    ...(options.domains ? { domains: options.domains } : {}),
  });
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
