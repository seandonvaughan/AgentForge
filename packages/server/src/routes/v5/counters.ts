import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// Authoritative cycle data lives in `.agentforge/cycles/<id>/cycle.json` —
// not in the SQLite tables that the original implementation read. The
// cycle-runner writes cycle.json on every phase boundary (via flushCycleCost),
// every 30s heartbeat, and the terminal stage transition. The SQL tables
// (runtime_jobs, costs, sessions) are populated by an in-process executor
// that is NOT used by `agentforge cycle run` today — they accumulate stale
// "running" rows and the `costs` table hasn't been written to in months.
// We compute counters directly from the JSON ledger to give operators real
// data; the SQL-based source is reserved for the in-server executor path
// when it's used (and gets unioned with JSON data below).

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SystemLoad = 'idle' | 'busy' | 'overloaded';

export interface CountersResponse {
  /** Count of git_branches rows in an active/open state. */
  openBranches: number;
  /** Count of approvals rows where status = 'pending'. */
  pendingApprovals: number;
  /** Non-terminal cycle ledger entries with a fresh heartbeat (<5min). */
  runningCycles: number;
  /** Sum of cycle.json cost.totalUsd within today (server local time). */
  todaySpendUsd: number;
  /** Sum of cycle.json cost.totalUsd within last 7 days. */
  weekSpendUsd: number;
  /** Sum of cycle.json cost.totalUsd within last 30 days. */
  monthSpendUsd: number;
  /** Total agents in the team (`.agentforge/agents/*.yaml`). */
  agentsTotal: number;
  /** Distinct agentIds across cycles completed in last hour OR currently running. */
  agentsActive: number;
  /** Count of cycles started in last 24h. */
  cyclesDay: number;
  /** Count of cycles started in last 7 days. */
  cyclesWeek: number;
  /** Count of cycles started in last 30 days. */
  cyclesMonth: number;
  /** idle when runningCycles===0; overloaded when runningCycles>=3; busy otherwise. */
  load: SystemLoad;
  /** Count of registered `.agentforge/worktrees/agent-*` git worktrees with mtime within last 30 min. */
  runningWorktrees: number;
  /** ISO 8601 timestamp of when this payload was computed. */
  timestamp: string;
}

