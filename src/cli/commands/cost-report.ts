import type { Command } from "commander";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

async function costReportAction(): Promise<void> {
  console.log("Token Usage & Cost Report");
  console.log("=".repeat(40));

  const agentforgeDir = join(process.cwd(), ".agentforge");

  // Check if .agentforge/ exists
  try {
    await access(agentforgeDir);
  } catch {
    console.log("\n  AgentForge not initialized. Run 'agentforge forge' first.");
    return;
  }

  // Try to read persisted cost data
  const costPath = join(agentforgeDir, "cost-data.json");
  try {
    const raw = await readFile(costPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    console.log("\n  Recorded usage data:");
    console.log(`  ${JSON.stringify(data, null, 2)}`);
  } catch {
    console.log("\n  No usage data recorded yet.");
    console.log("  Cost tracking is available during agent runtime.");
    console.log("  Invoke agents to start recording token usage and costs.");
    console.log("\n  Cost estimates by model tier:");
    console.log("    Opus:   ~$15.00 / 1M input tokens,  ~$75.00 / 1M output tokens");
    console.log("    Sonnet: ~$3.00 / 1M input tokens,   ~$15.00 / 1M output tokens");
    console.log("    Haiku:  ~$0.25 / 1M input tokens,   ~$1.25 / 1M output tokens");
  }
}

export default function registerCostReportCommand(program: Command): void {
  program
    .command("cost-report")
    .description("Show token usage and cost breakdown by agent")
    .action(costReportAction);
}
