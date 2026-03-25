import type { Command } from "commander";

async function statusAction(): Promise<void> {
  console.log("AgentForge Status");
  console.log("-".repeat(30));

  // TODO: read persisted state and display status
  console.log("Status: not initialized");
  console.log("Last forge: never");
}

export default function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show AgentForge status and last forge date")
    .action(statusAction);
}
