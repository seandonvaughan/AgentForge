import type { Command } from "commander";
import { rebuildTeamService } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

async function rebuildAction(options: {
  autoApply?: boolean;
  upgrade?: boolean;
}): Promise<void> {
  warnDeprecation("[compat] `rebuild` is a root compatibility wrapper. Prefer `agentforge team rebuild` from the package CLI.");
  try {
    const exitCode = await rebuildTeamService(process.cwd(), {
      ...(options.autoApply ? { autoApply: true } : {}),
      ...(options.upgrade ? { upgrade: true } : {}),
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export default function registerRebuildCommand(program: Command): void {
  program
    .command("rebuild")
    .description("Compatibility wrapper for package-canonical `team rebuild`")
    .option("--auto-apply", "Apply changes without review")
    .option("--upgrade", "Migrate v1 team to v2 format without running full rebuild")
    .action(rebuildAction);
}
