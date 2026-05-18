import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Daily rollup types (exported for tests)
// ---------------------------------------------------------------------------

export interface DailyRollupByModel {
  opus: number;
  sonnet: number;
  haiku: number;
}

export interface DailyRollupItem {
  date: string;
  totalUsd: number;
  byModel: DailyRollupByModel;
  byTag?: Record<string, number>;
}

export interface DailyRollupsResponse {
  data: DailyRollupItem[];
  meta: { days: number; timestamp: string };
}

// ---------------------------------------------------------------------------
// Options type (exported for tests and index.ts)
// ---------------------------------------------------------------------------

export interface CostsOptions {
  adapter: WorkspaceAdapter;
  /** Project root used to locate `.agentforge/cycles/`. Defaults to cwd. */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Model tier classifier — maps model string → opus | sonnet | haiku
// ---------------------------------------------------------------------------

function classifyModel(model: string): keyof DailyRollupByModel {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet'; // default — covers sonnet, claude-3, unknown, etc.
}

// ---------------------------------------------------------------------------
// JSON-ledger cost accumulation
// ---------------------------------------------------------------------------

interface LedgerCostRow {
  /** ISO date string (YYYY-MM-DD) — sourced from cycle completedAt */
  date: string;
  totalUsd: number;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Read cost data from the cycle.json ledger in `.agentforge/cycles/`.
 *
 * For each cycle directory we read:
 *   - `cycle.json`   → cost.totalUsd, cost.byAgent, cost.byPhase, completedAt
 *   - `phases/execute.json` → agentRuns[].model for model attribution
 *
 * Returns an array of per-cycle cost rows ready to be unioned with SQL rows.
 */
function readCostsFromJsonLedger(projectRoot: string): LedgerCostRow[] {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(cyclesDir);
  } catch {
    return [];
  }

  const rows: LedgerCostRow[] = [];

