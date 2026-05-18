// packages/core/src/skills/flywheel/cluster-low-quality.ts
//
// Reads .agentforge/memory/self-eval.jsonl and step-scores.jsonl,
// groups entries by capability_tag, and returns clusters that have
// ≥3 occurrences AND mean step-score < 0.55.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LowQualityCluster {
  id: string;
  capabilityTag: string;
  memberIds: string[];
  meanStepScore: number;
  occurrences: number;
  exemplarPrompt: string | null;
}

// ---------------------------------------------------------------------------
// Internal: JSONL row shapes (loose — we parse defensively)
// ---------------------------------------------------------------------------

interface SelfEvalRow {
  id?: string;
  capability_tag?: string;
  step_score?: number;
  score?: number;
  prompt?: string;
  exemplar_prompt?: string;
  [key: string]: unknown;
}

interface StepScoreRow {
  id?: string;
  capability_tag?: string;
  step_score?: number;
  score?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const rows: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClusterOptions {
  /** Absolute path to the project root (i.e. the dir that contains .agentforge/). */
  projectRoot: string;
  /** Minimum number of occurrences in a cluster to qualify. Default: 3. */
  minOccurrences?: number;
  /** Maximum mean step-score (exclusive upper bound) to qualify. Default: 0.55. */
  maxMeanScore?: number;
}

/**
 * Read self-eval and step-scores JSONL files under `.agentforge/memory/`
 * and return clusters that fall below the quality threshold.
 *
 * A cluster is keyed by `capability_tag`. An entry contributes a step score
 * taken from `step_score` or `score` (whichever is present, in that order).
 * Entries without a resolvable score are treated as score 0.
 */
export function clusterLowQuality(options: ClusterOptions): LowQualityCluster[] {
  const { projectRoot, minOccurrences = 3, maxMeanScore = 0.55 } = options;

  const memoryDir = join(projectRoot, '.agentforge', 'memory');

  const selfEvalRows = readJsonl<SelfEvalRow>(join(memoryDir, 'self-eval.jsonl'));
  const stepScoreRows = readJsonl<StepScoreRow>(join(memoryDir, 'step-scores.jsonl'));

  // Combine rows — both files share the same shape
  const allRows: SelfEvalRow[] = [...selfEvalRows, ...stepScoreRows];

  // Group by capability_tag
  const byTag = new Map<
    string,
    { ids: string[]; scores: number[]; exemplarPrompt: string | null }
  >();

  for (const row of allRows) {
    const tag = typeof row.capability_tag === 'string' ? row.capability_tag.trim() : null;
    if (!tag) continue;

    const score =
      typeof row.step_score === 'number'
        ? row.step_score
        : typeof row.score === 'number'
          ? row.score
          : 0;

    const id =
      typeof row.id === 'string' ? row.id : `${tag}-${byTag.get(tag)?.ids.length ?? 0}`;

    const prompt =
      typeof row.exemplar_prompt === 'string'
        ? row.exemplar_prompt
        : typeof row.prompt === 'string'
          ? row.prompt
          : null;

    if (!byTag.has(tag)) {
      byTag.set(tag, { ids: [], scores: [], exemplarPrompt: null });
    }
    const bucket = byTag.get(tag)!;
    bucket.ids.push(id);
    bucket.scores.push(score);
    // Keep first non-null exemplar prompt encountered
    if (bucket.exemplarPrompt === null && prompt !== null) {
      bucket.exemplarPrompt = prompt;
    }
  }

  // Filter to qualifying clusters
  const clusters: LowQualityCluster[] = [];

  for (const [tag, bucket] of byTag.entries()) {
    if (bucket.ids.length < minOccurrences) continue;
    const meanScore = bucket.scores.reduce((a, b) => a + b, 0) / bucket.scores.length;
    if (meanScore >= maxMeanScore) continue;

    clusters.push({
      id: `cluster-${tag}`,
      capabilityTag: tag,
      memberIds: bucket.ids,
      meanStepScore: Math.round(meanScore * 10000) / 10000,
      occurrences: bucket.ids.length,
      exemplarPrompt: bucket.exemplarPrompt,
    });
  }

  // Deterministic order: worst score first
  clusters.sort((a, b) => a.meanStepScore - b.meanStepScore);
  return clusters;
}
