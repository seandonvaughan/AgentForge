/**
 * Learning Curator — reads the JSONL memory store, scores entries per agent,
 * and proposes which lessons each agent should learn.
 *
 * Reads three memory types in parallel, scores (entry × agent) pairs, keeps
 * only score ≥ 0.3, extracts a 1-sentence lesson, groups by agent, caps at
 * top 30 per agent, and persists the full result to
 * `.agentforge/forge/learnings-proposed.json`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import { readMemoryEntries } from "./memory-reader.js";
import type { MemoryEntry } from "./memory-reader.js";
import { scoreEntry, parseSeverity } from "./scorer.js";
import type { CurationInput, CurationResult, ProposedLearning } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_TYPES = ["gate-verdict", "review-finding", "cycle-outcome"] as const;
const MIN_SCORE = 0.3;
const CAP_PER_AGENT = 30;
const DEFAULT_MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Agent YAML helpers
// ---------------------------------------------------------------------------

interface AgentYaml {
  capability_tags?: string[];
  skills?: string[] | Array<{ name: string }>;
  [key: string]: unknown;
}

/**
 * Load an agent's YAML from `.agentforge/agents/<agentId>.yaml` and extract
 * its capability tags. Falls back to the `skills` array when
 * `capability_tags` is absent.
 */
async function loadAgentTags(
  projectRoot: string,
  agentId: string,
): Promise<string[]> {
  const yamlPath = join(projectRoot, ".agentforge", "agents", `${agentId}.yaml`);
  let raw: string;
  try {
    raw = await readFile(yamlPath, "utf8");
  } catch {
    // No YAML on disk — return empty tag set (agent still participates, just
    // without role-match boost).
    return [];
  }

  let doc: AgentYaml;
  try {
    doc = yaml.load(raw) as AgentYaml;
  } catch {
    console.warn(`[curator] Could not parse YAML for agent ${agentId}`);
    return [];
  }

  if (doc.capability_tags && Array.isArray(doc.capability_tags)) {
    return doc.capability_tags.filter((t) => typeof t === "string");
  }

  if (doc.skills && Array.isArray(doc.skills)) {
    return doc.skills
      .map((s) => (typeof s === "string" ? s : (s as { name: string }).name ?? ""))
      .filter(Boolean);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Lesson extraction
// ---------------------------------------------------------------------------

/**
 * Extract a single imperative-voice sentence from a raw memory entry value.
 *
 * Resolution order:
 *   1. JSON parse → look for `lesson`, `recommendation`, `summary`,
 *      `description`, `message` fields.
 *   2. First sentence of the stringified value (up to 200 chars).
 */
export function extractLesson(value: string): string {
  // Attempt JSON parse
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["lesson", "recommendation", "summary", "description", "message"]) {
        const candidate = obj[key];
        if (typeof candidate === "string" && candidate.trim()) {
          return firstSentence(candidate);
        }
      }
    }
  } catch {
    // not JSON
  }

  // Fallback: first sentence of the raw string
  return firstSentence(value);
}

function firstSentence(text: string): string {
  // Strip markdown bold / italic markers and excess whitespace
  const clean = text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Truncate at the first sentence boundary (. ! ?) or 200 chars
  const match = clean.match(/^[^.!?]{1,200}[.!?]/);
  if (match) return match[0].trim();
  return clean.slice(0, 200).trim();
}

// ---------------------------------------------------------------------------
// Rationale derivation
// ---------------------------------------------------------------------------