export interface CountersOptions {
  adapter: WorkspaceAdapter;
  /** Project root used to locate `.agentforge/cycles/`. Defaults to cwd. */
  projectRoot?: string;
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

/**
 * Read counters from the cycle.json ledger in `.agentforge/cycles/`. This is
 * the authoritative source — cycle-runner writes here on every phase boundary
 * and every 30s heartbeat. See post-mortem in
 * memory/project_cycle_db9c145f_post_mortem.md.
 */
interface JsonLedgerCounts {
  runningCycles: number;
  todaySpendUsd: number;
  weekSpendUsd: number;
  monthSpendUsd: number;
  activeAgentIds: Set<string>;
  cyclesDay: number;
  cyclesWeek: number;
  cyclesMonth: number;
}

const RUNNING_FRESHNESS_MS = 5 * 60 * 1000;

function computeCountersFromJsonLedger(projectRoot: string): JsonLedgerCounts {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  const empty: JsonLedgerCounts = {
    runningCycles: 0, todaySpendUsd: 0, weekSpendUsd: 0, monthSpendUsd: 0,
    activeAgentIds: new Set(), cyclesDay: 0, cyclesWeek: 0, cyclesMonth: 0,
  };
  if (!existsSync(cyclesDir)) return empty;
  const { todayStart, weekStart } = getWindowBoundaries();
  const todayStartMs = new Date(todayStart).getTime();
  const weekStartMs = new Date(weekStart).getTime();
  const monthStartMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const dayWindowMs = 24 * 60 * 60 * 1000;
  const heartbeatMaxAgeMs = RUNNING_FRESHNESS_MS;   // STALL_MS from dashboard
  const agentsActiveWindowMs = 60 * 60 * 1000;      // last hour

  let runningCycles = 0;
  let todaySpendUsd = 0;
  let weekSpendUsd = 0;
  let monthSpendUsd = 0;
  let cyclesDay = 0;
  let cyclesWeek = 0;
  let cyclesMonth = 0;
  const recentAgentIds = new Set<string>();
  const now = Date.now();

  let entries: string[];
  try {
    entries = readdirSync(cyclesDir);
  } catch {
    return empty;
  }

  for (const id of entries) {
    const cyclePath = join(cyclesDir, id, 'cycle.json');
    if (!existsSync(cyclePath)) continue;
    let cycle: Record<string, unknown>;
    try {
      cycle = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
    } catch { continue; }

    // Running = non-terminal cycle with a fresh heartbeat. During early
    // planning/audit windows the heartbeat can exist before a stage is written.
    const stage = (cycle.stage as string | undefined)?.toLowerCase();
    const isTerminal = stage !== undefined &&
      ['completed', 'failed', 'killed', 'crashed', 'aborted'].includes(stage);
    const hbMs = parseTimestampMs(cycle.lastHeartbeatAt as string | undefined);
    const hasFreshHeartbeat = hbMs !== null && now - hbMs < heartbeatMaxAgeMs;
    if (!isTerminal && hasFreshHeartbeat) runningCycles++;

    // Reference timestamp: prefer startedAt for "cycle in window", completedAt
    // for "spend on this date". Fall back to file mtime when those are missing.
    const startedAt = cycle.startedAt as string | undefined;
    const completedAt = cycle.completedAt as string | undefined;
    let cycleTsMs: number | null = null;
    if (startedAt) cycleTsMs = new Date(startedAt).getTime();
    else if (completedAt) cycleTsMs = new Date(completedAt).getTime();
    else {
      try { cycleTsMs = statSync(cyclePath).mtimeMs; } catch { cycleTsMs = null; }
    }

    if (cycleTsMs !== null) {
      if (now - cycleTsMs < dayWindowMs) cyclesDay++;
      if (cycleTsMs >= weekStartMs) cyclesWeek++;
      if (cycleTsMs >= monthStartMs) cyclesMonth++;
    }

    // Spend by window — uses completedAt when present (spend "happened" at
    // completion), else startedAt, else file mtime.
    const cost = (cycle.cost as { totalUsd?: number } | undefined)?.totalUsd ?? 0;
    if (cost > 0) {
      const spendRefMs = completedAt
        ? new Date(completedAt).getTime()
        : cycleTsMs;
      if (spendRefMs !== null) {
        if (spendRefMs >= todayStartMs) todaySpendUsd += cost;
        if (spendRefMs >= weekStartMs) weekSpendUsd += cost;
        if (spendRefMs >= monthStartMs) monthSpendUsd += cost;
      }
    }

    // Agents active — read execute.json agentRuns from this cycle if
    // the cycle completed in the last hour OR is still running.
    let activeRefMs: number | null = null;
    if (completedAt) {
      activeRefMs = new Date(completedAt).getTime();
    } else if (isTerminal) {
      try { activeRefMs = statSync(cyclePath).mtimeMs; } catch { activeRefMs = null; }
    }
    const recent = activeRefMs !== null && now - activeRefMs < agentsActiveWindowMs;
    if (recent || (!isTerminal && hasFreshHeartbeat)) {
      const execPath = join(cyclesDir, id, 'phases', 'execute.json');
      if (existsSync(execPath)) {
        try {
          const exec = JSON.parse(readFileSync(execPath, 'utf8')) as {
            agentRuns?: Array<{ agentId?: string }>;
          };
          for (const r of exec.agentRuns ?? []) {
            if (r.agentId) recentAgentIds.add(r.agentId);
          }
        } catch { /* skip */ }
      }
    }
  }

  return {
    runningCycles,
    todaySpendUsd,
    weekSpendUsd,
    monthSpendUsd,
    activeAgentIds: recentAgentIds,
    cyclesDay,
    cyclesWeek,
    cyclesMonth,
  };
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Count agent YAML files in `.agentforge/agents/`. */
function countTotalAgents(projectRoot: string): number {
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  if (!existsSync(agentsDir)) return 0;
  try {
    return readdirSync(agentsDir).filter((f) => f.endsWith('.yaml')).length;
  } catch {
    return 0;
  }
}

/**
 * Count active registered worktrees in `.agentforge/worktrees/`.
 *
 * A worktree is "running" when Git still lists it, it lives under
 * `.agentforge/worktrees/agent-*`, and its mtime is within the last 30 minutes.
 * Raw directories are not authoritative; completed agent worktrees can leave
 * empty folders behind after `git worktree remove`, and counting those makes
 * the dashboard report phantom running agents.
 */
const WORKTREE_ACTIVE_MS = 30 * 60 * 1000; // 30 minutes

function parseGitWorktreePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((line) => line.length > 0);
}

function canonicalPathForCompare(path: string): string {
  let resolved = resolve(path);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // The entry may have vanished between `git worktree list` and `stat`.
    // Fall back to lexical resolution; the later stat call decides liveness.
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathWithin(childPath: string, parentPath: string): boolean {
  const child = canonicalPathForCompare(childPath);
  const parent = canonicalPathForCompare(parentPath);
  if (child === parent) return true;
  return child.startsWith(`${parent}/`);
}

function countRunningWorktrees(projectRoot: string): number {
  const worktreesDir = resolve(projectRoot, '.agentforge', 'worktrees');
  if (!existsSync(worktreesDir)) return 0;

  let registeredPaths: string[];
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    });
    registeredPaths = parseGitWorktreePaths(output);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - WORKTREE_ACTIVE_MS;
  let count = 0;
  for (const registeredPath of registeredPaths) {
    const resolvedPath = resolve(registeredPath);
    if (!isPathWithin(resolvedPath, worktreesDir)) continue;
    if (!basename(resolvedPath).startsWith('agent-')) continue;
    try {
      const st = statSync(resolvedPath);
      if (st.isDirectory() && st.mtimeMs >= cutoff) count++;
    } catch {
      // Ignore vanished entries
    }
  }
  return count;
}

