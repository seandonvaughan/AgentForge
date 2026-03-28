/**
 * Team Writer — serializes a forged team to the `.agentforge/` directory.
 *
 * Creates the full directory structure including manifests, agent configs,
 * model routing, delegation graph, analysis artifacts, and a forge log.
 *
 * Merge behaviour (P0-4): before writing team.yaml the writer reads any
 * existing manifest and merges it with the newly-scanned one so that
 * manually-added agents, delegation_graph entries, model_routing slots,
 * team_size, version, and other custom metadata are never lost.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { AgentTemplate } from "../types/agent.js";
import type { TeamManifest, ModelRouting, DelegationGraph, TeamAgents, TeamUnit } from "../types/team.js";
import type { FullScanResult } from "../scanner/index.js";

// ---------------------------------------------------------------------------
// Merge helpers (P0-4: preserve manually-added agents on re-forge)
// ---------------------------------------------------------------------------

/**
 * Attempt to read and parse the existing `team.yaml` in `.agentforge/`.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
async function readExistingManifest(baseDir: string): Promise<TeamManifest | null> {
  const teamYamlPath = join(baseDir, "team.yaml");
  try {
    const raw = await readFile(teamYamlPath, "utf-8");
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as TeamManifest;
    }
    return null;
  } catch {
    // File does not exist or is unreadable — treat as no existing manifest
    return null;
  }
}

/**
 * Merge all agent names from every category in `existing` that are not
 * already present in `scanned` into the corresponding category bucket.
 *
 * Rules:
 * - An agent already in `scanned` keeps its scanned category.
 * - An agent only in `existing` is preserved in its existing category.
 * - No agent is ever removed.
 */
function mergeAgents(
  scanned: TeamAgents,
  existing: TeamAgents,
): TeamAgents {
  // Collect the full set of agent names already in the scanned manifest
  const scannedNames = new Set<string>([
    ...scanned.strategic,
    ...scanned.implementation,
    ...scanned.quality,
    ...scanned.utility,
    // include any extra dynamic categories
    ...Object.entries(scanned)
      .filter(([k]) => !["strategic", "implementation", "quality", "utility"].includes(k))
      .flatMap(([, v]) => v),
  ]);

  const merged: TeamAgents = {
    strategic: [...scanned.strategic],
    implementation: [...scanned.implementation],
    quality: [...scanned.quality],
    utility: [...scanned.utility],
  };

  // Copy over any extra dynamic categories from the scanned manifest first
  for (const [cat, agents] of Object.entries(scanned)) {
    if (!["strategic", "implementation", "quality", "utility"].includes(cat)) {
      merged[cat] = [...agents];
    }
  }

  // Now walk every category in the existing manifest
  for (const [cat, agents] of Object.entries(existing)) {
    if (!Array.isArray(agents)) continue;
    for (const agent of agents) {
      if (scannedNames.has(agent)) continue; // already present — skip
      // Ensure the category bucket exists in merged
      if (!merged[cat]) {
        merged[cat] = [];
      }
      merged[cat].push(agent);
      scannedNames.add(agent); // prevent duplicates if the same agent appears in multiple existing categories
    }
  }

  return merged;
}

/**
 * Merge model routing: keep all existing tier assignments for agents that
 * appear in the merged agent list but are not in the scanned routing.
 */
function mergeModelRouting(
  scanned: ModelRouting,
  existing: ModelRouting,
  mergedAgentNames: Set<string>,
): ModelRouting {
  const scannedAgentNames = new Set<string>([
    ...scanned.opus,
    ...scanned.sonnet,
    ...scanned.haiku,
  ]);

  const merged: ModelRouting = {
    opus: [...scanned.opus],
    sonnet: [...scanned.sonnet],
    haiku: [...scanned.haiku],
  };

  for (const tier of ["opus", "sonnet", "haiku"] as const) {
    for (const agent of existing[tier] ?? []) {
      if (!scannedAgentNames.has(agent) && mergedAgentNames.has(agent)) {
        merged[tier].push(agent);
        scannedAgentNames.add(agent);
      }
    }
  }

  return merged;
}

/**
 * Merge delegation graph: keep all existing entries that are not already
 * present in the scanned graph.
 */
function mergeDelegationGraph(
  scanned: DelegationGraph,
  existing: DelegationGraph,
): DelegationGraph {
  const merged: DelegationGraph = { ...scanned };

  for (const [agent, delegates] of Object.entries(existing)) {
    if (!(agent in merged)) {
      merged[agent] = [...delegates];
    }
  }

  return merged;
}

