import type { Command } from "commander";
import {
  applyReforgeProposalService,
  listReforgeStateService,
  rollbackReforgeOverrideService,
  showReforgeStatusService,
} from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

const REFORGE_DEPRECATION =
  "[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.";

async function runReforgeAction(action: () => Promise<number>): Promise<void> {
  try {
    const exitCode = await action();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function applyProposalAction(
  proposalId: string,
  options: { yes?: boolean },
): Promise<void> {
  warnDeprecation(REFORGE_DEPRECATION);
  await runReforgeAction(() =>
    applyReforgeProposalService(process.cwd(), proposalId, options.yes ? { yes: true } : {}),
  );
}

async function listAction(): Promise<void> {
  warnDeprecation(REFORGE_DEPRECATION);
  await runReforgeAction(() => listReforgeStateService(process.cwd()));
}

async function rollbackAction(agentName: string): Promise<void> {
  warnDeprecation(REFORGE_DEPRECATION);
  await runReforgeAction(() => rollbackReforgeOverrideService(process.cwd(), agentName));
}

async function statusAction(): Promise<void> {
  warnDeprecation(REFORGE_DEPRECATION);
  await runReforgeAction(() => showReforgeStatusService(process.cwd()));
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
