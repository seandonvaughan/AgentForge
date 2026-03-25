import type { Command } from "commander";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Cost entry schema written by session.end() */
interface CostEntry {
  sessionId: string;
  startedAt: string;     // ISO date string
  endedAt: string;       // ISO date string
  totalSpentUsd: number;
  totalAgentRuns: number;
  agentBreakdown?: Record<string, number>;  // agent name → USD spent
}

async function costReportAction(): Promise<void> {
  const agentforgeDir = join(process.cwd(), ".agentforge");
  const sessionsDir = join(agentforgeDir, "sessions");

  let costEntries: CostEntry[] = [];

  // Try to read cost entry files from sessions directory
  try {
    const files = await readdir(sessionsDir);
    const costFiles = files.filter((f) => f.startsWith("cost-entry-") && f.endsWith(".json"));

    if (costFiles.length > 0) {
      // Read all cost entry files
      for (const file of costFiles.sort()) {
        try {
          const raw = await readFile(join(sessionsDir, file), "utf-8");
          const entry = JSON.parse(raw) as CostEntry;
          costEntries.push(entry);
        } catch {
          // Skip files that can't be parsed
        }
      }
    }
  } catch {
    // Sessions directory doesn't exist or can't be read
  }

  if (costEntries.length === 0) {
    // No cost entries found - show pricing reference
    console.log("No sessions recorded yet.");
    console.log("Run `agentforge invoke` to start tracking real costs.\n");
    console.log("--- Model Tier Pricing Reference ---");
    console.log("Opus:   $15.00 / 1M input · $75.00 / 1M output");
    console.log("Sonnet: $3.00  / 1M input · $15.00 / 1M output");
    console.log("Haiku:  $0.25  / 1M input · $1.25  / 1M output");
    return;
  }

  // Aggregate cost data
  let totalSpent = 0;
  let totalRuns = 0;
  const agentBreakdown: Record<string, number> = {};

  for (const entry of costEntries) {
    totalSpent += entry.totalSpentUsd;
    totalRuns += entry.totalAgentRuns;

    // Aggregate per-agent breakdown if present
    if (entry.agentBreakdown) {
      for (const [agent, cost] of Object.entries(entry.agentBreakdown)) {
        agentBreakdown[agent] = (agentBreakdown[agent] ?? 0) + cost;
      }
    }
  }

  // Print main report
  console.log("--- AgentForge Cost Report ---\n");
  console.log(`Sessions recorded: ${costEntries.length}`);
  console.log(`Total spend: $${totalSpent.toFixed(4)}`);
  console.log(`Total agent runs: ${totalRuns}\n`);

  // Per-agent breakdown (if any agent data exists)
  if (Object.keys(agentBreakdown).length > 0) {
    console.log("--- Per-Agent Breakdown ---");
    const sortedAgents = Object.entries(agentBreakdown).sort((a, b) => b[1] - a[1]);
    for (const [agent, cost] of sortedAgents) {
      console.log(`${agent}: $${cost.toFixed(4)}`);
    }
    console.log();
  }

  // Last session details
  const lastEntry = costEntries[costEntries.length - 1];
  console.log("--- Last Session ---");
  console.log(`ID: ${lastEntry.sessionId}`);
  console.log(`Started: ${lastEntry.startedAt}`);
  console.log(`Ended: ${lastEntry.endedAt}`);
  console.log(`Spent: $${lastEntry.totalSpentUsd.toFixed(4)}`);
}

export default function registerCostReportCommand(program: Command): void {
  program
    .command("cost-report")
    .description("Show token usage and cost breakdown by agent")
    .action(costReportAction);
}
