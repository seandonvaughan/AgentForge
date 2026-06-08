/**
 * cycle-epic-review-route.ts — GET /api/v5/cycles/:id/epic-review
 *
 * Reads the EpicReviewArtifact from
 *   .agentforge/cycles/<id>/phases/epic-review.json
 * and returns it inside a `{ data, meta }` envelope.
 *
 * Returns a structured JSON 404 when the file is absent so that the
 * cycle-detail header verdict card (child-17) can handle the "not yet
 * available" state gracefully.
 *
 * Security:
 *   - cycleId validated against SAFE_CYCLE_ID before any filesystem access
 *   - path-containment check ensures resolution stays under cyclesBaseDir
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { EpicReviewArtifact } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CycleEpicReviewOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in cycleId. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function cycleEpicReviewRoutes(
  app: FastifyInstance,
  opts: CycleEpicReviewOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/epic-review
   *
   * Returns the EpicReviewArtifact written by the review phase.
   * 404 when the file has not yet been produced.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/epic-review',
    async (req, reply) => {
      const rawId = req.params.id;

      // Match-then-use: give the static analyser a sanitised binding to trace.
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
          cycleId: rawId,
        });
      }
      const safeCycleId: string = matched[0];

      // Path-containment check.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      const artifactPath = join(cycleDir, 'phases', 'epic-review.json');

      if (!existsSync(artifactPath)) {
        return reply.status(404).send({
          error: 'Epic review artifact not found',
          cycleId: safeCycleId,
          path: 'phases/epic-review.json',
        });
      }

      let artifact: EpicReviewArtifact;
      try {
        const raw = readFileSync(artifactPath, 'utf-8');
        artifact = JSON.parse(raw) as EpicReviewArtifact;
      } catch {
        return reply.status(500).send({
          error: 'Failed to parse epic-review.json',
          cycleId: safeCycleId,
        });
      }

      return reply.send({
        data: artifact,
        meta: {
          cycleId: safeCycleId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
