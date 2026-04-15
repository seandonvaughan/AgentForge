import type { Command } from "commander";

async function deactivateAction(): Promise<void> {
  console.warn("[compat] `deactivate` has been retired from the canonical surface.");
  console.error(
    "There is no root-owned active team mode to stop anymore. Use the package runtime/session surfaces instead.",
  );
  process.exitCode = 1;
}

export default function registerDeactivateCommand(program: Command): void {
  program
    .command("deactivate")
    .description("Deprecated compatibility stub; live root-only team mode has been retired")
    .action(deactivateAction);
}
