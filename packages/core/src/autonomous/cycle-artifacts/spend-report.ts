// packages/core/src/autonomous/cycle-artifacts/spend-report.ts
//
// P0.8 — spend report + ledger + completed.json artifacts.
//
// Reconciles a cycle's PLANNED cost (plan.json item estimatedCostUsd) against
// its ACTUAL spend (per-phase costUsd in phases/*.json, per-item actuals from
// phases/execute.json). Produces:
//   - SpendReport               (in-memory + spend-report.json)
//   - GFM markdown section       (appended to the epic PR body)
//   - one cycle-ledger.jsonl row (the calibration feed for future plan-phase
//                                 cost estimates — written for EVERY cycle)
//   - completed.json             (the terminal CycleResult snapshot)
//
// Every read is individually try/caught; every write is best-effort and NEVER
// throws — an artifact write must never fail a cycle that otherwise passed.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Phase JSONs whose costUsd, summed, form the "overhead" of a cycle. */
const OVERHEAD_PHASES = ['audit', 'plan', 'assign', 'test', 'review', 'gate'] as const;

export interface SpendReportPerItem {
  itemId: string;
  title: string;
  plannedUsd: number | null;
  actualUsd: number;
  status: string;
}

export interface SpendReport {
  schemaVersion: 1;
  cycleId: string;
  epicId?: string;
  objective?: string;
  budgetUsd: number;
  totalUsd: number;
  executionUsd: number;
  overheadUsd: number;
  /** totalUsd / budgetUsd; 0 when budgetUsd is 0 (avoid divide-by-zero). */
  utilization: number;
  perItem: SpendReportPerItem[];
  generatedAt: string;
}

export interface CycleLedgerRow {
  schemaVersion: 1;
  cycleId: string;
  epicId?: string;
  objective?: string;
  budgetUsd: number;
  totalUsd: number;
  utilization: number;
  executionUsd: number;
  overheadUsd: number;
  prUrl?: string;
  prNumber?: number;
  gateVerdict?: string;
  items: { planned: number; completed: number; failed: number };
  completedAt: string;
}

export interface BuildSpendReportArgs {
  projectRoot: string;
  cycleId: string;
  budgetUsd: number;
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function phasesDir(projectRoot: string, cycleId: string): string {
  return join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases');
}

/**
 * Extract the per-item ACTUAL cost map from phases/execute.json. The execute
 * phase writes both `agentRuns[]` and `itemResults[]`, each entry carrying
 * `{itemId, costUsd, status}` (see ExecutePhaseSchema). We read defensively:
 * prefer itemResults, fall back to agentRuns, and merge by itemId (max cost
 * wins so a retried item's higher actual is reflected).
 */
function readExecuteActuals(
  executeJson: any,
): Map<string, { actualUsd: number; status: string }> {
  const out = new Map<string, { actualUsd: number; status: string }>();
  if (!executeJson || typeof executeJson !== 'object') return out;
  const sources: any[] = [];
  if (Array.isArray(executeJson.itemResults)) sources.push(...executeJson.itemResults);
  if (Array.isArray(executeJson.agentRuns)) sources.push(...executeJson.agentRuns);
  for (const entry of sources) {
    if (!entry || typeof entry !== 'object') continue;
    const itemId = typeof entry.itemId === 'string' ? entry.itemId : undefined;
    if (!itemId) continue;
    const cost = typeof entry.costUsd === 'number' ? entry.costUsd : 0;
    const status = typeof entry.status === 'string' ? entry.status : 'unknown';
    const prior = out.get(itemId);
    if (!prior) {
      out.set(itemId, { actualUsd: cost, status });
    } else {
      // Merge: keep the highest observed cost; prefer a non-unknown status.
      out.set(itemId, {
        actualUsd: Math.max(prior.actualUsd, cost),
        status: status !== 'unknown' ? status : prior.status,
      });
    }
  }
  return out;
}

/**
 * Build the spend report for a cycle. Returns null only when BOTH plan.json and
 * phases/execute.json are unreadable (no usable signal). Otherwise returns a
 * best-effort report — a missing phase JSON simply contributes $0.
 */
export function buildSpendReport(args: BuildSpendReportArgs): SpendReport | null {
  const { projectRoot, cycleId } = args;
  const budgetUsd = typeof args.budgetUsd === 'number' && args.budgetUsd >= 0 ? args.budgetUsd : 0;

  const planJson = tryReadJson(
    join(projectRoot, '.agentforge', 'cycles', cycleId, 'plan.json'),
  );
  const executeJson = tryReadJson(join(phasesDir(projectRoot, cycleId), 'execute.json'));

  // Return null only when there is no usable signal at all.
  if (!planJson && !executeJson) return null;

  // executionUsd = execute.json's phase costUsd.
  const executionUsd =
    executeJson && typeof executeJson.costUsd === 'number' ? executeJson.costUsd : 0;

  // overheadUsd = sum of the other phase JSONs' costUsd.
  let overheadUsd = 0;
  for (const name of OVERHEAD_PHASES) {
    const j = tryReadJson(join(phasesDir(projectRoot, cycleId), `${name}.json`));
    if (j && typeof j.costUsd === 'number') overheadUsd += j.costUsd;
  }

  const totalUsd = executionUsd + overheadUsd;
  const utilization = budgetUsd > 0 ? totalUsd / budgetUsd : 0;

  const actuals = readExecuteActuals(executeJson);
  const planItems: any[] = Array.isArray(planJson?.items) ? planJson.items : [];
  const perItem: SpendReportPerItem[] = planItems
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => {
      const actual = actuals.get(i.id);
      return {
        itemId: i.id as string,
        title: typeof i.title === 'string' ? i.title : '(untitled)',
        plannedUsd: typeof i.estimatedCostUsd === 'number' ? i.estimatedCostUsd : null,
        actualUsd: actual?.actualUsd ?? 0,
        status: actual?.status ?? (typeof i.status === 'string' ? i.status : 'unknown'),
      };
    });

