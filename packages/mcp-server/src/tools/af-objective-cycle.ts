/**
 * af-objective-cycle.ts — first-class objective-cycle (epic) tools so a
 * Claude Code session can drive AgentForge end-to-end:
 *
 *   af_epic_decomposition — child DAG summary from
 *                           .agentforge/cycles/<id>/decomposition.json
 *   af_epic_review        — judgment verdict from
 *                           .agentforge/cycles/<id>/phases/epic-review.json
 *   af_spend_report       — planned-vs-actual spend from
 *                           .agentforge/cycles/<id>/spend-report.json
 *   af_objective_preview  — pure budget-band math + the exact CLI command
 *                           (never spawns LLM work from MCP)
 *
 * The readers parse artifacts written by packages/core
 * (autonomous/decompose/types.ts, autonomous/phase-handlers/epic-review.ts,
 * autonomous/cycle-artifacts/spend-report.ts). The mcp-server package
 * deliberately does not depend on @agentforge/core (SQLite weight), so the
 * shapes here mirror those writers — keep the two in lockstep.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

// Match-then-use sanitizer (repo convention) — same pattern as
// afCycleStatus/afCycleEvents in af-codex-workflows.ts.
const SAFE_CYCLE_ID = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Pure budget math, mirroring core/src/autonomous/decompose/decompose-objective.ts
 * computeSpendableUsd: $6 fixed gate/judgment overhead, then 20% of the
 * remainder reserved for fix-up work.
 */
export const EPIC_FIXED_OVERHEAD_USD = 6;
export const EPIC_FIXUP_RESERVE_MULTIPLIER = 1.2;
export const EPIC_BAND_LOWER = 0.7;
export const EPIC_BAND_UPPER = 1.0;

interface ToolResult {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}

export const AfEpicDecompositionInput = z.object({
  cycleId: z.string().min(8).max(64),
});
export type AfEpicDecompositionInputType = z.infer<typeof AfEpicDecompositionInput>;

export const AfEpicReviewInput = z.object({
  cycleId: z.string().min(8).max(64),
});
export type AfEpicReviewInputType = z.infer<typeof AfEpicReviewInput>;

export const AfSpendReportInput = z.object({
  cycleId: z.string().min(8).max(64),
});
export type AfSpendReportInputType = z.infer<typeof AfSpendReportInput>;

export const AfObjectivePreviewInput = z.object({
  objective: z.string().min(8).max(8192),
  budgetUsd: z.number().positive().optional(),
});
export type AfObjectivePreviewInputType = z.infer<typeof AfObjectivePreviewInput>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a cycle artifact path with match-then-use id validation AND a
 * resolve+startsWith containment barrier (CodeQL js/path-injection): the
 * resolved path must stay under .agentforge/cycles.
 */
function resolveCycleArtifact(
  projectRoot: string,
  cycleId: string,
  segments: string[],
): { ok: true; path: string; cycleId: string } | { ok: false; result: ToolResult } {
  const idMatch = SAFE_CYCLE_ID.exec(cycleId);
  if (!idMatch) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        error: { code: 'INVALID_CYCLE_ID', message: 'cycleId must be alphanumerics/dashes (8-64 chars)' },
      },
    };
  }
  const cyclesDir = resolve(projectRoot, '.agentforge', 'cycles');
  const artifactPath = resolve(cyclesDir, idMatch[0], ...segments);
  if (!artifactPath.startsWith(cyclesDir + sep)) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        error: { code: 'INVALID_CYCLE_ID', message: 'cycleId resolves outside the cycles directory' },
      },
    };
  }
  return { ok: true, path: artifactPath, cycleId: idMatch[0] };
}

