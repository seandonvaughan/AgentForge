import type { Command } from "commander";
import { showTeamCompatibility } from "../compat/package-team-services.js";

async function statusAction(): Promise<void> {
  console.warn("[compat] `status` is a root compatibility wrapper. Prefer `agentforge team` from the package CLI.");
  await showTeamCompatibility();
}

export default function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Compatibility wrapper for package-canonical team inspection")
    .action(statusAction);
}
