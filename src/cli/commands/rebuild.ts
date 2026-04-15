import type { Command } from "commander";
import { rebuildTeamCompatibility } from "../compat/package-team-services.js";

async function rebuildAction(options: {
  autoApply?: boolean;
  upgrade?: boolean;
}): Promise<void> {
  console.warn("[compat] `rebuild` is a root compatibility wrapper. Prefer `agentforge team rebuild` from the package CLI.");
  await rebuildTeamCompatibility({
    ...(options.autoApply ? { autoApply: true } : {}),
    ...(options.upgrade ? { upgrade: true } : {}),
  });
}

export default function registerRebuildCommand(program: Command): void {
  program
    .command("rebuild")
    .description("Compatibility wrapper for package-canonical `team rebuild`")
    .option("--auto-apply", "Apply changes without review")
    .option("--upgrade", "Migrate v1 team to v2 format without running full rebuild")
    .action(rebuildAction);
}