function deriveRationale(
  entry: MemoryEntry,
  agentTags: string[],
): Exclude<ProposedLearning["rationale"], "cross-agent"> {
  const entryTagsLower = (entry.tags ?? []).map((t) => t.toLowerCase());
  const agentTagsLower = agentTags.map((t) => t.toLowerCase());

  // Role-tag: direct overlap between agent tags and entry tags
  if (agentTagsLower.some((t) => entryTagsLower.includes(t))) {
    return "role-tag";
  }

  // Subsystem: entry tags mention a known subsystem keyword
  const subsystemKeywords = [
    "api", "db", "schema", "ci", "cli", "dashboard", "memory",
    "runtime", "security", "test", "auth", "sse", "runner",
  ];
  if (
    entryTagsLower.some((t) => subsystemKeywords.some((k) => t.includes(k)))
  ) {
    return "subsystem";
  }

  return "recurring-pattern";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full curation pipeline.
 *
 * For each agent in `opts.agentIds`:
 *   1. Load agent YAML to extract capability tags.
 *   2. Score every memory entry; keep score ≥ MIN_SCORE.
 *   3. Extract a 1-sentence lesson.
 *   4. Sort by score descending, cap at CAP_PER_AGENT.
 *
 * Persists the result to `.agentforge/forge/learnings-proposed.json` and
 * returns the full {@link CurationResult}.
 */
export async function curateLearnings(opts: CurationInput): Promise<CurationResult> {
  const { projectRoot, agentIds, maxEntriesPerSource = DEFAULT_MAX_ENTRIES } = opts;

  // 1. Read all three memory types in parallel
  const [gateEntries, reviewEntries, cycleEntries] = await Promise.all([
    readMemoryEntries(projectRoot, "gate-verdict"),
    readMemoryEntries(projectRoot, "review-finding"),
    readMemoryEntries(projectRoot, "cycle-outcome"),
  ]);

  const allMemory: Record<string, MemoryEntry[]> = {
    "gate-verdict": gateEntries.slice(0, maxEntriesPerSource),
    "review-finding": reviewEntries.slice(0, maxEntriesPerSource),
    "cycle-outcome": cycleEntries.slice(0, maxEntriesPerSource),
  };

  // Build sourcesScanned metadata
  const sourcesScanned: CurationResult["sourcesScanned"] = MEMORY_TYPES.map((type) => {
    const filePath = join(projectRoot, ".agentforge", "memory", `${type}.jsonl`);
    const entries = allMemory[type] ?? [];
    // entriesRead reflects the pre-cap count (we already sliced)
    return { path: filePath, entriesRead: entries.length, scored: 0 };
  });

  // Flatten all entries
  const allEntries: MemoryEntry[] = [
    ...allMemory["gate-verdict"]!,
    ...allMemory["review-finding"]!,
    ...allMemory["cycle-outcome"]!,
  ];

  // 2. Load agent tags in parallel
  const agentTagMap = new Map<string, string[]>();
  await Promise.all(
    agentIds.map(async (agentId) => {
      const tags = await loadAgentTags(projectRoot, agentId);
      agentTagMap.set(agentId, tags);
    }),
  );

  // 3. Score (entry × agent) and collect proposals
  const byAgent: Record<string, ProposedLearning[]> = {};
  const scoredCountByType: Record<string, number> = {
    "gate-verdict": 0,
    "review-finding": 0,
    "cycle-outcome": 0,
  };

  for (const agentId of agentIds) {
    const agentTags = agentTagMap.get(agentId) ?? [];
    const proposals: ProposedLearning[] = [];

    for (const entry of allEntries) {
      const { score, severity, roleMatched } = scoreEntry(entry, agentId, agentTags);
      if (score < MIN_SCORE) continue;

      const lesson = extractLesson(entry.value);
      if (!lesson) continue;

      const rationale = roleMatched
        ? "role-tag"
        : deriveRationale(entry, agentTags);

      proposals.push({
        agentId,
        lesson,
        score,
        sourceId: entry.id,
        severity: severity ?? parseSeverity(entry),
        rationale,
        sourceCreatedAt: entry.createdAt ?? new Date(0).toISOString(),
      });

      scoredCountByType[entry.type] = (scoredCountByType[entry.type] ?? 0) + 1;
    }

    // Sort by score descending; cap at CAP_PER_AGENT
    proposals.sort((a, b) => b.score - a.score);
    byAgent[agentId] = proposals.slice(0, CAP_PER_AGENT);
  }

  // Update scored counts in sourcesScanned
  for (const src of sourcesScanned) {
    const typeKey = MEMORY_TYPES.find((t) =>
      src.path.endsWith(`${t}.jsonl`),
    );
    if (typeKey) {
      src.scored = scoredCountByType[typeKey] ?? 0;
    }
  }

  const result: CurationResult = {
    byAgent,
    sourcesScanned,
    generatedAt: new Date().toISOString(),
  };

  // 4. Persist to .agentforge/forge/learnings-proposed.json
  const forgeDir = join(projectRoot, ".agentforge", "forge");
  await mkdir(forgeDir, { recursive: true });
  await writeFile(
    join(forgeDir, "learnings-proposed.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );

  return result;
}
