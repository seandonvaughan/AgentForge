import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function forgeAction(options: {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}): void {
  console.warn("[compat] `forge` is a root compatibility wrapper. Prefer `agentforge team forge` from the package CLI.");
  forwardToPackageCli("team forge", [
    "team",
    "forge",
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.verbose ? ["--verbose"] : []),
    ...(options.domains ? ["--domains", options.domains] : []),
  ]);
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
