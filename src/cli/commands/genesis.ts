import type { Command } from "commander";
import { genesisTeamCompatibility } from "../compat/package-team-services.js";

async function genesisAction(options: {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}): Promise<void> {
  console.warn("[compat] `genesis` is a root compatibility wrapper. Prefer `agentforge team genesis` from the package CLI.");
  await genesisTeamCompatibility({
    ...(options.interview ? { interview: true } : {}),
    ...(options.domains ? { domains: options.domains } : {}),
    ...(options.yes ? { yes: true } : {}),
  });
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
