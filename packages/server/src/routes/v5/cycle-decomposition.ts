/**
 * cycle-decomposition.ts — GET /api/v5/cycles/:id/decomposition
 *
 * Returns the parsed decomposition.json artifact for a given cycle.
 *
 * Response: { data: <decomposition JSON>, meta: { cycleId, timestamp } }
 * Errors:
 *   400 — cycleId contains unsafe characters
 *   404 — decomposition.json not found for the given cycleId
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeJoin } from '../../lib/safe-join.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CycleDecompositionOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Safe id pattern — alphanumeric, dash, underscore only (match-then-use)
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function cycleDecompositionRoutes(
  app: FastifyInstance,
  opts: CycleDecompositionOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/decomposition
   *
   * Reads .agentforge/cycles/<id>/decomposition.json and returns it as-is.
   * Uses match-then-use on the id param (never regex on raw user input past
   * the validation step) and safeJoin for path containment.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/decomposition',
    async (req, reply) => {
      const rawId = req.params.id;

      // match-then-use: capture the safe id from the match result
      const matched = rawId.match(SAFE_ID_RE);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
        });
      }
      const safeId: string = matched[0];

      const cyclesDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = safeJoin(cyclesDir, safeId);
      if (!cycleDir) {
        return reply.status(400).send({ error: 'Invalid cycleId' });
      }

      const decompositionPath = join(cycleDir, 'decomposition.json');
      if (!existsSync(decompositionPath)) {
        return reply.status(404).send({ error: 'decomposition not found' });
      }

      let parsed: unknown;
      try {
        const raw = readFileSync(decompositionPath, 'utf-8');
        parsed = JSON.parse(raw);
      } catch {
        return reply.status(500).send({ error: 'Failed to parse decomposition.json' });
      }

      return reply.send({
        data: parsed,
        meta: {
          cycleId: safeId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
