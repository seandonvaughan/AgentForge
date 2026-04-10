/**
 * Cycles Routes — /api/v5/cycles
 *
 * Exposes the autonomous loop's cycle data stored under
 * .agentforge/cycles/<cycleId>/ and .agentforge/cycles-archived/<cycleId>/.
 *
 * Three endpoints:
 *   GET  /api/v5/cycles                    — list cycles with hasApprovalPending flag
 *   GET  /api/v5/cycles/:id/approval       — fetch approval-pending.json for a cycle
 *   POST /api/v5/cycles/:id/approve        — write approval-decision.json + broadcast SSE
 */

import type { FastifyInstance } from 'fastify';
import type { SseManager } from '../sse/sse-manager.js';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

const CYCLES_DIR          = join(PROJECT_ROOT, '.agentforge/cycles');
const CYCLES_ARCHIVED_DIR = join(PROJECT_ROOT, '.agentforge/cycles-archived');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CycleTestSummary {
  passRate: number;
  passed: number;
  failed: number;
  total: number;
}

interface CycleCostSummary {
  totalUsd: number;
}

interface CycleSummary {
  cycleId: string;
  sprintVersion: string | null;
  stage: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  tests: CycleTestSummary | null;
  cost: CycleCostSummary | null;
  hasApprovalPending: boolean;
  isArchived: boolean;
}

/**
 * Read all cycle directories from a base path and return summaries.
 * Silently skips unreadable or malformed entries.
 */
function readCyclesFromDir(baseDir: string, isArchived: boolean): CycleSummary[] {
  if (!existsSync(baseDir)) return [];

  const results: CycleSummary[] = [];

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cycleId = entry.name;
    const cycleDir = join(baseDir, cycleId);

    try {
      // Parse cycle.json for metadata
      const cycleFile = join(cycleDir, 'cycle.json');
      let cycleJson: Record<string, unknown> = {};
      if (existsSync(cycleFile)) {
        cycleJson = JSON.parse(readFileSync(cycleFile, 'utf-8')) as Record<string, unknown>;
      }

      // A cycle has a pending approval when:
      //   - approval-pending.json exists AND
      //   - approval-decision.json does NOT exist
      const hasPending    = existsSync(join(cycleDir, 'approval-pending.json'));
      const hasDecision   = existsSync(join(cycleDir, 'approval-decision.json'));
      const hasApprovalPending = hasPending && !hasDecision;

      // Extract optional test + cost summaries from cycle.json
      const rawTests = cycleJson.tests as Record<string, unknown> | null | undefined;
      const rawCost  = cycleJson.cost  as Record<string, unknown> | null | undefined;

      const tests: CycleTestSummary | null =
        rawTests && typeof rawTests.passRate === 'number'
          ? {
              passRate: rawTests.passRate as number,
              passed:   typeof rawTests.passed === 'number' ? rawTests.passed   : 0,
              failed:   typeof rawTests.failed === 'number' ? rawTests.failed   : 0,
              total:    typeof rawTests.total  === 'number' ? rawTests.total    : 0,
            }
          : null;

      const cost: CycleCostSummary | null =
        rawCost && typeof rawCost.totalUsd === 'number'
          ? { totalUsd: rawCost.totalUsd as number }
          : null;

      results.push({
        cycleId,
        sprintVersion: (cycleJson.sprintVersion as string | null) ?? null,
        stage:         (cycleJson.stage as string) ?? 'unknown',
        startedAt:     (cycleJson.startedAt as string | null) ?? null,
        completedAt:   (cycleJson.completedAt as string | null) ?? null,
        durationMs:    typeof cycleJson.durationMs === 'number' ? (cycleJson.durationMs as number) : null,
        tests,
        cost,
        hasApprovalPending,
        isArchived,
      });
    } catch {
      // Skip unparseable cycle directories
    }
  }

  return results;
}

/**
 * Merge active + archived cycles, sort newest-first, cap at limit.
 */
function listCycles(limit: number): CycleSummary[] {
  const active   = readCyclesFromDir(CYCLES_DIR,          false);
  const archived = readCyclesFromDir(CYCLES_ARCHIVED_DIR, true);
  const all = [...active, ...archived];

  // Sort newest-first by startedAt (nulls last)
  all.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta;
  });

  return all.slice(0, limit);
}

/**
 * Resolve the directory for a given cycleId from active or archived dirs.
 * Returns null if not found.
 */
