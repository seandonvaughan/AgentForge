import type { Command } from "commander";
import { getActiveSession } from "./activate.js";

async function deactivateAction(): Promise<void> {
  try {
    console.warn("[legacy] `deactivate` still uses the root-only team mode runtime. No package-canonical equivalent exists yet.");

    const session = getActiveSession();

    if (!session || session.getState() !== "active") {
      console.error("No active team mode session. Nothing to deactivate.");
      process.exitCode = 1;
      return;
    }

    const entries = session.getFeedEntries();
    const sessionId = session.getSessionId().slice(0, 8);

    await session.deactivate();

    console.log(`\n  Team Mode DEACTIVATED`);
    console.log(`  --------------------------------`);
    console.log(`  Session:      ${sessionId}`);
    console.log(`  Feed entries: ${entries.length}`);
    console.log(`\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Deactivation failed: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerDeactivateCommand(program: Command): void {
  program
    .command("deactivate")
    .description("Legacy root-only team mode deactivation")
    .action(deactivateAction);
}
