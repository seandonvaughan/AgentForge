/**
 * Reforge engine for AgentForge.
 *
 * Compares a previous project scan against a fresh scan to detect
 * meaningful changes, then produces a TeamDiff describing how the
 * agent team should be updated.
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { DomainId } from "../types/domain.js";

import { runFullScan } from "../scanner/index.js";
import type { FullScanResult } from "../scanner/index.js";
import { forgeTeam } from "../builder/index.js";
import type { TeamManifest } from "../types/team.js";
import type { ModelTier } from "../types/agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Description of a single agent whose configuration changed. */
export interface AgentModification {
  name: string;
  changes: string[];
}

/** A model tier change for a specific agent. */
export interface ModelChange {
  agent: string;
  from: ModelTier;
  to: ModelTier;
}

/** Skill-level changes for a specific agent. */
export interface SkillUpdate {
  agent: string;
  added: string[];
  removed: string[];
}

/** The full diff between the previous and proposed team compositions. */
export interface TeamDiff {
  agents_added: string[];
  agents_removed: string[];
  agents_modified: AgentModification[];
  model_changes: ModelChange[];
  skill_updates: SkillUpdate[];
  summary: string;
}

/** Options for applying a diff with optional canary safety checks. */
export interface ApplyDiffOptions {
  /**
   * Enable canary protection for the write path.
   *
   * When enabled, the current `.agentforge/` state is backed up before the
   * forge reruns. If the canary validation fails, the previous state is
   * restored automatically.
   */
  canary?: boolean;
  /**
   * Traffic split recorded in the canary metadata. This does not affect file
   * routing directly, but it documents how aggressively the rollout was staged.
   */
  trafficPercent?: number;
  /**
   * Rollback threshold recorded in the canary metadata.
   *
   * Defaults to 0.05 to match the existing canary subsystem.
   */
  rollbackThreshold?: number;
  /**
   * Optional validator for the newly forged manifest.
   *
   * Returning `false` triggers an automatic rollback to the backed-up state.
   */
  validate?: (manifest: TeamManifest) => boolean | Promise<boolean>;
  /**
   * Optional forge implementation override used for tests and alternate
   * rollout strategies.
   */
  forgeTeam?: (projectRoot: string) => Promise<TeamManifest>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten all agent names from a TeamManifest into a single sorted array. */
function allAgentNames(manifest: TeamManifest): string[] {
  const { strategic, implementation, quality, utility } = manifest.agents;
  return [...strategic, ...implementation, ...quality, ...utility].sort();
}

/** Determine the model tier for an agent within a manifest. */
function agentModel(manifest: TeamManifest, agentName: string): ModelTier | undefined {
  if (manifest.model_routing.opus.includes(agentName)) return "opus";
  if (manifest.model_routing.sonnet.includes(agentName)) return "sonnet";
  if (manifest.model_routing.haiku.includes(agentName)) return "haiku";
  return undefined;
}

/** Determine the category of an agent within a manifest. */
function agentCategory(manifest: TeamManifest, agentName: string): string | undefined {
  if (manifest.agents.strategic.includes(agentName)) return "strategic";
  if (manifest.agents.implementation.includes(agentName)) return "implementation";
  if (manifest.agents.quality.includes(agentName)) return "quality";
  if (manifest.agents.utility.includes(agentName)) return "utility";
  return undefined;
}

/**
 * Detect whether changes between two scans are significant enough
 * to warrant a reforge.
 */
function changesAreSignificant(
  oldScan: FullScanResult,
  newScan: FullScanResult,
): { significant: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Check for new frameworks
  const oldFrameworks = new Set(oldScan.files.frameworks_detected);
  const newFrameworks = newScan.files.frameworks_detected.filter(
    (f) => !oldFrameworks.has(f),
  );
  if (newFrameworks.length > 0) {
    reasons.push(`New frameworks detected: ${newFrameworks.join(", ")}`);
  }

  // Check for removed frameworks
  const newFrameworkSet = new Set(newScan.files.frameworks_detected);
  const removedFrameworks = oldScan.files.frameworks_detected.filter(
    (f) => !newFrameworkSet.has(f),
  );
  if (removedFrameworks.length > 0) {
    reasons.push(`Frameworks removed: ${removedFrameworks.join(", ")}`);
  }

  // Check file count change (> 5% threshold)
  const oldFileCount = oldScan.files.total_files || 1;
  const fileChangePercent =
    Math.abs(newScan.files.total_files - oldFileCount) / oldFileCount;
  if (fileChangePercent > 0.05) {
    const direction = newScan.files.total_files > oldFileCount ? "increased" : "decreased";
    reasons.push(
      `File count ${direction} by ${(fileChangePercent * 100).toFixed(1)}% (${oldFileCount} -> ${newScan.files.total_files})`,
    );
  }

  // Check for new languages
  const oldLangs = new Set(Object.keys(oldScan.files.languages));
  const newLangs = Object.keys(newScan.files.languages).filter(
    (l) => !oldLangs.has(l),
  );
  if (newLangs.length > 0) {
    reasons.push(`New languages detected: ${newLangs.join(", ")}`);
  }

  // Check CI provider changes
  if (oldScan.ci.ci_provider !== newScan.ci.ci_provider) {
    reasons.push(
      `CI provider changed: ${oldScan.ci.ci_provider} -> ${newScan.ci.ci_provider}`,
    );
  }

  // Check for new/removed CI config files
  const oldCIFiles = new Set(oldScan.ci.config_files);
  const newCIFiles = newScan.ci.config_files.filter((f) => !oldCIFiles.has(f));
  if (newCIFiles.length > 0) {
    reasons.push(`New CI config files: ${newCIFiles.join(", ")}`);
  }

  // Check dependency count changes
  const depDelta = Math.abs(
    newScan.dependencies.total_production - oldScan.dependencies.total_production,
  );
  if (depDelta > 5) {
    reasons.push(
      `Production dependency count changed: ${oldScan.dependencies.total_production} -> ${newScan.dependencies.total_production}`,
    );
  }

  return {
    significant: reasons.length > 0,
    reasons,
  };
}

/**
 * Diff two team manifests to produce a TeamDiff.
 */
function diffManifests(
  oldManifest: TeamManifest,
  newManifest: TeamManifest,
  changeReasons: string[],
): TeamDiff {
  const oldAgents = new Set(allAgentNames(oldManifest));
  const newAgents = new Set(allAgentNames(newManifest));

  const added = [...newAgents].filter((a) => !oldAgents.has(a));
  const removed = [...oldAgents].filter((a) => !newAgents.has(a));

  // Detect model changes for agents that exist in both
  const modelChanges: ModelChange[] = [];
  const agentsModified: AgentModification[] = [];

  for (const agent of newAgents) {
    if (!oldAgents.has(agent)) continue;

    const oldModel = agentModel(oldManifest, agent);
    const newModel = agentModel(newManifest, agent);
    if (oldModel && newModel && oldModel !== newModel) {
      modelChanges.push({ agent, from: oldModel, to: newModel });
    }

    const oldCat = agentCategory(oldManifest, agent);
    const newCat = agentCategory(newManifest, agent);
    const changes: string[] = [];
    if (oldCat !== newCat) {
      changes.push(`Category changed: ${oldCat} -> ${newCat}`);
    }

    const oldDelegates = (oldManifest.delegation_graph[agent] ?? []).sort();
    const newDelegates = (newManifest.delegation_graph[agent] ?? []).sort();
    if (JSON.stringify(oldDelegates) !== JSON.stringify(newDelegates)) {
      changes.push("Delegation targets updated");
    }

    if (changes.length > 0) {
      agentsModified.push({ name: agent, changes });
    }
  }

  // Build summary
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} agent(s) added`);
  if (removed.length > 0) parts.push(`${removed.length} agent(s) removed`);
  if (modelChanges.length > 0) parts.push(`${modelChanges.length} model change(s)`);
  if (agentsModified.length > 0) parts.push(`${agentsModified.length} agent(s) modified`);

  const summary =
    parts.length > 0
      ? `Reforge: ${parts.join(", ")}. Triggers: ${changeReasons.join("; ")}`
      : "No significant changes";

  return {
    agents_added: added,
    agents_removed: removed,
    agents_modified: agentsModified,
    model_changes: modelChanges,
    skill_updates: [], // Skill-level diffing requires reading individual agent configs
    summary,
  };
}

interface ForgeSnapshotEntry {
  path: string;
  existed: boolean;
  content?: string;
}

interface CanaryRolloutRecord {
  enabled: boolean;
  trafficPercent: number;
  rollbackThreshold: number;
  status: "staged" | "promoted" | "rolled_back";
  reason?: string;
  createdAt: string;
  completedAt?: string;
}

function normalizeCanaryPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function normalizeCanaryThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0.05;
  }
  return Math.min(1, value);
}

function shouldUseCanary(options?: ApplyDiffOptions): boolean {
  if (options?.canary !== undefined) {
    return options.canary;
  }

  return process.env["AGENTFORGE_REFORGE_CANARY"] === "1";
}

function isManifestValid(manifest: TeamManifest): boolean {
  const allAgents = new Set<string>();
  for (const bucket of Object.values(manifest.agents)) {
    if (!Array.isArray(bucket)) {
      return false;
    }
    for (const agent of bucket) {
      allAgents.add(agent);
    }
  }

  const routedAgents = [
    ...manifest.model_routing.opus,
    ...manifest.model_routing.sonnet,
    ...manifest.model_routing.haiku,
  ];
  if (routedAgents.length === 0) {
    return false;
  }

  for (const agent of routedAgents) {
    if (!allAgents.has(agent)) {
      return false;
    }
  }

  return (
    typeof manifest.name === "string" &&
    manifest.name.length > 0 &&
    typeof manifest.forged_at === "string" &&
    manifest.forged_at.length > 0 &&
    typeof manifest.project_hash === "string" &&
    manifest.project_hash.length > 0
  );
}

async function readSnapshotFile(path: string): Promise<ForgeSnapshotEntry> {
  try {
    const content = await readFile(path, "utf-8");
    return { path, existed: true, content };
  } catch {
    return { path, existed: false };
  }
}

async function readSnapshotDirectory(
  dirPath: string,
  prefix: string,
): Promise<ForgeSnapshotEntry[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const snapshots: ForgeSnapshotEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) {
        snapshots.push(...await readSnapshotDirectory(entryPath, relativePath));
        continue;
      }
      snapshots.push(await readSnapshotFile(entryPath));
    }

    return snapshots;
  } catch {
    return [];
  }
}

async function captureForgeSnapshot(projectRoot: string): Promise<ForgeSnapshotEntry[]> {
  const agentforgeDir = join(projectRoot, ".agentforge");
  const snapshots: ForgeSnapshotEntry[] = [];

  const topLevelFiles = [
    join(agentforgeDir, "team.yaml"),
    join(agentforgeDir, "forge.log"),
  ];
  for (const filePath of topLevelFiles) {
    snapshots.push(await readSnapshotFile(filePath));
  }

  snapshots.push(
    ...(await readSnapshotDirectory(join(agentforgeDir, "analysis"), join(agentforgeDir, "analysis"))),
  );
  snapshots.push(
    ...(await readSnapshotDirectory(join(agentforgeDir, "config"), join(agentforgeDir, "config"))),
  );
  snapshots.push(
    ...(await readSnapshotDirectory(join(agentforgeDir, "agents"), join(agentforgeDir, "agents"))),
  );

  return snapshots;
}

async function collectManagedForgeFiles(projectRoot: string): Promise<string[]> {
  const agentforgeDir = join(projectRoot, ".agentforge");
  const files: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      files.push(entryPath);
    }
  }

  for (const filePath of [
    join(agentforgeDir, "team.yaml"),
    join(agentforgeDir, "forge.log"),
  ]) {
    files.push(filePath);
  }

  await walk(join(agentforgeDir, "analysis"));
  await walk(join(agentforgeDir, "config"));
  await walk(join(agentforgeDir, "agents"));

  return files;
}

async function restoreForgeSnapshot(snapshot: ForgeSnapshotEntry[]): Promise<void> {
  const preservedPaths = new Set(
    snapshot.filter((entry) => entry.existed).map((entry) => entry.path),
  );
  const firstSnapshot = snapshot[0];

  const currentFiles = await collectManagedForgeFiles(
    firstSnapshot ? dirname(dirname(firstSnapshot.path)) : process.cwd(),
  ).catch(() => []);

  await Promise.all(
    currentFiles
      .filter((filePath) => !preservedPaths.has(filePath))
      .map((filePath) => rm(filePath, { force: true })),
  );

  await Promise.all(
    snapshot.map(async (entry) => {
      if (!entry.existed) {
        await rm(entry.path, { force: true });
        return;
      }
      if (entry.content === undefined) {
        return;
      }
      await mkdir(dirname(entry.path), { recursive: true }).catch(() => undefined);
      await writeFile(entry.path, entry.content, "utf-8");
    }),
  );
}

async function writeCanaryRolloutRecord(
  projectRoot: string,
  record: CanaryRolloutRecord,
): Promise<void> {
  const forgeDir = join(projectRoot, ".agentforge", "forge");
  await mkdir(forgeDir, { recursive: true });
  await writeFile(
    join(forgeDir, "canary-rollout.json"),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate a v1 `.agentforge/team.yaml` to v2 format in-place.
 *
 * Adds the following optional v2 fields with sensible defaults when
 * they are absent from the existing manifest:
 *  - `domains`: defaults to `['software']`
 *  - `collaboration`: defaults to `{}`
 *  - `project_brief`: defaults to `{}`
 *
 * Safe to call on a manifest that is already at v2 — missing fields
 * are added; existing fields are never overwritten.
 */
export async function migrateV1ToV2(projectRoot: string): Promise<void> {
  const teamPath = join(projectRoot, ".agentforge", "team.yaml");

  let raw: string;
  try {
    raw = await readFile(teamPath, "utf-8");
  } catch {
    throw new Error("No team.yaml found. Run 'agentforge forge' first.");
  }

  const manifest = yaml.load(raw) as Record<string, unknown>;

  let modified = false;

  if (!manifest.domains) {
    manifest.domains = ["software"] as DomainId[];
    modified = true;
  }

  if (!manifest.collaboration) {
    manifest.collaboration = {};
    modified = true;
  }

  if (!manifest.project_brief) {
    manifest.project_brief = {};
    modified = true;
  }

  if (modified) {
    await writeFile(teamPath, yaml.dump(manifest), "utf-8");
  }
}

/**
 * Analyze the project for changes since the last forge and produce
 * a TeamDiff describing how the team should be updated.
 *
 * Does NOT apply the diff — call {@link applyDiff} to do that.
 */
export async function reforgeTeam(projectRoot: string): Promise<TeamDiff> {
  const agentforgeDir = join(projectRoot, ".agentforge");
  const scanPath = join(agentforgeDir, "analysis", "project-scan.json");
  const teamPath = join(agentforgeDir, "team.yaml");

  // 1. Read existing scan
  let oldScan: FullScanResult;
  try {
    const raw = await readFile(scanPath, "utf-8");
    oldScan = JSON.parse(raw) as FullScanResult;
  } catch {
    throw new Error(
      "No existing project scan found. Run 'agentforge forge' first.",
    );
  }

  // 2. Read existing team manifest
  let oldManifest: TeamManifest;
  try {
    const raw = await readFile(teamPath, "utf-8");
    oldManifest = yaml.load(raw) as TeamManifest;
  } catch {
    throw new Error(
      "No existing team manifest found. Run 'agentforge forge' first.",
    );
  }

  // 2b. Auto-migrate v1 manifests that are missing v2 fields
  if (!oldManifest.domains || !oldManifest.collaboration || !oldManifest.project_brief) {
    await migrateV1ToV2(projectRoot);
    // Re-read the updated manifest
    const raw = await readFile(teamPath, "utf-8");
    oldManifest = yaml.load(raw) as TeamManifest;
  }

  // 3. Run a fresh scan
  const newScan = await runFullScan(projectRoot);

  // 4. Check significance
  const { significant, reasons } = changesAreSignificant(oldScan, newScan);

  if (!significant) {
    return {
      agents_added: [],
      agents_removed: [],
      agents_modified: [],
      model_changes: [],
      skill_updates: [],
      summary: "No significant changes detected since last forge.",
    };
  }

  // 5. Re-run team composition to get proposed manifest
  const newManifest = await forgeTeam(projectRoot);

  // 6. Diff the manifests
  return diffManifests(oldManifest, newManifest, reasons);
}

/**
 * Apply a TeamDiff by re-running the forge pipeline, writing updated
 * manifests and agent configs to disk.
 */
export async function applyDiff(
  projectRoot: string,
  diff: TeamDiff,
  options: ApplyDiffOptions = {},
): Promise<void> {
  if (
    diff.agents_added.length === 0 &&
    diff.agents_removed.length === 0 &&
    diff.agents_modified.length === 0 &&
    diff.model_changes.length === 0
  ) {
    console.log("No changes to apply.");
    return;
  }

  const canaryEnabled = shouldUseCanary(options);
  const forge = options.forgeTeam ?? forgeTeam;
  if (!canaryEnabled) {
    await forge(projectRoot);
    console.log("Team updated successfully.");
    return;
  }

  const snapshot = await captureForgeSnapshot(projectRoot);
  const rolloutRecord: CanaryRolloutRecord = {
    enabled: true,
    trafficPercent: normalizeCanaryPercent(options.trafficPercent ?? 10),
    rollbackThreshold: normalizeCanaryThreshold(options.rollbackThreshold ?? 0.05),
    status: "staged",
    createdAt: new Date().toISOString(),
  };

  await writeCanaryRolloutRecord(projectRoot, rolloutRecord);

  try {
    const manifest = await forge(projectRoot);
    const isValid = options.validate ? await options.validate(manifest) : isManifestValid(manifest);

    if (!isValid) {
      throw new Error("Canary validation failed for the newly forged team.");
    }

    rolloutRecord.status = "promoted";
    rolloutRecord.completedAt = new Date().toISOString();
    await writeCanaryRolloutRecord(projectRoot, rolloutRecord);
    console.log("Team updated successfully via canary rollout.");
  } catch (error) {
    await restoreForgeSnapshot(snapshot);
    rolloutRecord.status = "rolled_back";
    rolloutRecord.reason = error instanceof Error ? error.message : String(error);
    rolloutRecord.completedAt = new Date().toISOString();
    await writeCanaryRolloutRecord(projectRoot, rolloutRecord);
    throw error;
  }
}

/**
 * Append a reforge event to the forge log.
 */
export async function logReforge(
  projectRoot: string,
  diff: TeamDiff,
): Promise<void> {
  const agentforgeDir = join(projectRoot, ".agentforge");
  await mkdir(agentforgeDir, { recursive: true });

  const logPath = join(agentforgeDir, "forge.log");
  const timestamp = new Date().toISOString();

  const lines = [
    `[${timestamp}] Reforge: ${diff.summary}`,
  ];
  if (diff.agents_added.length > 0) {
    lines.push(`  Added: ${diff.agents_added.join(", ")}`);
  }
  if (diff.agents_removed.length > 0) {
    lines.push(`  Removed: ${diff.agents_removed.join(", ")}`);
  }
  if (diff.model_changes.length > 0) {
    for (const mc of diff.model_changes) {
      lines.push(`  Model change: ${mc.agent} ${mc.from} -> ${mc.to}`);
    }
  }
  const entry = lines.join("\n") + "\n";

  try {
    const existing = await readFile(logPath, "utf-8");
    await writeFile(logPath, existing + entry, "utf-8");
  } catch {
    await writeFile(logPath, entry, "utf-8");
  }
}