function resolveCycleDir(cycleId: string): string | null {
  const activeDir   = join(CYCLES_DIR,          cycleId);
  const archivedDir = join(CYCLES_ARCHIVED_DIR, cycleId);
  if (existsSync(activeDir))   return activeDir;
  if (existsSync(archivedDir)) return archivedDir;
  return null;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export interface CyclesRoutesOptions {
  sseManager?: SseManager;
}

export async function cyclesRoutes(
  app: FastifyInstance,
  opts: CyclesRoutesOptions
) {
  const { sseManager } = opts;

  // ── GET /api/v5/cycles ────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>('/api/v5/cycles', async (req, reply) => {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
    const cycles = listCycles(limit);
    return reply.send({ cycles, meta: { total: cycles.length } });
  });

  // ── GET /api/v5/cycles/:id/approval ───────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/v5/cycles/:id/approval', async (req, reply) => {
    const { id } = req.params;
    const cycleDir = resolveCycleDir(id);

    if (!cycleDir) {
      return reply.status(404).send({ error: 'Cycle not found', cycleId: id });
    }

    const pendingFile = join(cycleDir, 'approval-pending.json');
    if (!existsSync(pendingFile)) {
      return reply.status(404).send({ error: 'No pending approval for this cycle', cycleId: id });
    }

    try {
      const data = JSON.parse(readFileSync(pendingFile, 'utf-8'));
      return reply.send(data);
    } catch {
      return reply.status(500).send({ error: 'Failed to read approval-pending.json' });
    }
  });

  // ── POST /api/v5/cycles/:id/approve ───────────────────────────────────────
  // Body: { decidedBy: string, approveAll?: boolean, approvedItemIds?: string[], rejectedItemIds?: string[] }
  app.post<{
    Params: { id: string };
    Body: {
      decidedBy?: string;
      approveAll?: boolean;
      approvedItemIds?: string[];
      rejectedItemIds?: string[];
    };
  }>('/api/v5/cycles/:id/approve', async (req, reply) => {
    const { id } = req.params;
    const body   = req.body ?? {};

    const cycleDir = resolveCycleDir(id);
    if (!cycleDir) {
      return reply.status(404).send({ error: 'Cycle not found', cycleId: id });
    }

    const pendingFile  = join(cycleDir, 'approval-pending.json');
    const decisionFile = join(cycleDir, 'approval-decision.json');

    if (!existsSync(pendingFile)) {
      return reply.status(404).send({ error: 'No pending approval for this cycle', cycleId: id });
    }

    // Idempotency guard — don't allow double-decisions
    if (existsSync(decisionFile)) {
      try {
        const existing = JSON.parse(readFileSync(decisionFile, 'utf-8')) as { decision?: string };
        return reply.status(409).send({
          error: 'Decision already recorded',
          decision: existing.decision ?? 'decided',
          cycleId: id,
        });
      } catch {
        return reply.status(409).send({ error: 'Decision already recorded', cycleId: id });
      }
    }

    // Resolve approved / rejected item IDs
    let approvedItemIds: string[] = body.approvedItemIds ?? [];
    let rejectedItemIds: string[] = body.rejectedItemIds ?? [];

    if (body.approveAll) {
      // approveAll = approve all withinBudget items, reject all overflow items
      try {
        const pending = JSON.parse(readFileSync(pendingFile, 'utf-8')) as {
          withinBudget?: { items?: Array<{ itemId?: string }> };
          overflow?:     { items?: Array<{ itemId?: string }> };
        };
        approvedItemIds = (pending.withinBudget?.items ?? [])
          .map(i => i.itemId ?? '')
          .filter(Boolean);
        rejectedItemIds = (pending.overflow?.items ?? [])
          .map(i => i.itemId ?? '')
          .filter(Boolean);
      } catch {
        return reply.status(500).send({ error: 'Failed to read approval-pending.json' });
      }
    }

    // Determine overall decision label
    const decision: string =
      rejectedItemIds.length === 0 && approvedItemIds.length > 0
        ? 'approved'
        : approvedItemIds.length === 0
        ? 'rejected'
        : 'partially_approved';

    const decisionPayload = {
      cycleId:          id,
      decision,
      approvedItemIds,
      rejectedItemIds,
      decidedBy:        body.decidedBy ?? 'dashboard',
      decidedAt:        new Date().toISOString(),
    };

    try {
      // Ensure the directory exists (shouldn't be needed but defensive)
      mkdirSync(cycleDir, { recursive: true });
      writeFileSync(decisionFile, JSON.stringify(decisionPayload, null, 2), 'utf-8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: 'Failed to write approval-decision.json', detail: msg });
    }

    // Broadcast SSE event so all connected dashboards update immediately
    if (sseManager) {
      sseManager.broadcast('cycle_event', {
        cycleId:  id,
        category: 'approval_decided',
        decision,
        decidedBy: decisionPayload.decidedBy,
        decidedAt: decisionPayload.decidedAt,
      });
    }

    return reply.send({ ok: true, cycleId: id, decision });
  });
}
