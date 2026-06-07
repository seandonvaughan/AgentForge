import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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
  utilization: number;
  perItem: SpendReportPerItem[];
  generatedAt: string;
}

export interface CycleSpendReportRoutesOpts {
  projectRoot?: string;
}

const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

export async function cycleSpendReportRoutes(
  app: FastifyInstance,
  opts: CycleSpendReportRoutesOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/spend-report',
    async (req, reply) => {
      const rawCycleId = req.params.id;
      const matched = rawCycleId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          data: null,
          error: 'Invalid cycleId',
          meta: {
            cycleId: rawCycleId,
            timestamp: new Date().toISOString(),
          },
        });
      }
      const cycleId = matched[0];

      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, cycleId));
      const cycleRel = relative(cyclesBaseDir, cycleDir);
      if (cycleRel === '' || cycleRel.startsWith('..') || isAbsolute(cycleRel)) {
        return reply.status(400).send({
          data: null,
          error: 'Invalid cycleId',
          meta: {
            cycleId,
            timestamp: new Date().toISOString(),
          },
        });
      }

      const reportPath = join(cycleDir, 'spend-report.json');
      if (!existsSync(reportPath)) {
        return reply.status(404).send({
          data: null,
          error: 'Spend report not found',
          meta: {
            cycleId,
            timestamp: new Date().toISOString(),
          },
        });
      }

      let report: SpendReport;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8')) as SpendReport;
      } catch {
        return reply.status(500).send({
          data: null,
          error: 'Failed to parse spend-report.json',
          meta: {
            cycleId,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.send({
        data: report,
        meta: {
          cycleId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
