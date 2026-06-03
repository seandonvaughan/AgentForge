/**
 * Scorer — computes a 0..1 relevance score for a memory entry relative to
 * a specific agent.
 *
 * Formula:
 *   score = clamp( recency(entry) × severity(entry) × roleBoost(entry, agent), 0, 1 )
 *
 * Components:
 *   - Recency:   exponential decay over days since `createdAt` (half-life 30 days)
 *   - Severity:  CRITICAL=1.0, MAJOR=0.7, MINOR=0.3, INFO=0.1
 *   - Role match: if any agentTag appears in entry.tags or lesson text → ×1.3
 */

import type { MemoryEntry } from "./memory-reader.js";
import type { ProposedLearning } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENCY_HALF_LIFE_DAYS = 30;

const SEVERITY_WEIGHTS: Record<ProposedLearning["severity"], number> = {
  CRITICAL: 1.0,
  MAJOR: 0.7,
  MINOR: 0.3,
  INFO: 0.1,
};

const ROLE_MATCH_MULTIPLIER = 1.3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exponential decay score based on entry age.
 * Returns 1.0 for brand-new entries and approaches 0 asymptotically.
 */
export function recencyScore(createdAt: string, halfLifeDays = RECENCY_HALF_LIFE_DAYS): number {
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return 1.0; // unknown date → treat as recent
  const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Parse the severity tier from an entry.
 *
 * Resolution order:
 *   1. `tags` array: looks for "critical", "major", "minor", "info"
 *   2. `value` field: looks for [CRITICAL], [MAJOR], [MINOR], [INFO] markers
 *   3. Attempts to JSON-parse `value` and inspect a `severity` key
 *   4. Falls back to INFO
 */
export function parseSeverity(entry: MemoryEntry): ProposedLearning["severity"] {
  if (entry.metadata !== null && typeof entry.metadata === "object") {
    const severity = (entry.metadata as Record<string, unknown>).severity;
    if (typeof severity === "string") {
      const upper = severity.toUpperCase() as ProposedLearning["severity"];
      if (upper in SEVERITY_WEIGHTS) return upper;
    }
  }

  // 1. Tags
  const tags = entry.tags ?? [];
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t === "critical") return "CRITICAL";
    if (t === "major") return "MAJOR";
    if (t === "minor") return "MINOR";
    if (t === "info") return "INFO";
  }

  // 2. Bracket markers in value
  if (/\[CRITICAL\]/i.test(entry.value)) return "CRITICAL";
  if (/\[MAJOR\]/i.test(entry.value)) return "MAJOR";
  if (/\[MINOR\]/i.test(entry.value)) return "MINOR";
  if (/\[INFO\]/i.test(entry.value)) return "INFO";

  // 3. JSON severity field
  try {
    const parsed = JSON.parse(entry.value) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const sev = (parsed as Record<string, unknown>).severity;
      if (typeof sev === "string") {
        const upper = sev.toUpperCase() as ProposedLearning["severity"];
        if (upper in SEVERITY_WEIGHTS) return upper;
      }
    }
  } catch {
    // not JSON — fall through
  }

  return "INFO";
}

/**
 * Check whether any of the agent's capability tags appear in the entry's
 * tags array or in the value text. Returns true when there is a match.
 */
export function hasRoleMatch(entry: MemoryEntry, agentTags: string[]): boolean {
  if (agentTags.length === 0) return false;

  const entryTagsLower = (entry.tags ?? []).map((t) => t.toLowerCase());
  const valueLower = entry.value.toLowerCase();

  for (const tag of agentTags) {
    const t = tag.toLowerCase();
    if (entryTagsLower.includes(t)) return true;
    if (valueLower.includes(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScoredEntry {
  score: number;
  severity: ProposedLearning["severity"];
  roleMatched: boolean;
  /** Outcome confidence from Beta(1,1) posterior — injected by curator, not scorer. */
  outcomeConfidence?: number;
  /** Number of cycle×item observations for this lesson. */
  attributedAppearances?: number;
}

/**
 * Score a single memory entry against a specific agent.
 *
 * @param entry      - The memory entry to score.
 * @param agentId    - The agent being evaluated (used for logging only).
 * @param agentTags  - The agent's capability_tags or skills.
 * @returns          - Score in [0, 1], severity, and whether role matched.
 */
export function scoreEntry(
  entry: MemoryEntry,
  _agentId: string,
  agentTags: string[],
): ScoredEntry {
  const recency = recencyScore(entry.createdAt);
  const severity = parseSeverity(entry);
  const sevWeight = SEVERITY_WEIGHTS[severity];
  const roleMatched = hasRoleMatch(entry, agentTags);
  const roleMultiplier = roleMatched ? ROLE_MATCH_MULTIPLIER : 1.0;

  const raw = recency * sevWeight * roleMultiplier;
  const score = Math.min(1, Math.max(0, raw));

  return { score, severity, roleMatched };
}
