import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function rebuildAction(options: {
  autoApply?: boolean;
  upgrade?: boolean;
}): void {
  console.warn("[compat] `rebuild` is a root compatibility wrapper. Prefer `agentforge team rebuild` from the package CLI.");
  forwardToPackageCli("team rebuild", [
    "team",
    "rebuild",
    ...(options.autoApply ? ["--auto-apply"] : []),
    ...(options.upgrade ? ["--upgrade"] : []),
  ]);
}

export default function registerRebuildCommand(program: Command): void {
  program
    .command("rebuild")
    .description("Compatibility wrapper for package-canonical `team rebuild`")
    .option("--auto-apply", "Apply changes without review")
    .option("--upgrade", "Migrate v1 team to v2 format without running full rebuild")
    .action(rebuildAction);
}

function forwardToPackageCli(preferredCommand: string, args: string[]): void {
  const packageCliPath = fileURLToPath(new URL("../../../packages/cli/dist/bin.js", import.meta.url));
  if (!existsSync(packageCliPath)) {
    console.error(`Package CLI build not found at ${packageCliPath}. Build packages/cli first, then run \`${preferredCommand}\`.`);
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(process.execPath, [packageCliPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      AGENTFORGE_ROOT_COMPAT: "1",
    },
  });

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  const message = result.error instanceof Error ? result.error.message : `Failed to run ${preferredCommand}`;
  console.error(message);
  process.exitCode = 1;
}
