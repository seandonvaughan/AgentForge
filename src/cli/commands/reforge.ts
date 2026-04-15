import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function applyProposalAction(
  proposalId: string,
  options: { yes?: boolean },
): void {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  forwardToPackageCli("team reforge apply", [
    "team",
    "reforge",
    "apply",
    proposalId,
    ...(options.yes ? ["--yes"] : []),
  ]);
}

function listAction(): void {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  forwardToPackageCli("team reforge list", ["team", "reforge", "list"]);
}

function rollbackAction(agentName: string): void {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  forwardToPackageCli("team reforge rollback", ["team", "reforge", "rollback", agentName]);
}

function statusAction(): void {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  forwardToPackageCli("team reforge status", ["team", "reforge", "status"]);
}

export default function registerReforgeCommand(program: Command): void {
  const reforgeCmd = program
    .command("reforge")
    .description("Compatibility wrapper for package-canonical `team reforge`");

  // Phase 3f: apply structural proposal
  reforgeCmd
    .command("apply <proposal-id>")
    .description("Review and apply a structural reforge proposal")
    .option("--yes", "Apply without confirmation prompt")
    .action(applyProposalAction);

  // Phase 3f: list proposals and overrides
  reforgeCmd
    .command("list")
    .description("List pending proposals and active overrides")
    .action(listAction);

  // Phase 3f: rollback agent override
  reforgeCmd
    .command("rollback <agent>")
    .description("Rollback an agent override to its previous version")
    .action(rollbackAction);

  // Phase 3f: show reforge status
  reforgeCmd
    .command("status")
    .description("Show reforge override status for all agents")
    .action(statusAction);
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