  for (const id of entries) {
    const cyclePath = join(cyclesDir, id, 'cycle.json');
    if (!existsSync(cyclePath)) continue;

    let cycle: Record<string, unknown>;
    try {
      cycle = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const costObj = cycle.cost as { totalUsd?: number; byAgent?: Record<string, number> } | undefined;
    const totalUsd = costObj?.totalUsd ?? 0;
    if (totalUsd <= 0) continue;

    // Reference date: prefer completedAt, fall back to startedAt, then mtime.
    const completedAt = cycle.completedAt as string | undefined;
    const startedAt = cycle.startedAt as string | undefined;
    let refDate: string;
    if (completedAt && completedAt.length >= 10) {
      refDate = completedAt.slice(0, 10);
    } else if (startedAt && startedAt.length >= 10) {
      refDate = startedAt.slice(0, 10);
    } else {
      try {
        refDate = new Date(statSync(cyclePath).mtimeMs).toISOString().slice(0, 10);
      } catch {
        continue;
      }
    }

    // Model attribution from execute.json agentRuns / itemResults.
    const byModel: Record<string, number> = {};
    const execPath = join(cyclesDir, id, 'phases', 'execute.json');
    if (existsSync(execPath)) {
      try {
        const exec = JSON.parse(readFileSync(execPath, 'utf8')) as {
          agentRuns?: Array<{ model?: string; costUsd?: number }>;
          itemResults?: Array<{ model?: string; costUsd?: number }>;
        };
        const runs = exec.agentRuns ?? exec.itemResults ?? [];
        for (const run of runs) {
          if (typeof run.model === 'string' && run.model.length > 0) {
            const tier = classifyModel(run.model);
            byModel[tier] = (byModel[tier] ?? 0) + (run.costUsd ?? 0);
          }
        }
      } catch {
        // Non-fatal — byModel stays empty for this cycle.
      }
    }

    rows.push({
      date: refDate,
      totalUsd,
      byModel,
      // cycle.json doesn't carry token counts; leave as 0 for ledger rows.
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function costsRoutes(
  app: FastifyInstance,
  opts: CostsOptions,
): Promise<void> {
  const { adapter, projectRoot = process.cwd() } = opts;

  /** Summary — per-model totals + daily rollups + token breakdown.
   *
   * Data path: UNION of cycle.json ledger (authoritative for `agentforge cycle
   * run`) and adapter.getAllCosts() SQL rows (in-server executor path). Neither
   * source silently loses data.
   *
   * Supports optional `?since=<ISO_date>` query parameter that filters costs to
   * only those recorded on or after that timestamp.
   */
  app.get('/api/v5/costs/summary', async (req, reply) => {
    const q = req.query as { since?: string };

    // Validate since if provided — must be a parseable ISO date string.
    let sinceIso: string | null = null;
    if (q.since !== undefined && q.since.length > 0) {
      const parsed = new Date(q.since);
      if (isNaN(parsed.getTime())) {
        return reply.status(400).send({ error: 'Invalid since parameter: must be an ISO date string' });
      }
      sinceIso = parsed.toISOString();
    }

    // ── SQL rows (in-server executor path) ──────────────────────────────────
    const allSqlCosts = adapter.getAllCosts();
    const sqlCosts = sinceIso !== null
      ? allSqlCosts.filter((c) => (c.created_at ?? '') >= sinceIso!)
      : allSqlCosts;

    // ── JSON ledger rows (cycle-runner path) ────────────────────────────────
    const ledgerRows = readCostsFromJsonLedger(projectRoot);
    // Apply since filter to ledger rows using the row's date (YYYY-MM-DD prefix).
    const sinceDate = sinceIso !== null ? sinceIso.slice(0, 10) : null;
    const filteredLedger = sinceDate !== null
      ? ledgerRows.filter((r) => r.date >= sinceDate)
      : ledgerRows;

    // ── UNION: accumulate combined totals ───────────────────────────────────
    let totalCostUsd = 0;

    // Per-model aggregation: keyed by canonical model name (SQL) or tier (ledger).
    const byModelMap: Record<string, { costUsd: number; sessions: number; inputTokens: number; outputTokens: number }> = {};

    // SQL rows contribute exact model names.
    for (const c of sqlCosts) {
      const key = c.model ?? 'unknown';
      if (!byModelMap[key]) byModelMap[key] = { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
      byModelMap[key]!.costUsd += c.cost_usd ?? 0;
      byModelMap[key]!.sessions += 1;
      byModelMap[key]!.inputTokens += c.input_tokens ?? 0;
      byModelMap[key]!.outputTokens += c.output_tokens ?? 0;
      totalCostUsd += c.cost_usd ?? 0;
    }

    // Ledger rows contribute tier-level attributions.
    for (const row of filteredLedger) {
      totalCostUsd += row.totalUsd;

      // Distribute attributed model cost; remainder goes to 'sonnet' (default tier).
      let attributed = 0;
      for (const [tier, amt] of Object.entries(row.byModel)) {
        if (amt > 0) {
          if (!byModelMap[tier]) byModelMap[tier] = { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
          byModelMap[tier]!.costUsd += amt;
          byModelMap[tier]!.sessions += 1;
          attributed += amt;
        }
      }
      const remainder = row.totalUsd - attributed;
      if (remainder > 0.000001) {
        const fallback = 'sonnet';
        if (!byModelMap[fallback]) byModelMap[fallback] = { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
        byModelMap[fallback]!.costUsd += remainder;
        byModelMap[fallback]!.sessions += 1;
      }
    }

    // Total session count = SQL row count + one session per ledger row.
    const totalSessions = sqlCosts.length + filteredLedger.length;

    // ── Daily rollups: UNION both sources ────────────────────────────────────
    const byDay: Record<string, { costUsd: number; sessions: number }> = {};

    for (const c of sqlCosts) {
      const day = (c.created_at ?? '').slice(0, 10) || 'unknown';
      if (!byDay[day]) byDay[day] = { costUsd: 0, sessions: 0 };
      byDay[day]!.costUsd += c.cost_usd ?? 0;
      byDay[day]!.sessions += 1;
    }

    for (const row of filteredLedger) {
      const day = row.date;
      if (!byDay[day]) byDay[day] = { costUsd: 0, sessions: 0 };
      byDay[day]!.costUsd += row.totalUsd;
      byDay[day]!.sessions += 1;
    }

    const dailyRollups = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, ...d }));

    return reply.send({
      data: {
        totalCostUsd,
        totalSessions,
        byModel: Object.entries(byModelMap).map(([model, d]) => ({ model, ...d })),
        dailyRollups,
      },
      meta: {
        workspaceId: opts.adapter.workspaceId,
        since: sinceIso,
        timestamp: new Date().toISOString(),
      },
    });
  });

  /**
   * GET /api/v5/costs/daily-rollups
   *
   * Returns daily aggregated cost totals for the last N days (default 30, max 365).
   * Used by the /cost dashboard page for its 30-day sparkline.
   *
   * Query params:
   *   ?days=N   Number of days to look back (default 30, max 365)
   *
   * Response shape:
   *   {
   *     data: Array<{
   *       date: string (YYYY-MM-DD),
   *       totalUsd: number,
   *       byModel: { opus: number, sonnet: number, haiku: number },
   *     }>,
   *     meta: { days: number, timestamp: string }
   *   }
   */
  app.get('/api/v5/costs/daily-rollups', async (req, reply) => {
    const q = req.query as { days?: string };

    // Validate days parameter
    let days = 30;
    if (q.days !== undefined && q.days.length > 0) {
      const parsed = parseInt(q.days, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return reply.status(400).send({ error: 'Invalid days parameter: must be a positive integer' });
      }
      if (parsed > 365) {
        return reply.status(400).send({ error: 'Invalid days parameter: maximum is 365' });
      }
      days = parsed;
    }

    // Compute the cutoff date (N days ago at midnight UTC)
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    cutoff.setUTCHours(0, 0, 0, 0);
    const cutoffIso = cutoff.toISOString();

    const allCosts = opts.adapter.getAllCosts();

    // Filter to the requested window
    const costs = allCosts.filter((c) => (c.created_at ?? '') >= cutoffIso);

    // Group by date (YYYY-MM-DD prefix of created_at)
    const byDay = new Map<string, DailyRollupItem>();

    for (const c of costs) {
      const date = (c.created_at ?? '').slice(0, 10);
      if (!date || date === '') continue;

      if (!byDay.has(date)) {
        byDay.set(date, {
          date,
          totalUsd: 0,
          byModel: { opus: 0, sonnet: 0, haiku: 0 },
        });
      }

      const entry = byDay.get(date)!;
      const costUsd = c.cost_usd ?? 0;
      entry.totalUsd += costUsd;

      const tier = classifyModel(c.model ?? '');
      entry.byModel[tier] += costUsd;
    }

    // Sort by date ascending and return
    const data = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    const response: DailyRollupsResponse = {
      data,
      meta: {
        days,
        timestamp: new Date().toISOString(),
      },
    };

    return reply.send(response);
  });
}
