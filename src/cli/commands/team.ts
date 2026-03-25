import type { Command } from "commander";

async function teamAction(options: {
  verbose?: boolean;
}): Promise<void> {
  console.log("Current team composition:");

  if (options.verbose) {
    console.log("(verbose mode — showing detailed agent info)");
  }

  // TODO: load and display current agent team configuration
  console.log("No agents configured yet. Run `agentforge forge` first.");
}

export default function registerTeamCommand(program: Command): void {
  program
    .command("team")
    .description("Show current team composition")
    .option("--verbose", "Show detailed agent info")
    .action(teamAction);
}