function readJsonArtifact(
  path: string,
  label: string,
  cycleId: string,
): { ok: true; parsed: Record<string, unknown> } | { ok: false; result: ToolResult } {
  if (!existsSync(path)) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        error: { code: 'ARTIFACT_NOT_FOUND', message: `No ${label} recorded for cycle ${cycleId}` },
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        error: {
          code: 'ARTIFACT_PARSE_FAILED',
          message: `Failed to parse ${label} for cycle ${cycleId}: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        error: { code: 'ARTIFACT_PARSE_FAILED', message: `${label} for cycle ${cycleId} is not a JSON object` },
      },
    };
  }
  return { ok: true, parsed: parsed as Record<string, unknown> };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fmtUsd(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '?';
}

// ---------------------------------------------------------------------------
// af_epic_decomposition
// ---------------------------------------------------------------------------

export interface EpicChildSummary {
  id: string;
  title: string;
  files: string[];
  estimatedCostUsd: number | null;
  wave: number | null;
  predecessors: string[];
}

/**
 * Read .agentforge/cycles/<id>/decomposition.json and return the child DAG
 * summary (id/title/files/estimatedCostUsd/wave/predecessors per child) plus
 * the validationReport budget block. Read-only, pure fs.
 */
export function afEpicDecomposition(
  input: AfEpicDecompositionInputType,
  projectRoot: string,
): ToolResult {
  const artifact = resolveCycleArtifact(projectRoot, input.cycleId, ['decomposition.json']);
  if (!artifact.ok) return artifact.result;

  const read = readJsonArtifact(artifact.path, 'decomposition.json', artifact.cycleId);
  if (!read.ok) return read.result;
  const record = read.parsed;

  const children: EpicChildSummary[] = (Array.isArray(record['children']) ? record['children'] : [])
    .map(asRecord)
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => ({
      id: typeof c['id'] === 'string' ? c['id'] : '(unknown)',
      title: typeof c['title'] === 'string' ? c['title'] : '',
      files: stringArray(c['files']),
      estimatedCostUsd: typeof c['estimatedCostUsd'] === 'number' ? c['estimatedCostUsd'] : null,
      wave: typeof c['wave'] === 'number' ? c['wave'] : null,
      predecessors: stringArray(c['predecessors']),
    }));

  const validationReport = asRecord(record['validationReport']);
  const waveCount =
    typeof validationReport?.['waveCount'] === 'number'
      ? validationReport['waveCount']
      : children.reduce((max, c) => (c.wave !== null && c.wave + 1 > max ? c.wave + 1 : max), 0);
  const totalEstimatedUsd = round2(
    children.reduce((sum, c) => sum + (c.estimatedCostUsd ?? 0), 0),
  );

  return {
    ok: true,
    data: {
      cycleId: artifact.cycleId,
      epicId: typeof record['epicId'] === 'string' ? record['epicId'] : null,
      childCount: children.length,
      waveCount,
      totalEstimatedUsd,
      children,
      // Budget-aware sizing audit (P0.3) — present only when the objective
      // carried a budgetUsd; null otherwise.
      budget: asRecord(validationReport?.['budget']),
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// af_epic_review
// ---------------------------------------------------------------------------

/**
 * Read .agentforge/cycles/<id>/phases/epic-review.json (the persisted
 * EpicReviewArtifact) and return verdict/rationale/faultedItems/triageUsed/
 * costUsd. Read-only, pure fs.
 */
export function afEpicReview(input: AfEpicReviewInputType, projectRoot: string): ToolResult {
  const artifact = resolveCycleArtifact(projectRoot, input.cycleId, ['phases', 'epic-review.json']);
  if (!artifact.ok) return artifact.result;

  const read = readJsonArtifact(artifact.path, 'epic-review.json', artifact.cycleId);
  if (!read.ok) return read.result;
  const record = read.parsed;

  const faultedItems = (Array.isArray(record['faultedItems']) ? record['faultedItems'] : [])
    .map(asRecord)
    .filter((f): f is Record<string, unknown> => f !== null)
    .map((f) => ({
      itemId: typeof f['itemId'] === 'string' ? f['itemId'] : '(unknown)',
      reason: typeof f['reason'] === 'string' ? f['reason'] : '',
      files: stringArray(f['files']),
    }));

  return {
    ok: true,
    data: {
      cycleId: artifact.cycleId,
      verdict: typeof record['verdict'] === 'string' ? record['verdict'] : 'TRIAGE',
      rationale: typeof record['rationale'] === 'string' ? record['rationale'] : '',
      faultedItems,
      triageUsed: record['triageUsed'] === true,
      costUsd: typeof record['costUsd'] === 'number' ? record['costUsd'] : 0,
      attempt: typeof record['attempt'] === 'number' ? record['attempt'] : null,
      completedAt: typeof record['completedAt'] === 'string' ? record['completedAt'] : null,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// af_spend_report
// ---------------------------------------------------------------------------

/**
 * Read .agentforge/cycles/<id>/spend-report.json (planned-vs-actual cost
 * reconciliation) and return the full report plus a compact totals line.
 * Read-only, pure fs.
 */
export function afSpendReport(input: AfSpendReportInputType, projectRoot: string): ToolResult {
  const artifact = resolveCycleArtifact(projectRoot, input.cycleId, ['spend-report.json']);
  if (!artifact.ok) return artifact.result;

  const read = readJsonArtifact(artifact.path, 'spend-report.json', artifact.cycleId);
  if (!read.ok) return read.result;
  const record = read.parsed;

  const totalUsd = record['totalUsd'];
  const budgetUsd = record['budgetUsd'];
  const utilization = record['utilization'];
  const itemCount = Array.isArray(record['perItem']) ? record['perItem'].length : 0;
  const utilizationPct =
    typeof utilization === 'number' && Number.isFinite(utilization)
      ? `${(utilization * 100).toFixed(1)}%`
      : '?';

  const totals =
    `total $${fmtUsd(totalUsd)} of $${fmtUsd(budgetUsd)} budget (${utilizationPct} utilization) — ` +
    `execution $${fmtUsd(record['executionUsd'])} + overhead $${fmtUsd(record['overheadUsd'])} ` +
    `across ${itemCount} item(s)`;

  return {
    ok: true,
    data: {
      cycleId: artifact.cycleId,
      totals,
      report: record,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// af_objective_preview
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping — String ops only, no regex on user input. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Pure sizing helper for an objective cycle. DOES NOT spawn LLM work from
 * MCP: it returns the exact CLI command the operator should run plus the
 * computed spendable/band math so the session can sanity-check sizing
 * instantly. No subprocess, no fs.
 *
 *   spendable = (budgetUsd − 6) / 1.2
 *   band      = [0.7, 1.0] × spendable
 */
export function afObjectivePreview(input: AfObjectivePreviewInputType): ToolResult {
  const objective = input.objective.trim();
  if (objective.length < 8) {
    return {
      ok: false,
      data: null,
      error: { code: 'OBJECTIVE_TOO_SHORT', message: 'objective must be at least 8 non-whitespace characters' },
    };
  }

  const argv = ['agentforge', 'cycle', 'preview', '--objective', objective];
  if (input.budgetUsd !== undefined) argv.push('--budget-usd', String(input.budgetUsd));
  argv.push('--json');

  const command =
    `agentforge cycle preview --objective ${shellQuote(objective)}` +
    (input.budgetUsd !== undefined ? ` --budget-usd ${input.budgetUsd}` : '') +
    ' --json';

  let budget: Record<string, unknown> | null = null;
  if (input.budgetUsd !== undefined) {
    const spendableRaw = Math.max(
      0,
      (input.budgetUsd - EPIC_FIXED_OVERHEAD_USD) / EPIC_FIXUP_RESERVE_MULTIPLIER,
    );
    const lowerUsd = round2(EPIC_BAND_LOWER * spendableRaw);
    const upperUsd = round2(EPIC_BAND_UPPER * spendableRaw);
    budget = {
      budgetUsd: input.budgetUsd,
      fixedOverheadUsd: EPIC_FIXED_OVERHEAD_USD,
      fixupReserveMultiplier: EPIC_FIXUP_RESERVE_MULTIPLIER,
      spendableUsd: round2(spendableRaw),
      lowerUsd,
      upperUsd,
      bandNote:
        `The planner must size children so Σ(estimatedCostUsd) lands within ` +
        `[${EPIC_BAND_LOWER}, ${EPIC_BAND_UPPER}] × spendable — $${lowerUsd.toFixed(2)}–$${upperUsd.toFixed(2)}.`,
    };
  }

  return {
    ok: true,
    data: {
      command,
      argv,
      budget,
      notes: [
        'Run the command from the project root of the target repository.',
        'The objective preview makes ONE planner LLM call (~$5); it never executes a cycle, touches git, or opens PRs.',
        'To run the epic for real afterwards: agentforge cycle run --objective <text> --budget-usd <usd>.',
      ],
    },
    error: null,
  };
}
