/**
 * cycle-epic-review.ts — GET /api/v5/cycles/:id/epic-review
 *
 * Serves `.agentforge/cycles/<id>/phases/epic-review.json` for any cycle that
 * ran the epic-review phase. The verdict card on the cycle-detail page (child-16
 * / child-17) fetches this endpoint.
 *
 * - 400 when :id contains characters outside `[a-zA-Z0-9_-]`
 * - 404 when the cycle directory or the epic-review.json file is absent
 * - 200 with `{ data, meta }` envelope when the file exists
 *
 * Path safety: uses the match-then-use pattern so the CodeQL path-injection
 * analyser can trace the sanitised value from match() to the fs.join() call.
 * The containment check (relative path must not start with `..`) is belt-and-
 * braces — the regex already excludes `/`, `\`, `.`, `%`, and null bytes.
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CycleEpicReviewOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in a cycle id. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /api/v5/cycles/:id/epic-review`.
 *
 * Must be called from BOTH the adapter path (`packages/server/src/routes/v5/index.ts`)
 * and the no-adapter path (`packages/server/src/server.ts`) — child-4 handles
 * the wiring in both places.
 */
export async function cycleEpicReviewRoutes(
  app: FastifyInstance,
  opts: CycleEpicReviewOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/epic-review
   *
   * Returns the epic-review phase verdict from
   * `.agentforge/cycles/<id>/phases/epic-review.json`.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/epic-review',
    async (req, reply) => {
      const rawId = req.params.id;

      // Match-then-use: `safeId` is provably composed of characters that cannot
      // encode a path traversal — `/`, `\`, `..`, `%`, null bytes are all absent.
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycle id — only alphanumeric, dash, and underscore allowed',
          cycleId: rawId,
        });
      }
      const safeId: string = matched[0];

      // Resolve the cycle directory and verify containment (defense in depth).
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeId));

      const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycle id', cycleId: safeId });
      }

      // Cycle directory not found → 404.
      if (!existsSync(cycleDir)) {
        return reply.status(404).send({ error: 'Cycle not found', cycleId: safeId });
      }

      // Resolve the phases sub-directory and epic-review.json.
      const epicReviewPath = resolve(join(cycleDir, 'phases', 'epic-review.json'));

      // Belt-and-braces: confirm the resolved path stays inside the cycle dir.
      const epicRel = relative(cycleDir, epicReviewPath);
      if (epicRel.startsWith('..') || isAbsolute(epicRel)) {
        return reply.status(400).send({ error: 'Invalid file path', cycleId: safeId });
      }

      // epic-review.json absent → 404 (phase not run yet for this cycle).
      if (!existsSync(epicReviewPath)) {
        return reply.status(404).send({
          error: 'Epic-review phase data not found for this cycle',
          cycleId: safeId,
        });
      }

      // Parse and return the file.
      let data: unknown;
      try {
        const raw = readFileSync(epicReviewPath, 'utf-8');
        data = JSON.parse(raw);
      } catch {
        return reply.status(500).send({
          error: 'Failed to parse epic-review.json',
          cycleId: safeId,
        });
      }

      return reply.send({
        data,
        meta: {
          cycleId: safeId,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
