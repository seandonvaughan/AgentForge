import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function genesisAction(options: {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}): void {
  console.warn("[compat] `genesis` is a root compatibility wrapper. Prefer `agentforge team genesis` from the package CLI.");
  forwardToPackageCli("team genesis", [
    "team",
    "genesis",
    ...(options.interview ? ["--interview"] : []),
    ...(options.domains ? ["--domains", options.domains] : []),
    ...(options.yes ? ["--yes"] : []),
  ]);
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
