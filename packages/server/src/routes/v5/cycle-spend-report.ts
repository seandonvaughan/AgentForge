/**
 * cycle-spend-report.ts — GET /api/v5/cycles/:id/spend-report
 *
 * Serves the pre-built spend-report.json artifact produced by
 * packages/core/src/autonomous/cycle-artifacts/spend-report.ts.
 *
 * Response shape:
 *   { data: SpendReport, meta: { cycleId, timestamp } }
 *
 * 404 when spend-report.json is absent (cycle not yet complete or report
 * not generated for this cycle).
 * 400 for invalid / path-traversal cycleId.
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Types (mirrored from spend-report.ts — kept local to avoid a cross-package
// import that would drag in the whole core package at server boot time)
// ---------------------------------------------------------------------------

export interface SpendReportPerItem {
  itemId: string;
  title: string;
  plannedUsd: number | null;
  actualUsd: number;
  status: string;
  estimatedComplexity?: 'low' | 'medium' | 'high';
  estimateAccuracy?: number;
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
  utilization: number;
  perItem: SpendReportPerItem[];
  generatedAt: string;
}

export interface CycleSpendReportOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in cycleId. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]{1,200}$/;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function cycleSpendReportRoutes(
  app: FastifyInstance,
  opts: CycleSpendReportOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/spend-report
   *
   * Returns the pre-built spend-report.json for the given cycle.
   * 404 when the file has not been generated yet.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/spend-report',
    async (req, reply) => {
      const rawId = req.params.id;

      // Match-then-use: capture sanitised id so the analyser can verify only
      // safe characters reach the filesystem join below.
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
          cycleId: rawId,
        });
      }
      const safeCycleId: string = matched[0];

      // Path containment check.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      const baseWithSep = cyclesBaseDir.endsWith(sep)
        ? cyclesBaseDir
        : cyclesBaseDir + sep;
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      const reportPath = join(cycleDir, 'spend-report.json');

      if (!existsSync(reportPath)) {
        return reply.status(404).send({
          error: 'Spend report not found',
          cycleId: safeCycleId,
        });
      }

      let report: SpendReport;
      try {
        const raw = readFileSync(reportPath, 'utf-8');
        report = JSON.parse(raw) as SpendReport;
      } catch {
        return reply
          .status(500)
          .send({ error: 'Failed to parse spend-report.json', cycleId: safeCycleId });
      }

      return reply.send({
        data: report,
        meta: {
          cycleId: safeCycleId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
