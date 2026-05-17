// packages/core/src/autonomous/flywheel/continuous-improvement.ts
//
// T2.4 — Flywheel telemetry: measures whether new cycle failures match prior
// learnings from agents that ran in this cycle. A decreasing
// preventabilityRatio over time is the primary autonomy-improving signal.
//
// Algorithm:
//   1. For each failed sprint item in the cycle (gate REJECTED, review
//      CRITICAL/MAJOR, or test failure), extract a root-cause string from the
//      available phase JSON entries.
//   2. After auto-reforge has run, read each involved agent's `learnings:`
//      array from their YAML file.
//   3. For each failure, check whether any agent's learnings contain a
//      normalized substring match to the failure's root cause.
//   4. preventabilityRatio = matched / total (0 when total = 0).
//   5. Persist result to .agentforge/flywheel/continuous-improvement-<cycleId>.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContinuousImprovementMetric {
  cycleId: string;
  totalFailures: number;
  failuresPreventableByPriorLearnings: number;
  /** 0..1 ratio. Decreases as learnings accumulate. */
  preventabilityRatio: number;
  perAgent: Array<{
    agentId: string;
    relevantLearnings: number;
    matchedFailures: number;
  }>;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CyclePhasesDir {
  gateJson?: Record<string, unknown> | undefined;
  reviewJson?: Record<string, unknown> | undefined;
  executeJson?: { itemResults?: Array<{ status: string; error?: string; agentId?: string }> } | undefined;
}

function tryReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Load phase JSONs from the cycle's phases/ directory.
 */
function loadCyclePhases(projectRoot: string, cycleId: string): CyclePhasesDir {
  const phasesDir = join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases');
  const gateResult = tryReadJson(join(phasesDir, 'gate.json'));
  const reviewResult = tryReadJson(join(phasesDir, 'review.json'));
  const executeResult = tryReadJson(join(phasesDir, 'execute.json'));
  return {
    ...(gateResult !== null ? { gateJson: gateResult } : {}),
    ...(reviewResult !== null ? { reviewJson: reviewResult } : {}),
    ...(executeResult !== null ? { executeJson: executeResult as CyclePhasesDir['executeJson'] } : {}),
  };
}

/**
 * A single extracted failure with its root-cause text and the agent that
 * produced it (when known).
 */
interface ExtractedFailure {
  source: 'gate' | 'review' | 'execute';
  rootCause: string;
  agentId?: string;
}

/**
 * Pull a root-cause string from a gate.json verdict.
 * The gate can carry a REJECT rationale and/or CRITICAL/MAJOR findings.
 */
function extractGateFailures(gateJson: Record<string, unknown>): ExtractedFailure[] {
  const failures: ExtractedFailure[] = [];
  if (gateJson['verdict'] === 'REJECT') {
    const rationale =
      typeof gateJson['rationale'] === 'string' ? gateJson['rationale'] : '';
    if (rationale) failures.push({ source: 'gate', rootCause: rationale.slice(0, 500) });
  }
  return failures;
}

/**
 * Pull root-cause strings from a review.json findings block.
 * Looks for CRITICAL / MAJOR severity markers in the findings text.
 */
