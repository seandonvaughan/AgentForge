import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function teamAction(options: {
  verbose?: boolean;
}): void {
  console.warn("[compat] `team` is a root compatibility wrapper. Prefer the package-canonical `agentforge team` surface.");
  forwardToPackageCli("team", [
    "team",
    ...(options.verbose ? ["--verbose"] : []),
  ]);
}

export default function registerTeamCommand(program: Command): void {
  program
    .command("team")
    .description("Compatibility wrapper for package-canonical `team`")
    .option("--verbose", "Show detailed agent info")
    .action(teamAction);
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