  const epicId =
    typeof executeJson?.epicIntegration?.epicId === 'string'
      ? executeJson.epicIntegration.epicId
      : undefined;

  return {
    schemaVersion: 1,
    cycleId,
    ...(epicId !== undefined ? { epicId } : {}),
    budgetUsd,
    totalUsd,
    executionUsd,
    overheadUsd,
    utilization,
    perItem,
    generatedAt: new Date().toISOString(),
  };
}

/** Write spend-report.json. Best-effort — never throws. */
export function writeSpendReport(
  projectRoot: string,
  cycleId: string,
  report: SpendReport,
): void {
  const path = join(projectRoot, '.agentforge', 'cycles', cycleId, 'spend-report.json');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
  } catch {
    // non-fatal
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Render the spend report as a `### Spend report` GFM section: a per-item table
 * (Item | Planned | Actual | Status) followed by a totals line. plannedUsd null
 * renders as an em dash.
 */
export function renderSpendReportMarkdown(report: SpendReport): string {
  const lines: string[] = [];
  lines.push('### Spend report');
  lines.push('');
  lines.push('| Item | Planned | Actual | Status |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of report.perItem) {
    const planned = item.plannedUsd !== null ? fmtUsd(item.plannedUsd) : '—';
    lines.push(
      `| ${item.itemId} | ${planned} | ${fmtUsd(item.actualUsd)} | ${item.status} |`,
    );
  }
  if (report.perItem.length === 0) {
    lines.push('| (no items) | — | — | — |');
  }
  const utilPct = (report.utilization * 100).toFixed(0);
  lines.push('');
  lines.push(
    `**Total: ${fmtUsd(report.totalUsd)} of ${fmtUsd(report.budgetUsd)} budget ` +
      `(${utilPct}% utilization) — execution ${fmtUsd(report.executionUsd)} / ` +
      `overhead ${fmtUsd(report.overheadUsd)}**`,
  );
  return lines.join('\n');
}

/**
 * Append one JSON line to .agentforge/memory/cycle-ledger.jsonl. This file is
 * the calibration feed for future plan-phase cost estimates. Best-effort —
 * never throws.
 */
export function appendLedgerRow(projectRoot: string, row: CycleLedgerRow): void {
  const path = join(projectRoot, '.agentforge', 'memory', 'cycle-ledger.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * Write the terminal CycleResult to completed.json (pretty-printed). Best-effort
 * — never throws.
 */
export function writeCompletedSnapshot(
  projectRoot: string,
  cycleId: string,
  result: unknown,
): void {
  const path = join(projectRoot, '.agentforge', 'cycles', cycleId, 'completed.json');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2));
  } catch {
    // non-fatal
  }
}
