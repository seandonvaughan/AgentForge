import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";

async function teamAction(options: {
  verbose?: boolean;
}): Promise<void> {
  const teamPath = join(process.cwd(), ".agentforge", "team.yaml");

  let manifest: TeamManifest;
  try {
    const raw = await readFile(teamPath, "utf-8");
    manifest = yaml.load(raw) as TeamManifest;
  } catch {
    console.log("No agents configured yet. Run `agentforge forge` first.");
    return;
  }

  console.log("Current Team Composition");
  console.log("=".repeat(40));
  console.log(`  Team: ${manifest.name}`);
  console.log(`  Forged: ${manifest.forged_at}`);
  console.log(`  Hash: ${manifest.project_hash}`);

  const categories = ["strategic", "implementation", "quality", "utility"] as const;
  for (const cat of categories) {
    const agents = manifest.agents[cat];
    if (agents.length > 0) {
      console.log(`\n  ${cat.charAt(0).toUpperCase() + cat.slice(1)}:`);
      for (const agent of agents) {
        // Determine model tier
        let model = "unknown";
        if (manifest.model_routing.opus.includes(agent)) model = "opus";
        else if (manifest.model_routing.sonnet.includes(agent)) model = "sonnet";
        else if (manifest.model_routing.haiku.includes(agent)) model = "haiku";

        console.log(`    - ${agent} (${model})`);
      }
    }
  }

  if (options.verbose) {
    // Load individual agent configs for detailed view
    const agentsDir = join(process.cwd(), ".agentforge", "agents");
    console.log("\n--- Detailed Agent Info ---");

    const allAgents = [
      ...manifest.agents.strategic,
      ...manifest.agents.implementation,
      ...manifest.agents.quality,
      ...manifest.agents.utility,
    ];

    for (const agentName of allAgents) {
      const filename = agentName.toLowerCase().replace(/\s+/g, "-") + ".yaml";
      const agentPath = join(agentsDir, filename);

      try {
        const raw = await readFile(agentPath, "utf-8");
        const agent = yaml.load(raw) as AgentTemplate;

        console.log(`\n  ${agent.name} (v${agent.version})`);
        console.log(`    Model: ${agent.model}`);
        console.log(`    Description: ${agent.description || "(none)"}`);
        if (agent.skills.length > 0) {
          console.log(`    Skills: ${agent.skills.join(", ")}`);
        }
        if (agent.collaboration.can_delegate_to.length > 0) {
          console.log(`    Delegates to: ${agent.collaboration.can_delegate_to.join(", ")}`);
        }
        if (agent.collaboration.reports_to) {
          console.log(`    Reports to: ${agent.collaboration.reports_to}`);
        }
      } catch {
        console.log(`\n  ${agentName}: (config not found)`);
      }
    }

    // Show delegation graph
    console.log("\n--- Delegation Graph ---");
    for (const [from, targets] of Object.entries(manifest.delegation_graph)) {
      if (targets.length > 0) {
        console.log(`  ${from} -> ${targets.join(", ")}`);
      }
    }
  }
}

export default function registerTeamCommand(program: Command): void {
  program
    .command("team")
    .description("Show current team composition")
    .option("--verbose", "Show detailed agent info")
    .action(teamAction);
}
