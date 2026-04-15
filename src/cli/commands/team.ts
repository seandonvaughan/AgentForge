import type { Command } from "commander";
import { showTeamCompatibility } from "../compat/package-team-services.js";

async function teamAction(options: {
  verbose?: boolean;
}): Promise<void> {
  console.warn("[compat] `team` is a root compatibility wrapper. Prefer the package-canonical `agentforge team` surface.");
  await showTeamCompatibility(options.verbose ? { verbose: true } : {});
}

export default function registerTeamCommand(program: Command): void {
  program
    .command("team")
    .description("Compatibility wrapper for package-canonical `team`")
    .option("--verbose", "Show detailed agent info")
    .action(teamAction);
}
