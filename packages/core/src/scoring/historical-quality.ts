// packages/core/src/scoring/historical-quality.ts
//
// Reads .agentforge/memory/step-scores.jsonl and returns top-K agent
// suggestions per (item-kind, capability-tag) ranked by mean utility
// with exponential decay recency bias.
//
// Min-observations gate: 5 per triple → returns empty for that triple.
// Recency bias: exponential decay, half-life 50 records.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface StepScoreRecord {
  agent_id: string;
  model?: string;
  skill_ids?: string[];
  item_kind: string;
  capability_tag: string;
  utility: number;
  recorded_at?: string;
}

export interface AgentSuggestion {
  agent_id: string;
  model: string;
  skill_ids: string[];
  confidence: number;
}

const MIN_OBSERVATIONS = 5;
const DECAY_HALF_LIFE = 50; // records

/**
 * Parse step-scores.jsonl from the given projectRoot.
 * Returns an empty array on any read or parse error.
 */
function loadStepScores(projectRoot: string): StepScoreRecord[] {
  const filePath = join(projectRoot, '.agentforge', 'memory', 'step-scores.jsonl');
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    const records: StepScoreRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as StepScoreRecord;
        if (
          typeof parsed.agent_id === 'string' &&
          typeof parsed.item_kind === 'string' &&
          typeof parsed.capability_tag === 'string' &&
          typeof parsed.utility === 'number'
        ) {
          records.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Compute exponential decay weight for a record at position `index` from
 * the end of the array (0 = most recent).
 *
 * weight(i) = 2^(-i / half_life)
 */
function decayWeight(indexFromEnd: number): number {
  return Math.pow(2, -indexFromEnd / DECAY_HALF_LIFE);
}

/**
 * Returns top-K agent suggestions for the given (itemKind, capabilityTags) pair.
 *
 * - Matches any record whose capability_tag is included in capabilityTags.
 *   Uses String.includes() per the mandatory style guide — not regex.
 * - Applies exponential decay by record position in the file (later = newer).
 * - Requires MIN_OBSERVATIONS (5) observations per (agent_id, item_kind,
 *   capability_tag) triple; triples below this threshold are excluded.
 * - Returns empty array when history is empty or no triple meets the gate.
 */
export function historicalQuality(
  projectRoot: string,
  itemKind: string,
  capabilityTags: string[],
  k = 3,
): AgentSuggestion[] {
  if (process.env['AGENTFORGE_NO_QUALITY_BIAS'] === '1') {
    return [];
  }

  const allRecords = loadStepScores(projectRoot);
  if (allRecords.length === 0) {
    return [];
  }

  // Filter to records matching itemKind + any of the capabilityTags.
  // String.includes() — no regex on user-controlled input.
  const relevant = allRecords.filter((r) => {
    if (r.item_kind !== itemKind) return false;
    return capabilityTags.some((tag) => r.capability_tag.includes(tag) || tag.includes(r.capability_tag));
  });

  if (relevant.length === 0) {
    return [];
  }

  // Group by agent_id, track weighted utility sum and observation count.
  type AgentStats = {
    weightedSum: number;
    totalWeight: number;
    count: number;
    model: string;
    skill_ids: string[];
  };

  const agentStats = new Map<string, AgentStats>();

  const n = relevant.length;
  for (let i = 0; i < n; i++) {
    const record = relevant[i]!;
    const indexFromEnd = n - 1 - i;
    const weight = decayWeight(indexFromEnd);

    const existing = agentStats.get(record.agent_id);
    if (existing) {
      existing.weightedSum += record.utility * weight;
      existing.totalWeight += weight;
      existing.count += 1;
      // Use most-recent model and skill_ids (later records overwrite)
      if (record.model) existing.model = record.model;
      if (record.skill_ids && record.skill_ids.length > 0) existing.skill_ids = record.skill_ids;
    } else {
      agentStats.set(record.agent_id, {
        weightedSum: record.utility * weight,
        totalWeight: weight,
        count: 1,
        model: record.model ?? 'sonnet',
        skill_ids: record.skill_ids ?? [],
      });
    }
  }

  // Apply min-observations gate and compute mean utility.
  const candidates: Array<{ agent_id: string; meanUtility: number; model: string; skill_ids: string[] }> = [];

  for (const [agentId, stats] of agentStats) {
    if (stats.count < MIN_OBSERVATIONS) {
      continue; // below min-observations gate
    }
    const meanUtility = stats.totalWeight > 0 ? stats.weightedSum / stats.totalWeight : 0;
    candidates.push({
      agent_id: agentId,
      meanUtility,
      model: stats.model,
      skill_ids: stats.skill_ids,
    });
  }

  if (candidates.length === 0) {
    return [];
  }

  // Sort by descending mean utility
  candidates.sort((a, b) => b.meanUtility - a.meanUtility);

  // Take top-K and map to AgentSuggestion with confidence in [0,1]
  const topK = candidates.slice(0, k);
  const maxUtility = topK[0]!.meanUtility;

  return topK.map((c) => ({
    agent_id: c.agent_id,
    model: c.model,
    skill_ids: c.skill_ids,
    confidence: maxUtility > 0 ? c.meanUtility / maxUtility : 0,
  }));
}
