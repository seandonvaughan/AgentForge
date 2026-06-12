import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getCompletedExecuteItems } from './autonomous/checkpoint.js';
import {
  buildSpendReport,
  type SpendReport,
  type SpendReportPerItem,
} from './autonomous/cycle-artifacts/spend-report.js';
import type { ExecuteCheckpointItemRecord } from './autonomous/types.js';

export type {
  SpendReport,
  SpendReportPerItem,
} from './autonomous/cycle-artifacts/spend-report.js';

export interface SpendReportRouteOptions {
  projectRoot?: string;
  budgetUsd?: number;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCycleId(raw: string): boolean {
  if (raw.length < 1 || raw.length > 200) return false;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && char !== '-' && char !== '_') return false;
  }
  return true;
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

function readExistingSpendReport(projectRoot: string, cycleId: string): SpendReport | null {
  const report = readJson(
    join(projectRoot, '.agentforge', 'cycles', cycleId, 'spend-report.json'),
  );
  return report === null ? null : report as SpendReport;
}

function readBudgetUsd(projectRoot: string, cycleId: string, fallback: number): number {
  const completed = readJson(
    join(projectRoot, '.agentforge', 'cycles', cycleId, 'completed.json'),
  );
  if (isJsonObject(completed) && isJsonObject(completed['cost'])) {
    const budgetUsd = completed['cost']['budgetUsd'];
    if (typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0) {
      return budgetUsd;
    }
  }
  return fallback;
}

function withActualCost(
  item: SpendReportPerItem,
  restored: ExecuteCheckpointItemRecord,
): SpendReportPerItem {
  const actualUsd = Math.max(item.actualUsd, restored.costUsd);
  const base: SpendReportPerItem = {
    ...item,
    actualUsd,
    status: restored.status,
  };
  if (base.plannedUsd !== null && base.plannedUsd > 0 && actualUsd > 0) {
    return {
      ...base,
      estimateAccuracy: Number((actualUsd / base.plannedUsd).toFixed(2)),
    };
  }

  const { estimateAccuracy: _estimateAccuracy, ...withoutAccuracy } = base;
  return withoutAccuracy;
}

function restoredItemRow(restored: ExecuteCheckpointItemRecord): SpendReportPerItem {
  return {
    itemId: restored.itemId,
    title: restored.itemId,
    plannedUsd: null,
    actualUsd: restored.costUsd,
    status: restored.status,
  };
}

export function mergeRestoredSpendReportCosts(
  report: SpendReport,
  restoredItems: Record<string, ExecuteCheckpointItemRecord>,
): SpendReport {
  const restoredIds = new Set(Object.keys(restoredItems));
  const perItem = report.perItem.map((item) => {
    const restored = restoredItems[item.itemId];
    if (restored === undefined || restored.costUsd <= 0) return item;
    restoredIds.delete(item.itemId);
    return withActualCost(item, restored);
  });

  for (const itemId of restoredIds) {
    const restored = restoredItems[itemId];
    if (restored !== undefined && restored.costUsd > 0) {
      perItem.push(restoredItemRow(restored));
    }
  }

  const restoredExecutionUsd = perItem.reduce((sum, item) => sum + item.actualUsd, 0);
  const executionUsd = Math.max(report.executionUsd, restoredExecutionUsd);
  const totalUsd = executionUsd + report.overheadUsd;
  const utilization = report.budgetUsd > 0 ? totalUsd / report.budgetUsd : 0;

  return {
    ...report,
    totalUsd,
    executionUsd,
    utilization,
    perItem,
  };
}

export function readCycleSpendReport(
  projectRoot: string,
  cycleId: string,
  budgetUsd = 0,
): SpendReport | null {
  const existing = readExistingSpendReport(projectRoot, cycleId);
  const baseReport = existing ?? buildSpendReport({
    projectRoot,
    cycleId,
    budgetUsd: readBudgetUsd(projectRoot, cycleId, budgetUsd),
  });
  if (baseReport === null) return null;

  const restoredItems = getCompletedExecuteItems(projectRoot, cycleId);
  return mergeRestoredSpendReportCosts(baseReport, restoredItems);
}

export async function registerSpendReportRoutes(
  app: FastifyInstance,
  opts: SpendReportRouteOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const budgetUsd = opts.budgetUsd ?? 0;

  app.get<{ Params: { id: string } }>('/api/v5/cycles/:id/spend-report', async (req, reply) => {
    const cycleId = req.params.id;
    if (!isSafeCycleId(cycleId)) {
      return reply.status(400).send({
        error: 'Invalid cycleId - only alphanumeric, dash, and underscore allowed',
        cycleId,
      });
    }

    const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
    const cycleDir = resolve(join(cyclesBaseDir, cycleId));
    const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;
    if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
      return reply.status(400).send({ error: 'Invalid cycleId', cycleId });
    }

    let report: SpendReport | null;
    try {
      report = readCycleSpendReport(projectRoot, cycleId, budgetUsd);
    } catch {
      return reply.status(500).send({
        error: 'Failed to parse spend-report artifacts',
        cycleId,
      });
    }

    if (report === null) {
      return reply.status(404).send({
        error: 'Spend report not found',
        cycleId,
      });
    }

    return reply.send({
      data: report,
      meta: {
        cycleId,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
