import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SystemLoad = 'idle' | 'busy' | 'overloaded';

export interface CountersResponse {
  /** Count of git_branches rows in an active/open state. */
  openBranches: number;
  /** Count of approvals rows where status = 'pending'. */
  pendingApprovals: number;
  /** Count of runtime_jobs rows where status = 'running'. */
  runningCycles: number;
  /** Sum of costs.cost_usd where the record was created today (server local time). */
  todaySpendUsd: number;
  /** Sum of costs.cost_usd created within the last 7 days. */
  weekSpendUsd: number;
  /** Count of distinct agent_ids with at least one session started in the last hour. */
  agentsActive: number;
  /** idle when runningCycles===0; overloaded when runningCycles>=3; busy otherwise. */
  load: SystemLoad;
  /** ISO 8601 timestamp of when this payload was computed. */
  timestamp: string;
}

export interface CountersOptions {
  adapter: WorkspaceAdapter;
}

// ---------------------------------------------------------------------------
// Module-level 5-second cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  ts: number;
  value: CountersResponse;
}

const CACHE_TTL_MS = 5_000;

// Exported for test reset
export let _cache: CacheEntry | null = null;
export function _resetCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the local-date boundary strings for today and 7 days ago, expressed
 * as ISO 8601 UTC timestamps that SQLite's TEXT comparisons will honour.
 *
 * SQLite stores our timestamps as ISO 8601 strings (e.g. "2026-05-15T10:30:00.000Z").
 * We need "start of today in local time" expressed as a UTC ISO string so that
 * the WHERE clause `created_at >= ?` is correct for the server's timezone.
 */
function getWindowBoundaries(): { todayStart: string; weekStart: string } {
  const now = new Date();
  // Midnight today in local time
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  // 7 days ago at midnight local time
  const weekLocal = new Date(todayLocal.getTime() - 6 * 24 * 60 * 60 * 1000);

  return {
    todayStart: todayLocal.toISOString(),
    weekStart: weekLocal.toISOString(),
  };
}

function deriveLoad(runningCycles: number): SystemLoad {
  if (runningCycles === 0) return 'idle';
  if (runningCycles >= 3) return 'overloaded';
  return 'busy';
}

// ---------------------------------------------------------------------------
// Counter computation (runs against the raw SQLite DB for speed)
// ---------------------------------------------------------------------------

function computeCounters(adapter: WorkspaceAdapter): CountersResponse {
  const db = adapter.getRawDb();
  const { todayStart, weekStart } = getWindowBoundaries();

  // Open branches — any git_branch not in a terminal state
  const openBranchesRow = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM git_branches WHERE status NOT IN ('merged', 'deleted', 'closed')",
    )
    .get();
  const openBranches = openBranchesRow?.n ?? 0;

  // Pending approvals
  const pendingApprovalsRow = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'",
    )
    .get();
  const pendingApprovals = pendingApprovalsRow?.n ?? 0;

  // Running cycles (runtime_jobs with status = 'running')
  const runningCyclesRow = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM runtime_jobs WHERE status = 'running'",
    )
    .get();
  const runningCycles = runningCyclesRow?.n ?? 0;

  // Today spend
  const todaySpendRow = db
    .prepare<[string], { total: number | null }>(
      'SELECT SUM(cost_usd) AS total FROM costs WHERE created_at >= ?',
    )
    .get(todayStart);
  const todaySpendUsd = todaySpendRow?.total ?? 0;

  // Week spend
  const weekSpendRow = db
    .prepare<[string], { total: number | null }>(
      'SELECT SUM(cost_usd) AS total FROM costs WHERE created_at >= ?',
    )
    .get(weekStart);
  const weekSpendUsd = weekSpendRow?.total ?? 0;

  // Active agents — distinct agent_ids with a session started in the last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const agentsActiveRow = db
    .prepare<[string], { n: number }>(
      'SELECT COUNT(DISTINCT agent_id) AS n FROM sessions WHERE started_at >= ?',
    )
    .get(oneHourAgo);
  const agentsActive = agentsActiveRow?.n ?? 0;

  const timestamp = new Date().toISOString();

  return {
    openBranches,
    pendingApprovals,
    runningCycles,
    todaySpendUsd,
    weekSpendUsd,
    agentsActive,
    load: deriveLoad(runningCycles),
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function countersRoutes(
  app: FastifyInstance,
  opts: CountersOptions,
): Promise<void> {
  const { adapter } = opts;

  /**
   * GET /api/v5/counters
   *
   * Returns system-wide counters for the StatusLine widget. Results are cached
   * for 5 seconds so that polling every 5–10 seconds doesn't hammer SQLite.
   */
  app.get('/api/v5/counters', async (_req, reply) => {
    const now = Date.now();
    if (_cache !== null && now - _cache.ts < CACHE_TTL_MS) {
      return reply.send(_cache.value);
    }

    const value = computeCounters(adapter);
    _cache = { ts: now, value };
    return reply.send(value);
  });
}
