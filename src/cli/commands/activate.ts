import type { Command } from "commander";

async function activateAction(): Promise<void> {
  console.warn("[compat] `activate` has been retired from the canonical surface.");
  console.error(
    "Root-only live team mode is no longer supported. Use `agentforge run invoke`, `agentforge run delegate --run`, `agentforge cycle run`, or the package dashboard/server flows instead.",
  );
  process.exitCode = 1;
}

export default function registerActivateCommand(program: Command): void {
  program
    .command("activate")
    .description("Deprecated compatibility stub; live root-only team mode has been retired")
    .action(activateAction);
}