function extractReviewFailures(reviewJson: Record<string, unknown>): ExtractedFailure[] {
  const failures: ExtractedFailure[] = [];
  const findingsRaw = reviewJson['findings'];
  const text =
    typeof findingsRaw === 'string'
      ? findingsRaw
      : typeof findingsRaw === 'object' && findingsRaw !== null
        ? JSON.stringify(findingsRaw)
        : '';

  if (!text) return failures;

  // Extract lines with CRITICAL or MAJOR severity markers.
  const pattern = /^[-*\s]*(CRITICAL|MAJOR)[:\s\[].*$/im;
  const lines = text.split('\n').filter((l) => pattern.test(l.trim()));
  for (const line of lines.slice(0, 10)) {
    const clean = line.replace(/^[-*\s]+/, '').trim();
    if (clean) failures.push({ source: 'review', rootCause: clean.slice(0, 300) });
  }

  // Also check structured findings array.
  if (Array.isArray(reviewJson['findings'])) {
    for (const f of reviewJson['findings'] as Array<Record<string, unknown>>) {
      const msg =
        typeof f['message'] === 'string'
          ? f['message']
          : typeof f['lesson'] === 'string'
            ? f['lesson']
            : typeof f['rootCause'] === 'string'
              ? f['rootCause']
              : '';
      const sev = typeof f['severity'] === 'string' ? f['severity'].toUpperCase() : '';
      if ((sev === 'CRITICAL' || sev === 'MAJOR') && msg) {
        failures.push({ source: 'review', rootCause: msg.slice(0, 300) });
      }
    }
  }

  return failures;
}

/**
 * Pull root-cause strings from failed execute-phase item results.
 */
function extractExecuteFailures(
  executeJson: CyclePhasesDir['executeJson'],
): ExtractedFailure[] {
  if (!executeJson) return [];
  const failures: ExtractedFailure[] = [];
  const items = executeJson.itemResults ?? [];
  for (const item of items) {
    if (item.status === 'failed' && item.error) {
      const failure: ExtractedFailure = {
        source: 'execute',
        rootCause: item.error.slice(0, 300),
      };
      if (typeof item.agentId === 'string') failure.agentId = item.agentId;
      failures.push(failure);
    }
  }
  return failures;
}

/**
 * Load the `learnings:` array from an agent's YAML file.
 * Returns an empty array when the file is absent or the field is missing.
 */
function loadAgentLearnings(projectRoot: string, agentId: string): string[] {
  const agentPath = join(projectRoot, '.agentforge', 'agents', `${agentId}.yaml`);
  if (!existsSync(agentPath)) return [];
  try {
    const raw = readFileSync(agentPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return [];
    const learnings = parsed['learnings'];
    if (!Array.isArray(learnings)) return [];
    return learnings
      .map((l) => (typeof l === 'string' ? l : ''))
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Normalize a string for comparison: lowercase, collapse whitespace, strip
 * common punctuation. This is intentionally loose — we want substring matches
 * to succeed across minor phrasing differences.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return true if any learning in `learnings` contains a meaningful substring
 * of `rootCause` (or vice versa, to handle both short and long descriptions).
 *
 * Uses a 20-character minimum overlap to avoid spurious matches on common
 * words like "failed" or "error".
 */
function matchesAnyLearning(rootCause: string, learnings: string[]): boolean {
  const MIN_MATCH_LEN = 20;
  const normCause = normalize(rootCause);
  if (normCause.length < MIN_MATCH_LEN) return false;

  for (const learning of learnings) {
    const normLearn = normalize(learning);
    if (normLearn.length < MIN_MATCH_LEN) continue;
    // Check bidirectional substring containment — failure description may be
    // longer or shorter than the learning depending on how verbose the source was.
    if (normCause.includes(normLearn.slice(0, 60)) || normLearn.includes(normCause.slice(0, 60))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeContinuousImprovementOptions {
  projectRoot: string;
  cycleId: string;
  /** Explicit agent IDs to check; when absent, scanned from execute.json. */
  agentIds?: string[];
}

/**
 * Compute the continuous-improvement metric for the completed cycle.
 *
 * Reads phase JSONs from the cycle directory, extracts failure root-causes,
 * then checks each involved agent's post-reforge `learnings:` array for
 * matches. Persists to `.agentforge/flywheel/continuous-improvement-<cycleId>.json`.
 */
export async function computeContinuousImprovement(
  opts: ComputeContinuousImprovementOptions,
): Promise<ContinuousImprovementMetric> {
  const { projectRoot, cycleId } = opts;
  const phases = loadCyclePhases(projectRoot, cycleId);

  // 1. Collect all failures from this cycle.
  const allFailures: ExtractedFailure[] = [
    ...(phases.gateJson ? extractGateFailures(phases.gateJson) : []),
    ...(phases.reviewJson ? extractReviewFailures(phases.reviewJson) : []),
    ...extractExecuteFailures(phases.executeJson),
  ];

  // Deduplicate by rootCause (same error may appear in multiple phases).
  const seen = new Set<string>();
  const failures: ExtractedFailure[] = [];
  for (const f of allFailures) {
    const key = normalize(f.rootCause).slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      failures.push(f);
    }
  }

  // 2. Determine the involved agent IDs.
  let agentIds: string[];
  if (opts.agentIds && opts.agentIds.length > 0) {
    agentIds = opts.agentIds;
  } else {
    // Scan execute.json for agentIds
    const items = phases.executeJson?.itemResults ?? [];
    const ids = items
      .map((r) => r.agentId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    agentIds = [...new Set(ids)];

    // If still empty, fall back to all agents in the agents dir.
    if (agentIds.length === 0) {
      const agentsDir = join(projectRoot, '.agentforge', 'agents');
      if (existsSync(agentsDir)) {
        agentIds = readdirSync(agentsDir)
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => f.replace(/\.yaml$/, ''));
      }
    }
  }

  // 3. Load learnings for each agent.
  const agentLearningsMap = new Map<string, string[]>();
  for (const agentId of agentIds) {
    agentLearningsMap.set(agentId, loadAgentLearnings(projectRoot, agentId));
  }

  // 4. For each failure, check if any agent's learnings would have caught it.
  let preventableCount = 0;
  const perAgentMatchCount = new Map<string, number>(agentIds.map((id) => [id, 0]));

  for (const failure of failures) {
    let matched = false;
    for (const [agentId, learnings] of agentLearningsMap.entries()) {
      if (matchesAnyLearning(failure.rootCause, learnings)) {
        const prev = perAgentMatchCount.get(agentId) ?? 0;
        perAgentMatchCount.set(agentId, prev + 1);
        matched = true;
      }
    }
    if (matched) preventableCount++;
  }

  const totalFailures = failures.length;
  const metric: ContinuousImprovementMetric = {
    cycleId,
    totalFailures,
    failuresPreventableByPriorLearnings: preventableCount,
    preventabilityRatio: totalFailures > 0 ? preventableCount / totalFailures : 0,
    perAgent: agentIds.map((agentId) => ({
      agentId,
      relevantLearnings: agentLearningsMap.get(agentId)?.length ?? 0,
      matchedFailures: perAgentMatchCount.get(agentId) ?? 0,
    })),
    computedAt: new Date().toISOString(),
  };

  // 5. Persist to .agentforge/flywheel/
  const flywheelDir = join(projectRoot, '.agentforge', 'flywheel');
  try {
    mkdirSync(flywheelDir, { recursive: true });
    writeFileSync(
      join(flywheelDir, `continuous-improvement-${cycleId}.json`),
      JSON.stringify(metric, null, 2),
    );
  } catch {
    // Non-fatal: metric is still returned even if persistence fails.
  }

  return metric;
}
