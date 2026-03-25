/**
 * Team Writer — serializes a forged team to the `.agentforge/` directory.
 *
 * Creates the full directory structure including manifests, agent configs,
 * model routing, delegation graph, analysis artifacts, and a forge log.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { AgentTemplate } from "../types/agent.js";
import type { TeamManifest, ModelRouting, DelegationGraph } from "../types/team.js";
import type { FullScanResult } from "../scanner/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists (recursive). */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** Build a {@link ModelRouting} from the manifest's agent lists and agent templates. */
function buildModelRouting(
  manifest: TeamManifest,
  agents: Map<string, AgentTemplate>,
): ModelRouting {
  const routing: ModelRouting = { opus: [], sonnet: [], haiku: [] };

  const allAgentNames = [
    ...manifest.agents.strategic,
    ...manifest.agents.implementation,
    ...manifest.agents.quality,
    ...manifest.agents.utility,
  ];

  for (const name of allAgentNames) {
    const template = agents.get(name);
    const tier = template?.model ?? "sonnet";
    routing[tier].push(name);
  }

  return routing;
}

/** Build a {@link DelegationGraph} from agent templates. */
function buildDelegationGraph(
  agents: Map<string, AgentTemplate>,
): DelegationGraph {
  const graph: DelegationGraph = {};

  for (const [key, template] of agents) {
    if (template.collaboration.can_delegate_to.length > 0) {
      graph[key] = [...template.collaboration.can_delegate_to];
    }
  }

  return graph;
}

