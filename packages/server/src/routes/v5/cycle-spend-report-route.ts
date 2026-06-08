/**
 * cycle-spend-report-route.ts — GET /api/v5/cycles/:id/spend-report
 *
 * Serves the SpendReportArtifact for a completed objective run.
 * Reads `.agentforge/cycles/<id>/spend-report.json` and returns it as-is.
 *
 * Response shape on 200:
 *   { data: SpendReportArtifact, meta: { cycleId, timestamp } }
 *
 * Error responses:
 *   400 — invalid cycleId (unsafe characters)
 *   404 — cycle directory or spend-report.json not found
 *   500 — spend-report.json is corrupt / unparseable
 *
 * Consumer: dashboard Spend tab (child-16).
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { SpendReportArtifact } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface CycleSpendReportOpts {
  /** Absolute path to the project root containing `.agentforge/`. Defaults to `process.cwd()`. */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in cycleId.
 *  Match-then-use pattern so the analyser can prove path-injection safety. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

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
   * Returns the SpendReportArtifact stored at
   * `.agentforge/cycles/<id>/spend-report.json`.
   *
   * 404 when either the cycle directory or the artifact file is absent,
   * so the dashboard Spend tab can distinguish "cycle not found" from
   * "spend report not yet generated".
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/spend-report',
    async (req, reply) => {
      const rawId = req.params.id;

      // Match-then-use: `safeCycleId` is provably composed only of characters
      // that cannot encode a path traversal (no /, \, .., %, or null bytes).
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
          cycleId: rawId,
        });
      }
      const safeCycleId: string = matched[0];

      // Resolve cycle directory and verify containment.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      // Cycle directory not found → 404.
      if (!existsSync(cycleDir)) {
        return reply.status(404).send({
          error: 'Cycle not found',
          cycleId: safeCycleId,
        });
      }

      // spend-report.json absent → 404 (report not yet produced).
      const reportPath = join(cycleDir, 'spend-report.json');
      if (!existsSync(reportPath)) {
        return reply.status(404).send({
          error: 'Spend report not found',
          cycleId: safeCycleId,
        });
      }

      // Parse the artifact — 500 only on corrupt JSON.
      let report: SpendReportArtifact;
      try {
        const raw = readFileSync(reportPath, 'utf-8');
        report = JSON.parse(raw) as SpendReportArtifact;
      } catch {
        return reply.status(500).send({
          error: 'Failed to parse spend-report.json',
          cycleId: safeCycleId,
        });
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
