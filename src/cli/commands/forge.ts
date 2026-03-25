import type { Command } from "commander";
import { forgeTeam } from "../../builder/index.js";
import { runFullScan } from "../../scanner/index.js";

async function forgeAction(options: {
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<void> {
  console.log("Forging agent team...");

  try {
    if (options.verbose) {
      console.log("\nRunning project scan...");
      const scan = await runFullScan(process.cwd());
      console.log("\n--- Scan Results ---");
      console.log(`  Files scanned: ${scan.files.total_files}`);
      console.log(`  Lines of code: ${scan.files.total_loc}`);
      console.log(`  Languages: ${Object.keys(scan.files.languages).join(", ") || "none detected"}`);
      console.log(`  Frameworks: ${scan.files.frameworks_detected.join(", ") || "none detected"}`);
      console.log(`  CI provider: ${scan.ci.ci_provider}`);
      console.log(`  Package manager: ${scan.dependencies.package_manager}`);
      console.log(`  Production deps: ${scan.dependencies.total_production}`);
      console.log(`  Dev deps: ${scan.dependencies.total_development}`);
      console.log(`  Test frameworks: ${scan.dependencies.test_frameworks.join(", ") || "none"}`);
      console.log(`  Git commits: ${scan.git.total_commits}`);
      console.log(`  Contributors: ${scan.git.contributors.length}`);
    }

    if (options.dryRun) {
      console.log("\n[dry-run] Scanning project without writing files...");
      const scan = await runFullScan(process.cwd());
      const { composeTeam } = await import("../../builder/team-composer.js");
      const composition = composeTeam(scan);
      console.log("\n[dry-run] Would generate team with:");
      console.log(`  Agents: ${composition.agents.join(", ")}`);
      if (composition.custom_agents.length > 0) {
        console.log(`  Custom agents: ${composition.custom_agents.map((a) => a.name).join(", ")}`);
      }
      console.log(`\n  Model assignments:`);
      for (const [agent, model] of Object.entries(composition.model_assignments)) {
        console.log(`    ${agent}: ${model}`);
      }
      return;
    }

    const manifest = await forgeTeam(process.cwd());

    console.log("\nAgent team forged successfully.");

    // Count total agents across all categories
    const allAgents = [
      ...manifest.agents.strategic,
      ...manifest.agents.implementation,
      ...manifest.agents.quality,
      ...manifest.agents.utility,
    ];

    console.log(`\n--- Team Manifest ---`);
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Project hash: ${manifest.project_hash}`);
    console.log(`  Total agents: ${allAgents.length}`);

    // Show agents by category
    const categories = ["strategic", "implementation", "quality", "utility"] as const;
    for (const cat of categories) {
      const catAgents = manifest.agents[cat];
      if (catAgents.length > 0) {
        console.log(`  ${cat}: ${catAgents.join(", ")}`);
      }
    }

    // Show model assignments
    console.log("\n--- Model Assignments ---");
    if (manifest.model_routing.opus.length > 0) {
      console.log(`  Opus:   ${manifest.model_routing.opus.join(", ")}`);
    }
    if (manifest.model_routing.sonnet.length > 0) {
      console.log(`  Sonnet: ${manifest.model_routing.sonnet.join(", ")}`);
    }
    if (manifest.model_routing.haiku.length > 0) {
      console.log(`  Haiku:  ${manifest.model_routing.haiku.join(", ")}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error forging team: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerForgeCommand(program: Command): void {
  program
    .command("forge")
    .description("Analyze project and generate optimized agent team")
    .option("--dry-run", "Show what would be generated without writing files")
    .option("--verbose", "Show detailed analysis output")
    .action(forgeAction);
}
