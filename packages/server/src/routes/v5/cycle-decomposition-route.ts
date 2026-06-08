/**
 * cycle-decomposition-route.ts — GET /api/v5/cycles/:id/decomposition
 *
 * Reads `.agentforge/cycles/<id>/decomposition.json` and returns its
 * contents as a `DecompositionArtifact[]` array wrapped in `{ data, meta }`.
 *
 * Returns a JSON 404 body when the file is absent — the dashboard Epic tab
 * (child-15) uses this endpoint to decide whether to render the decomposition
 * view for a given cycle.
 *
 * Security:
 *   - cycleId validated against SAFE_CYCLE_ID (`/^[a-zA-Z0-9_-]+$/`)
 *   - Resolved path must remain under the cycles base directory
 *     (match-then-use pattern so CodeQL can trace a sanitised value)
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DecompositionArtifact } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CycleDecompositionOpts {
  projectRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in cycleId. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]{1,200}$/;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function cycleDecompositionRoutes(
  app: FastifyInstance,
  opts: CycleDecompositionOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/decomposition
   *
   * Returns the parsed `DecompositionArtifact[]` from decomposition.json.
   * Responds 404 (with a JSON body) when the file is absent.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/decomposition',
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

      // Resolve and containment-check the cycle directory path.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      // Return 404 when decomposition.json is absent (may mean cycle not yet
      // decomposed or an older cycle that pre-dates objective mode).
      const decompositionPath = join(cycleDir, 'decomposition.json');
      if (!existsSync(decompositionPath)) {
        return reply.status(404).send({
          error: 'Decomposition not found',
          cycleId: safeCycleId,
        });
      }

      // Parse the file — return 500 only on truly corrupt JSON.
      let waves: DecompositionArtifact[];
      try {
        const raw = readFileSync(decompositionPath, 'utf-8');
        waves = JSON.parse(raw) as DecompositionArtifact[];
      } catch {
        return reply.status(500).send({
          error: 'Failed to parse decomposition.json',
          cycleId: safeCycleId,
        });
      }

      return reply.send({
        data: waves,
        meta: {
          cycleId: safeCycleId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
