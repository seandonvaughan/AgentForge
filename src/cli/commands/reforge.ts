import type { Command } from "commander";
import {
  applyReforgeCompatibility,
  listReforgeCompatibility,
  rollbackReforgeCompatibility,
  statusReforgeCompatibility,
} from "../compat/package-team-services.js";

async function applyProposalAction(
  proposalId: string,
  options: { yes?: boolean },
): Promise<void> {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  await applyReforgeCompatibility(
    proposalId,
    options.yes ? { yes: true } : {},
  );
}

async function listAction(): Promise<void> {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  await listReforgeCompatibility();
}

async function rollbackAction(agentName: string): Promise<void> {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  await rollbackReforgeCompatibility(agentName);
}

async function statusAction(): Promise<void> {
  console.warn("[compat] `reforge` is a root compatibility wrapper. Prefer `agentforge team reforge` from the package CLI.");
  await statusReforgeCompatibility();
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
