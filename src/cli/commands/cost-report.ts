import type { Command } from "commander";

async function costReportAction(): Promise<void> {
  console.log("Token Usage & Cost Report");
  console.log("=".repeat(40));

  // TODO: load usage data and display cost breakdown by agent
  console.log("No usage data recorded yet.");
}

export default function registerCostReportCommand(program: Command): void {
  program
    .command("cost-report")
    .description("Show token usage and cost breakdown by agent")
    .action(costReportAction);
}
