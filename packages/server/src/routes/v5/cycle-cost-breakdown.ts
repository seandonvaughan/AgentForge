/**
 * cycle-cost-breakdown.ts — GET /api/v5/cycles/:id/cost-breakdown
 *
 * Returns the merged CostBreakdown from cycle.json for any cycle that carries
 * the field. For older cycles that only have a flat cost object, it synthesises
 * a compatible shape with everything in inputTokens and never errors.
 *
 * Response shape (CostBreakdown):
 *   { inputTokens, outputTokens, cacheCreation, cacheRead, toolUse, totalUsd }
 *
 * Meta flags:
 *   hasBreakdown — true when the cycle.json already contained a breakdown field
 *   cycleId      — the sanitised id
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  inputTokens:   { count: number; usd: number };
  outputTokens:  { count: number; usd: number };
  cacheCreation: { tokens: number; usd: number };
  cacheRead:     { tokens: number; usd: number };
  toolUse:       Record<string, { invocations: number; usd: number }>;
  totalUsd:      number;
}

export interface CostBreakdownResponse {
  cycleId:      string;
  hasBreakdown: boolean;
  breakdown:    CostBreakdown;
  timestamp:    string;
}

export interface CycleCostBreakdownOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only alphanumeric, dash, and underscore characters in cycleId. */
const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Build a zero CostBreakdown with optional totalUsd.
 * Used as a fallback for cycles that pre-date per-token accounting.
 */
function zeroCostBreakdown(totalUsd = 0): CostBreakdown {
  return {
    inputTokens:   { count: 0, usd: totalUsd },
    outputTokens:  { count: 0, usd: 0 },
    cacheCreation: { tokens: 0, usd: 0 },
    cacheRead:     { tokens: 0, usd: 0 },
    toolUse:       {},
    totalUsd,
  };
}

/**
 * Validate and normalise a raw unknown value into a CostBreakdown.
 * Returns null if the value is not a well-formed breakdown object.
 */
function normaliseCostBreakdown(raw: unknown): CostBreakdown | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Must have at minimum a numeric totalUsd field.
  if (typeof r['totalUsd'] !== 'number') return null;

  const safe = (field: unknown, key: string, valKey: string): number => {
    if (field === null || typeof field !== 'object') return 0;
    const f = field as Record<string, unknown>;
    const v = f[valKey];
    if (key === 'toolUse') return 0; // handled separately
    return typeof v === 'number' ? v : 0;
  };

  const toolUseRaw = r['toolUse'];
  const toolUse: Record<string, { invocations: number; usd: number }> = {};
  if (toolUseRaw !== null && typeof toolUseRaw === 'object') {
    for (const [k, v] of Object.entries(toolUseRaw as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        const entry = v as Record<string, unknown>;
        toolUse[k] = {
          invocations: typeof entry['invocations'] === 'number' ? entry['invocations'] : 0,
          usd:         typeof entry['usd']         === 'number' ? entry['usd']         : 0,
        };
      }
    }
  }

  const inp = r['inputTokens'];
  const out = r['outputTokens'];
  const cc  = r['cacheCreation'];
  const cr  = r['cacheRead'];

  return {
    inputTokens:   { count: safe(inp, 'inputTokens',   'count'),  usd: safe(inp, 'inputTokens',   'usd') },
    outputTokens:  { count: safe(out, 'outputTokens',  'count'),  usd: safe(out, 'outputTokens',  'usd') },
    cacheCreation: { tokens: safe(cc, 'cacheCreation', 'tokens'), usd: safe(cc,  'cacheCreation', 'usd') },
    cacheRead:     { tokens: safe(cr, 'cacheRead',     'tokens'), usd: safe(cr,  'cacheRead',     'usd') },
    toolUse,
    totalUsd: r['totalUsd'] as number,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function cycleCostBreakdownRoutes(
  app: FastifyInstance,
  opts: CycleCostBreakdownOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  /**
   * GET /api/v5/cycles/:id/cost-breakdown
   *
   * Returns the CostBreakdown from cycle.json. Falls back to a legacy
   * synthetic shape for older cycles. Never returns an error for missing
   * breakdown data.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/cost-breakdown',
    async (req, reply) => {
      const rawId = req.params.id;

      // Match-then-use pattern: capture the sanitised id so the analyser can
      // verify only safe characters reach the filesystem join below.
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
          cycleId: rawId,
        });
      }
      const safeCycleId: string = matched[0];

      // Resolve the cycle directory with path containment check.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      const baseWithSep = cyclesBaseDir.endsWith('/') ? cyclesBaseDir : cyclesBaseDir + '/';
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      // Cycle directory not found → 404.
      if (!existsSync(cycleDir)) {
        return reply.status(404).send({ error: 'Cycle not found', cycleId: safeCycleId });
      }

      // cycle.json missing → return a zero breakdown (cycle may still be running).
      const cycleJsonPath = join(cycleDir, 'cycle.json');
      if (!existsSync(cycleJsonPath)) {
        const response: CostBreakdownResponse = {
          cycleId: safeCycleId,
          hasBreakdown: false,
          breakdown: zeroCostBreakdown(0),
          timestamp: new Date().toISOString(),
        };
        return reply.send(response);
      }

      // Parse cycle.json — return 500 only on truly corrupt JSON.
      let cycleData: Record<string, unknown>;
      try {
        const raw = readFileSync(cycleJsonPath, 'utf-8');
        cycleData = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return reply.status(500).send({ error: 'Failed to parse cycle.json', cycleId: safeCycleId });
      }

      // Extract cost object.
      const cost = (cycleData['cost'] ?? {}) as Record<string, unknown>;

      // Attempt to read breakdown from cost.breakdown.
      const breakdownRaw = cost['breakdown'] ?? null;
      const normBreakdown = normaliseCostBreakdown(breakdownRaw);

      if (normBreakdown !== null) {
        const response: CostBreakdownResponse = {
          cycleId: safeCycleId,
          hasBreakdown: true,
          breakdown: normBreakdown,
          timestamp: new Date().toISOString(),
        };
        return reply.send(response);
      }

      // Legacy fallback: synthesise from flat totalUsd.
      const totalUsd = typeof cost['totalUsd'] === 'number' ? cost['totalUsd'] : 0;
      const response: CostBreakdownResponse = {
        cycleId: safeCycleId,
        hasBreakdown: false,
        breakdown: zeroCostBreakdown(totalUsd),
        timestamp: new Date().toISOString(),
      };
      return reply.send(response);
    },
  );
}
