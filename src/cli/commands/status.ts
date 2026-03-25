import type { Command } from "commander";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { TeamManifest } from "../../types/team.js";

async function statusAction(): Promise<void> {
  console.log("AgentForge Status");
  console.log("=".repeat(40));

  const agentforgeDir = join(process.cwd(), ".agentforge");

  // Check if .agentforge/ exists
  try {
    await access(agentforgeDir);
  } catch {
    console.log("\n  Status: not initialized");
    console.log("  AgentForge not initialized. Run 'agentforge forge' to get started.");
    return;
  }

  // Read team manifest
  const teamPath = join(agentforgeDir, "team.yaml");
  let manifest: TeamManifest;
  try {
    const raw = await readFile(teamPath, "utf-8");
    manifest = yaml.load(raw) as TeamManifest;
  } catch {
    console.log("\n  Status: partially initialized (no team manifest)");
    console.log("  Run 'agentforge forge' to generate an agent team.");
    return;
  }

  const totalAgents =
    manifest.agents.strategic.length +
    manifest.agents.implementation.length +
    manifest.agents.quality.length +
    manifest.agents.utility.length;

  console.log(`\n  Status: forged`);
  console.log(`  Team: ${manifest.name}`);
  console.log(`  Forged at: ${manifest.forged_at}`);
  console.log(`  Forged by: ${manifest.forged_by}`);
  console.log(`  Project hash: ${manifest.project_hash}`);
  console.log(`  Total agents: ${totalAgents}`);
  console.log(`    Strategic: ${manifest.agents.strategic.length}`);
  console.log(`    Implementation: ${manifest.agents.implementation.length}`);
  console.log(`    Quality: ${manifest.agents.quality.length}`);
  console.log(`    Utility: ${manifest.agents.utility.length}`);

  // Show forge log tail if available
  const logPath = join(agentforgeDir, "forge.log");
  try {
    const log = await readFile(logPath, "utf-8");
    const lines = log.trim().split("\n");
    const lastLines = lines.slice(-3);
    console.log("\n  Recent activity:");
    for (const line of lastLines) {
      console.log(`    ${line}`);
    }
  } catch {
    // No log file — that's fine
  }
}

export default function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show AgentForge status and last forge date")
    .action(statusAction);
}
