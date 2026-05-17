/**
 * Cross-Agent Propagator — T2.5 of the Cycle 2 continuous-improvement loop.
 *
 * When agent A learns "X causes Y", this module injects that lesson into
 * related agents (B, C) whose capability_tags overlap with A's by Jaccard
 * similarity ≥ threshold (default 0.7).  Only CRITICAL and MAJOR lessons
 * are propagated; MINOR and INFO are kept local.
 *
 * The propagated learning is discounted (score × similarity × 0.7) because
 * it is secondhand.  Duplicates are suppressed if the target already has the
 * same lesson at a higher score.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { ProposedLearning } from "./types.js";
import { findRelatedAgents, tagSimilarity } from "./tag-similarity.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PropagationResult {
  /** Original + propagated learnings merged by agent. */
  proposed: Record<string, ProposedLearning[]>;
  propagationStats: {
    /** Number of (source-agent, related-agent) pairs considered. */
    pairsConsidered: number;
    /** New cross-agent ProposedLearnings added. */
    crossAgentLearningsAdded: number;
    /** Learnings not added because target already had them at higher score. */
    duplicatesSuppressed: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shape we expect from a parsed agent YAML (capability_tags or legacy skills). */
interface AgentYamlDoc {
  id?: string;
  name?: string;
  capability_tags?: unknown;
  skills?: unknown;
}

/**
 * Read all *.yaml files from `.agentforge/agents/` and return a minimal
 * roster: `{ id, capability_tags }` per agent.
 *
 * Falls back to `skills` if `capability_tags` is absent (legacy format).
 * Files that fail to parse are skipped with a console.warn.
 */
async function loadAgentRoster(
  projectRoot: string,
): Promise<Array<{ id: string; capability_tags: string[] }>> {
  const agentsDir = join(projectRoot, ".agentforge", "agents");

  let entries: string[];
  try {
    const dirEntries = await readdir(agentsDir);
    entries = dirEntries.filter((f) => f.endsWith(".yaml"));
  } catch {
    // Directory absent — return empty roster; caller still runs (no-op)
    return [];
  }

  const roster: Array<{ id: string; capability_tags: string[] }> = [];

  for (const entry of entries) {
    const filePath = join(agentsDir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      console.warn(`[cross-agent-propagator] Cannot read ${filePath} — skipping`);
      continue;
    }

    let parsed: AgentYamlDoc;
    try {
      const doc = yaml.load(raw);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        console.warn(`[cross-agent-propagator] Unexpected YAML shape in ${filePath} — skipping`);
        continue;
      }
      parsed = doc as AgentYamlDoc;
    } catch (err) {
      console.warn(`[cross-agent-propagator] YAML parse error in ${filePath}: ${String(err)} — skipping`);
      continue;
    }

    // Derive agent id: prefer explicit `id` field, else strip .yaml from filename
    const id = typeof parsed.id === "string" ? parsed.id : entry.replace(/\.yaml$/, "");

    // Prefer capability_tags (Cycle 1 forge field); fall back to legacy skills
    let tags: string[] = [];
    const rawTags = parsed.capability_tags ?? parsed.skills;
    if (Array.isArray(rawTags)) {
      tags = (rawTags as unknown[]).filter((t): t is string => typeof t === "string");
    }

    roster.push({ id, capability_tags: tags });
  }

  return roster;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Propagate high-severity learnings from each source agent to related agents
 * whose capability_tags have Jaccard similarity ≥ threshold.
 *
 * @param opts.projectRoot - Absolute path to the project root.
 * @param opts.proposed    - Existing proposed learnings keyed by agentId.
 * @param opts.threshold   - Minimum tag similarity (default 0.7).
 * @returns PropagationResult with merged proposed map and stats.
 */
export async function propagateLearnings(opts: {
  projectRoot: string;
  proposed: Record<string, ProposedLearning[]>;
  threshold?: number;
}): Promise<PropagationResult> {
  const { projectRoot, proposed, threshold = 0.7 } = opts;

  // Deep-copy the input so we don't mutate the caller's object
  const merged: Record<string, ProposedLearning[]> = {};
  for (const [agentId, learnings] of Object.entries(proposed)) {
    merged[agentId] = [...learnings];
  }

  const roster = await loadAgentRoster(projectRoot);

  let pairsConsidered = 0;
  let crossAgentLearningsAdded = 0;
  let duplicatesSuppressed = 0;

  for (const [sourceAgentId, learnings] of Object.entries(proposed)) {
    // Only propagate CRITICAL and MAJOR lessons
    const highSeverity = learnings.filter(
      (l) => l.severity === "CRITICAL" || l.severity === "MAJOR",
    );
    if (highSeverity.length === 0) continue;

    // Resolve source agent's tags from the roster
    const sourceRosterEntry = roster.find((a) => a.id === sourceAgentId);
    if (!sourceRosterEntry) continue;

    const relatedIds = findRelatedAgents(sourceAgentId, roster, threshold);

    for (const targetAgentId of relatedIds) {
      pairsConsidered++;

      const targetRosterEntry = roster.find((a) => a.id === targetAgentId);
      const similarity = targetRosterEntry
        ? tagSimilarity(sourceRosterEntry.capability_tags, targetRosterEntry.capability_tags)
        : 0;

      for (const original of highSeverity) {
        const discountedScore = original.score * similarity * 0.7;
        const prefixedLesson = `[cross-agent from ${sourceAgentId}] ${original.lesson}`;

        // De-dup: skip if target already has this lesson at a higher or equal score
        const existingForTarget = merged[targetAgentId] ?? [];
        const duplicate = existingForTarget.find(
          (el) => el.lesson === prefixedLesson && el.score >= discountedScore,
        );
        if (duplicate) {
          duplicatesSuppressed++;
          continue;
        }

        const propagated: ProposedLearning = {
          agentId: targetAgentId,
          lesson: prefixedLesson,
          score: discountedScore,
          sourceId: original.sourceId,
          severity: original.severity,
          sourceCreatedAt: original.sourceCreatedAt,
          rationale: "cross-agent",
        };

        if (!merged[targetAgentId]) {
          merged[targetAgentId] = [];
        }
        merged[targetAgentId]!.push(propagated);
        crossAgentLearningsAdded++;
      }
    }
  }

  return {
    proposed: merged,
    propagationStats: {
      pairsConsidered,
      crossAgentLearningsAdded,
      duplicatesSuppressed,
    },
  };
}