/**
 * Merge a newly-scanned {@link TeamManifest} with an existing one so that
 * manually-added agents and metadata are never lost.
 *
 * Merge rules:
 * 1. All agents already in `existing` that are NOT in `scanned` are
 *    preserved in their original category.
 * 2. Newly discovered agents from `scanned` are added.
 * 3. `model_routing` follows the same additive rule.
 * 4. `delegation_graph` entries not in `scanned` are preserved from
 *    `existing`.
 * 5. `team_size`, `version`, and any extra top-level metadata fields from
 *    `existing` that are absent from `scanned` are carried forward.
 * 6. `forged_at` and `project_hash` are always taken from `scanned`
 *    (they reflect the latest run).
 */
export function mergeManifests(
  scanned: TeamManifest,
  existing: TeamManifest,
): TeamManifest {
  const mergedAgents = mergeAgents(scanned.agents, existing.agents);

  // Build the full set of merged agent names for routing validation
  const mergedAgentNames = new Set<string>(
    Object.values(mergedAgents).flatMap((v) => (Array.isArray(v) ? v : [])),
  );

  const mergedRouting = mergeModelRouting(
    scanned.model_routing,
    existing.model_routing,
    mergedAgentNames,
  );

  const mergedDelegation = mergeDelegationGraph(
    scanned.delegation_graph,
    existing.delegation_graph,
  );

  // Carry forward top-level metadata from both manifests that is outside the
  // set of core managed keys (e.g. team_size, version).
  // Priority: scanned fields win over existing fields when both define the same key.
  const coreKeys = new Set([
    "name", "forged_at", "forged_by", "project_hash",
    "agents", "model_routing", "delegation_graph",
    "project_brief", "domains", "collaboration",
  ]);

  const extraMeta: Record<string, unknown> = {};

  // First, pull extra fields from existing (lower priority)
  for (const [key, value] of Object.entries(existing as unknown as Record<string, unknown>)) {
    if (!coreKeys.has(key)) {
      extraMeta[key] = value;
    }
  }

  // Then, override / add extra fields from scanned (higher priority)
  for (const [key, value] of Object.entries(scanned as unknown as Record<string, unknown>)) {
    if (!coreKeys.has(key)) {
      extraMeta[key] = value;
    }
  }

  return {
    ...extraMeta,
    name: scanned.name,
    forged_at: scanned.forged_at,
    forged_by: scanned.forged_by,
    project_hash: scanned.project_hash,
    agents: mergedAgents,
    model_routing: mergedRouting,
    delegation_graph: mergedDelegation,
    ...(scanned.project_brief !== undefined ? { project_brief: scanned.project_brief } : {}),
    ...(scanned.domains !== undefined ? { domains: scanned.domains } : existing.domains !== undefined ? { domains: existing.domains } : {}),
    ...(scanned.collaboration !== undefined ? { collaboration: scanned.collaboration } : {}),
  } as TeamManifest;
}

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

  // Build derived artifacts from the scanned agents
  const modelRouting = buildModelRouting(manifest, agents);
  const delegationGraph = buildDelegationGraph(agents);

  // Update manifest with computed routing and delegation
  const scannedManifest: TeamManifest = {
    ...manifest,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
  };

  // P0-4: Merge with any existing team.yaml so manually-added agents are
  // never lost.  If no existing file is found, proceed with the scanned
  // manifest unchanged.
  const existingManifest = await readExistingManifest(baseDir);
  const fullManifest: TeamManifest = existingManifest
    ? mergeManifests(scannedManifest, existingManifest)
    : scannedManifest;

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

    // config/teams.yaml — team units organized by layer (v6.1+)
    ...(fullManifest.team_units && fullManifest.team_units.length > 0
      ? [
          writeFile(
            join(configDir, "teams.yaml"),
            yaml.dump(fullManifest.team_units, { lineWidth: 120, noRefs: true }),
            "utf-8",
          ),
        ]
      : []),

    // config/topology.yaml — written only when collaboration data is present
    ...(fullManifest.collaboration
      ? [
          writeFile(
            join(configDir, "topology.yaml"),
            yaml.dump(fullManifest.collaboration, { lineWidth: 120, noRefs: true }),
            "utf-8",
          ),
        ]
      : []),

    // agents/*.yaml — one per agent, preserving existing reports_to overrides
    ...[...agents.entries()].map(([name, template]) => {
      const existingPath = join(agentsDir, `${name}.yaml`);
      return readFile(existingPath, "utf-8")
        .then((raw) => {
          const existing = yaml.load(raw) as { collaboration?: { reports_to?: string } } | null;
          const existingReportsTo = existing?.collaboration?.reports_to;
          const merged = existingReportsTo && existingReportsTo !== template.collaboration.reports_to
            ? { ...template, collaboration: { ...template.collaboration, reports_to: existingReportsTo } }
            : template;
          return writeFile(existingPath, yaml.dump(merged, { lineWidth: 120, noRefs: true }), "utf-8");
        })
        .catch(() => writeFile(existingPath, yaml.dump(template, { lineWidth: 120, noRefs: true }), "utf-8"));
    }),
  ]);
}
