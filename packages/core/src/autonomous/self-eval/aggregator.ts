// packages/core/src/autonomous/self-eval/aggregator.ts
//
// Reads self-eval.jsonl and provides aggregation helpers used by the
// learning-curator to identify which agents need the most corrective
// learning weight.
//
// Workstream T2.6 — Cycle 2 / v19.0.0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SelfEvalRecord } from './types.js';

const SELF_EVAL_FILE = 'self-eval.jsonl';

/** Minimum number of eval records required before an agent is included in rankings. */
const MIN_COUNT_THRESHOLD = 3;

export interface GetAgentAverageScoreOpts {
  projectRoot: string;
  agentId: string;
  /** How many calendar days back to include.  Defaults to 30. */
  windowDays?: number;
}

export interface LowestScoringAgent {
  agentId: string;
  avgScore: number;
  count: number;
}

export interface GetLowestScoringAgentsOpts {
  projectRoot: string;
  topN: number;
  /** How many calendar days back to include.  Defaults to 30. */
  windowDays?: number;
}

/**
 * Return the mean self-eval score for a single agent within the given window.
 *
 * Returns null when:
 * - The self-eval.jsonl file does not exist
 * - The agent has no records in the window
 */
export async function getAgentAverageScore(opts: GetAgentAverageScoreOpts): Promise<number | null> {
  const { projectRoot, agentId, windowDays = 30 } = opts;

  const records = loadRecords(projectRoot);
  const cutoff = cutoffDate(windowDays);
  const filtered = records.filter(
    (r) => r.agentId === agentId && new Date(r.recordedAt) >= cutoff,
  );

  if (filtered.length === 0) return null;

  const sum = filtered.reduce((acc, r) => acc + r.grade.score, 0);
  return sum / filtered.length;
}

/**
 * Return the `topN` agents with the lowest average score, ordered ascending
 * by average (worst first).
 *
 * Agents with fewer than `MIN_COUNT_THRESHOLD` (3) records in the window are
 * excluded to avoid noise from a single bad turn.
 */
export async function getLowestScoringAgents(
  opts: GetLowestScoringAgentsOpts,
): Promise<LowestScoringAgent[]> {
  const { projectRoot, topN, windowDays = 30 } = opts;

  const records = loadRecords(projectRoot);
  const cutoff = cutoffDate(windowDays);
  const inWindow = records.filter((r) => new Date(r.recordedAt) >= cutoff);

  // Group by agentId.
  const byAgent = new Map<string, number[]>();
  for (const r of inWindow) {
    const existing = byAgent.get(r.agentId) ?? [];
    existing.push(r.grade.score);
    byAgent.set(r.agentId, existing);
  }

  const ranked: LowestScoringAgent[] = [];
  for (const [agentId, scores] of byAgent) {
    if (scores.length < MIN_COUNT_THRESHOLD) continue;
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    ranked.push({ agentId, avgScore, count: scores.length });
  }

  // Sort ascending by avgScore (lowest first = most in need of improvement).
  ranked.sort((a, b) => a.avgScore - b.avgScore || b.count - a.count);

  return ranked.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadRecords(projectRoot: string): SelfEvalRecord[] {
  try {
    const filePath = join(projectRoot, '.agentforge', 'memory', SELF_EVAL_FILE);
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as SelfEvalRecord);
  } catch {
    return [];
  }
}

function cutoffDate(windowDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - windowDays);
  return d;
}