function computeCounters(adapter: WorkspaceAdapter, projectRoot: string): CountersResponse {
  const db = adapter.getRawDb();
  const { todayStart, weekStart } = getWindowBoundaries();
  const monthStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // SQL-backed counters (still authoritative for these — they're written by
  // the v5 routes, not the cycle-runner): open branches + pending approvals.
  const openBranchesRow = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM git_branches WHERE status NOT IN ('merged', 'deleted', 'closed')",
    )
    .get();
  const openBranches = openBranchesRow?.n ?? 0;

  const pendingApprovalsRow = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'",
    )
    .get();
  const pendingApprovals = pendingApprovalsRow?.n ?? 0;

  // JSON-ledger-backed counters (authoritative for cycle-runner data).
  const fromJson = computeCountersFromJsonLedger(projectRoot);
  const agentsTotal = countTotalAgents(projectRoot);
  const runningWorktrees = countRunningWorktrees(projectRoot);

  const sqlTodaySpend = db
    .prepare<[string], { n: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM costs WHERE created_at >= ?')
    .get(todayStart)?.n ?? 0;
  const sqlWeekSpend = db
    .prepare<[string], { n: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM costs WHERE created_at >= ?')
    .get(weekStart)?.n ?? 0;
  const sqlMonthSpend = db
    .prepare<[string], { n: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM costs WHERE created_at >= ?')
    .get(monthStart)?.n ?? 0;

  const activeAgentRows = db
    .prepare<[string], { agent_id: string }>(
      'SELECT DISTINCT agent_id FROM sessions WHERE started_at >= ?',
    )
    .all(oneHourAgo);
  const activeAgentIds = new Set(fromJson.activeAgentIds);
  for (const row of activeAgentRows) {
    if (row.agent_id) activeAgentIds.add(row.agent_id);
  }
  // SQL runtime_jobs are per-agent/manual job rows, not autonomous cycles.
  // Counting them here makes one parallel cycle look like many running cycles.
  const runningCycles = fromJson.runningCycles;

  return {
    openBranches,
    pendingApprovals,
    runningCycles,
    todaySpendUsd: fromJson.todaySpendUsd + sqlTodaySpend,
    weekSpendUsd: fromJson.weekSpendUsd + sqlWeekSpend,
    monthSpendUsd: fromJson.monthSpendUsd + sqlMonthSpend,
    agentsTotal,
    agentsActive: activeAgentIds.size,
    cyclesDay: fromJson.cyclesDay,
    cyclesWeek: fromJson.cyclesWeek,
    cyclesMonth: fromJson.cyclesMonth,
    load: deriveLoad(runningCycles),
    runningWorktrees,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function countersRoutes(
  app: FastifyInstance,
  opts: CountersOptions,
): Promise<void> {
  const { adapter, projectRoot = process.cwd() } = opts;

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

    const value = computeCounters(adapter, projectRoot);
    _cache = { ts: now, value };
    return reply.send(value);
  });
}