/** Format a timestamp for the forge log. */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/** Build a human-readable forge log summary. */
function buildForgeLog(
  manifest: TeamManifest,
  agents: Map<string, AgentTemplate>,
  scanResult: FullScanResult,
): string {
  const lines: string[] = [];
  const timestamp = formatTimestamp();

  lines.push(`AgentForge — Team Forge Log`);
  lines.push(`${"=".repeat(50)}`);
  lines.push(`Timestamp: ${timestamp}`);
  lines.push(`Team: ${manifest.name}`);
  lines.push(`Forged by: ${manifest.forged_by}`);
  lines.push(`Project hash: ${manifest.project_hash}`);
  lines.push(``);

  lines.push(`Project Summary`);
  lines.push(`${"─".repeat(30)}`);
  lines.push(`Total files scanned: ${scanResult.files.total_files}`);
  lines.push(`Total LOC: ${scanResult.files.total_loc}`);
  lines.push(
    `Languages: ${Object.keys(scanResult.files.languages).join(", ") || "none"}`,
  );
  lines.push(
    `Frameworks: ${scanResult.files.frameworks_detected.join(", ") || "none"}`,
  );
  lines.push(`Package manager: ${scanResult.dependencies.package_manager}`);
  lines.push(`CI provider: ${scanResult.ci.ci_provider}`);
  lines.push(``);

  lines.push(`Team Composition`);
  lines.push(`${"─".repeat(30)}`);
  lines.push(`Total agents: ${agents.size}`);
  lines.push(`Strategic: ${manifest.agents.strategic.join(", ") || "none"}`);
  lines.push(
    `Implementation: ${manifest.agents.implementation.join(", ") || "none"}`,
  );
  lines.push(`Quality: ${manifest.agents.quality.join(", ") || "none"}`);
  lines.push(`Utility: ${manifest.agents.utility.join(", ") || "none"}`);
  lines.push(``);

  lines.push(`Model Routing`);
  lines.push(`${"─".repeat(30)}`);
  const opusCount = manifest.model_routing.opus.length;
  const sonnetCount = manifest.model_routing.sonnet.length;
  const haikuCount = manifest.model_routing.haiku.length;
  lines.push(`Opus (strategic):       ${manifest.model_routing.opus.join(", ") || "none"} [${opusCount} agents]`);
  lines.push(`Sonnet (implementation): ${manifest.model_routing.sonnet.join(", ") || "none"} [${sonnetCount} agents]`);
  lines.push(`Haiku (utility):        ${manifest.model_routing.haiku.join(", ") || "none"} [${haikuCount} agents]`);
  lines.push(``);

  // Cost optimization summary — show how much model routing saves
  lines.push(`Cost Optimization`);
  lines.push(`${"─".repeat(30)}`);
  const allOnOpusCost = agents.size; // normalized: 1 unit per agent on opus
  const routedCost = opusCount * 1 + sonnetCount * 0.2 + haikuCount * 0.017; // relative to opus pricing
  const savingsPercent = Math.round((1 - routedCost / allOnOpusCost) * 100);
  lines.push(`If all agents ran on Opus: ${agents.size} agents × Opus pricing = baseline`);
  lines.push(`With model routing: ${opusCount} Opus + ${sonnetCount} Sonnet + ${haikuCount} Haiku`);
  lines.push(`Estimated cost savings: ~${savingsPercent}% vs all-Opus baseline`);
  lines.push(``);

  lines.push(`Delegation Graph`);
  lines.push(`${"─".repeat(30)}`);
  for (const [agent, delegates] of Object.entries(
    manifest.delegation_graph,
  )) {
    lines.push(`  ${agent} -> ${delegates.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write the full `.agentforge/` directory for a forged team.
 *
 * Creates the following structure:
 * ```
 * .agentforge/
 *   team.yaml              — the team manifest
 *   forge.log              — human-readable summary with timestamp
 *   analysis/
 *     project-scan.json    — raw FullScanResult
 *   agents/
 *     <name>.yaml          — one file per agent
 *   config/
 *     models.yaml          — model routing config
 *     delegation.yaml      — delegation graph
 * ```
 *
 * @param projectRoot - Absolute path to the project root.
 * @param manifest    - The team manifest to write.
 * @param agents      - Map of agent name to customized template.
 * @param scanResult  - The full scan result to persist.
 */
export async function writeTeam(
  projectRoot: string,
  manifest: TeamManifest,
  agents: Map<string, AgentTemplate>,
  scanResult: FullScanResult,
): Promise<void> {
  const baseDir = join(projectRoot, ".agentforge");
  const analysisDir = join(baseDir, "analysis");
  const agentsDir = join(baseDir, "agents");
  const configDir = join(baseDir, "config");

  // Create directory structure
  await Promise.all([
    ensureDir(analysisDir),
    ensureDir(agentsDir),
    ensureDir(configDir),
  ]);

  // Build derived artifacts
  const modelRouting = buildModelRouting(manifest, agents);
  const delegationGraph = buildDelegationGraph(agents);

  // Update manifest with computed routing and delegation
  const fullManifest: TeamManifest = {
    ...manifest,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
  };

  // Build forge log
  const forgeLog = buildForgeLog(fullManifest, agents, scanResult);

  // Write all files in parallel
  await Promise.all([
    // team.yaml
    writeFile(
      join(baseDir, "team.yaml"),
      yaml.dump(fullManifest, { lineWidth: 120, noRefs: true }),
      "utf-8",
    ),

    // forge.log
    writeFile(join(baseDir, "forge.log"), forgeLog, "utf-8"),

    // analysis/project-scan.json
    writeFile(
      join(analysisDir, "project-scan.json"),
      JSON.stringify(scanResult, null, 2),
      "utf-8",
    ),

    // config/models.yaml
    writeFile(
      join(configDir, "models.yaml"),
      yaml.dump(modelRouting, { lineWidth: 120, noRefs: true }),
      "utf-8",
    ),

    // config/delegation.yaml
    writeFile(
      join(configDir, "delegation.yaml"),
      yaml.dump(delegationGraph, { lineWidth: 120, noRefs: true }),
      "utf-8",
    ),

    // agents/*.yaml — one per agent
    ...[...agents.entries()].map(([name, template]) =>
      writeFile(
        join(agentsDir, `${name}.yaml`),
        yaml.dump(template, { lineWidth: 120, noRefs: true }),
        "utf-8",
      ),
    ),
  ]);
}
