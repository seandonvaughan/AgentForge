import type { Command } from "commander";
import { runGenesis } from "../../genesis/index.js";
import type { DomainId } from "../../types/domain.js";

async function genesisAction(options: {
  interview?: boolean;
  domains?: string;
}): Promise<void> {
  console.log("Starting Genesis workflow...\n");

  try {
    // Parse comma-separated domains if provided
    const parsedDomains: DomainId[] | undefined = options.domains
      ? options.domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean) as DomainId[]
      : undefined;

    const result = await runGenesis({
      projectRoot: process.cwd(),
      interview: options.interview,
      domains: parsedDomains,
    });

    const { manifest, domains } = result;

    // Flatten all agents
    const allAgents = Object.values(manifest.agents).flat();

    console.log("--- Proposed Agent Team ---");
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Total agents: ${allAgents.length}`);

    // Show agent count by domain
    console.log("\n--- Domains Activated ---");
    for (const domain of domains) {
      console.log(`  ${domain}`);
    }

    // Show agents by category
    console.log("\n--- Agents by Category ---");
    const categories = Object.keys(manifest.agents) as (keyof typeof manifest.agents)[];
    for (const cat of categories) {
      const catAgents = manifest.agents[cat];
      if (Array.isArray(catAgents) && catAgents.length > 0) {
        console.log(`  ${cat}: ${catAgents.join(", ")}`);
      }
    }

    // Show agents by model tier
    console.log("\n--- Agents by Model Tier ---");
    if (manifest.model_routing.opus.length > 0) {
      console.log(`  Opus   (${manifest.model_routing.opus.length}): ${manifest.model_routing.opus.join(", ")}`);
    }
    if (manifest.model_routing.sonnet.length > 0) {
      console.log(`  Sonnet (${manifest.model_routing.sonnet.length}): ${manifest.model_routing.sonnet.join(", ")}`);
    }
    if (manifest.model_routing.haiku.length > 0) {
      console.log(`  Haiku  (${manifest.model_routing.haiku.length}): ${manifest.model_routing.haiku.join(", ")}`);
    }

    console.log("\nGenesis complete. Team written to .agentforge/team.yaml");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error during genesis: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerGenesisCommand(program: Command): void {
  program
    .command("genesis")
    .description("Start from an idea and build an optimized agent team")
    .option("--interview", "Force interview mode even if project files exist")
    .option("--domains <domains>", "Comma-separated list of domains to activate (e.g. software,business)")
    .action(genesisAction);
}
