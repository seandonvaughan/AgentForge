/**
 * cycle-prs.ts — GET /api/v5/cycles/:cycleId/prs
 *
 * Reads the MergeQueue ledger at `.agentforge/cycles/<cycleId>/agent-prs.json`
 * and optionally enriches each entry with live CI status via `gh pr checks`.
 *
 * Query params:
 *   ?ci=false  — skip gh-checks enrichment (faster; default true)
 *   ?status=   — filter by PR status ('open' | 'merged' | 'closed' | 'skipped-no-gh' | 'dry-run')
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrStatus = 'open' | 'merged' | 'closed' | 'skipped-no-gh' | 'dry-run';
export type CiBucket = 'pass' | 'fail' | 'pending' | 'unknown';

export interface CiBlock {
  bucket: CiBucket;
  lastCheckedAt: string;
}

/** Shape of one entry in the MergeQueue ledger (`agent-prs.json`). */
export interface LedgerEntry {
  prNumber: number;
  prUrl: string;
  branch: string;
  agentId: string;
  itemIds: string[];
  status: PrStatus;
  openedAt: string;
}

/** Enriched response entry returned by this route. */
export interface PrResponseEntry extends LedgerEntry {
  ci: CiBlock | null;
}

export interface CyclePrsOpts {
  projectRoot?: string;
  /** Injectable execFile for testing — defaults to the real promisified version. */
  execFileFn?: typeof execFileAsync;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

const EXEC_TIMEOUT_MS = 15_000;

// Per-IP rate-limit settings used below via @fastify/rate-limit.
const RATE_LIMIT_MAX = 60;          // 60 req/min per remote address
const RATE_LIMIT_WINDOW = '1 minute';

/**
 * Parse `gh pr checks <number> --json name,state,conclusion` output into a
 * CiBucket.
 *
 * gh outputs an array of check objects:
 *   { name: string, state: 'SUCCESS'|'FAILURE'|'PENDING'|..., conclusion?: string }
 *
 * Bucket rules:
 *   - Any FAILURE / CANCELLED → 'fail'
 *   - Any PENDING / IN_PROGRESS / QUEUED (and no failures) → 'pending'
 *   - All SUCCESS / SKIPPED → 'pass'
 *   - Empty list or unknown → 'unknown'
 */
export function parseGhChecksBucket(stdout: string): CiBucket {
  let checks: Array<Record<string, unknown>>;
  try {
    checks = JSON.parse(stdout) as Array<Record<string, unknown>>;
  } catch {
    return 'unknown';
  }

  if (!Array.isArray(checks) || checks.length === 0) return 'unknown';

  let hasPending = false;

  for (const check of checks) {
    const state = String(check['state'] ?? '').toUpperCase();
    const conclusion = String(check['conclusion'] ?? '').toUpperCase();

    if (state === 'FAILURE' || state === 'ERROR' ||
        conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') {
      return 'fail';
    }
    if (state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED' || state === 'WAITING') {
      hasPending = true;
    }
  }

  if (hasPending) return 'pending';
  return 'pass';
}

/**
 * Fetch CI status for a single PR number via `gh pr checks`.
 * Returns null when gh is unavailable or not authenticated.
 */
export async function fetchCiStatus(
  prNumber: number,
  execFn: typeof execFileAsync,
): Promise<CiBlock | null> {
  try {
    const { stdout } = await execFn(
      'gh',
      ['pr', 'checks', String(prNumber), '--json', 'name,state,conclusion'],
      { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS },
    );
    const bucket = parseGhChecksBucket(stdout);
    return { bucket, lastCheckedAt: new Date().toISOString() };
  } catch {
    // gh not installed, not authenticated, or network failure — return null
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function cyclePrsRoutes(
  app: FastifyInstance,
  opts: CyclePrsOpts = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const execFn = opts.execFileFn ?? execFileAsync;

  /**
   * GET /api/v5/cycles/:cycleId/prs
   *
   * Returns the MergeQueue ledger for a cycle, optionally enriched with live
   * CI status from `gh pr checks`.
   */
  // Register @fastify/rate-limit once per server instance. Catches the
  // "FastifyError: Plugin already registered" so calling this route module
  // a second time (the standard adapter + no-adapter dual-registration
  // pattern) is a no-op.
  try {
    await app.register(rateLimit, {
      global: false, // we attach the limit per-route below
      max: RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_WINDOW,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already registered/i.test(msg)) throw err;
  }

  app.get<{ Params: { cycleId: string } }>(
    '/api/v5/cycles/:cycleId/prs',
    {
      config: {
        // 60 req/min per remote address. Returns 429 with retry-after.
        // Recognized by CodeQL js/missing-rate-limiting.
        rateLimit: { max: RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW },
      },
    },
    async (req, reply) => {
      const rawCycleId = req.params.cycleId;
      const q = req.query as { ci?: string; status?: string };

      // Sanitize cycleId: capture ONLY the safe-character prefix via match().
      // This pattern (vs. validate-then-use) lets static analyzers follow the
      // narrowing: `safeCycleId` is provably composed of characters that
      // cannot encode a path traversal (/, \, .., %, null bytes, etc.).
      const matched = rawCycleId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          error: 'Invalid cycleId — only alphanumeric, dash, and underscore allowed',
          cycleId: rawCycleId,
        });
      }
      const safeCycleId: string = matched[0];

      // Resolve the cycle directory using the sanitized id only.
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const cycleDir = resolve(join(cyclesBaseDir, safeCycleId));

      // Belt-and-braces containment check (already guaranteed by the regex
      // above; kept as a defense-in-depth assertion).
      const baseWithSep = cyclesBaseDir.endsWith('/') ? cyclesBaseDir : cyclesBaseDir + '/';
      if (cycleDir !== cyclesBaseDir && !cycleDir.startsWith(baseWithSep)) {
        return reply.status(400).send({ error: 'Invalid cycleId', cycleId: safeCycleId });
      }

      // Cycle dir missing → 404
      if (!existsSync(cycleDir)) {
        return reply.status(404).send({
          error: 'Cycle not found',
          cycleId: safeCycleId,
        });
      }

      // Ledger missing → 200 with empty data (single-PR mode)
      const ledgerPath = join(cycleDir, 'agent-prs.json');
      if (!existsSync(ledgerPath)) {
        return reply.send({
          data: [],
          meta: {
            cycleId: safeCycleId,
            total: 0,
            counts: { open: 0, merged: 0, closed: 0, pending: 0 },
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Parse the ledger
      let entries: LedgerEntry[];
      try {
        const raw = readFileSync(ledgerPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        entries = Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
      } catch {
        return reply.status(500).send({ error: 'Failed to parse ledger file', cycleId: safeCycleId });
      }

      // Apply ?status= filter
      const statusFilter = typeof q.status === 'string' && q.status.length > 0
        ? q.status
        : null;

      const filtered = statusFilter
        ? entries.filter(e => e.status === statusFilter)
        : entries;

      // Determine whether to run gh-checks enrichment
      const skipCi = q.ci === 'false' || q.ci === '0';

      // Enrich with CI status (skip when ?ci=false or status is dry-run/skipped-no-gh)
      const enriched: PrResponseEntry[] = await Promise.all(
        filtered.map(async (entry): Promise<PrResponseEntry> => {
          const noCiStatuses: PrStatus[] = ['dry-run', 'skipped-no-gh'];
          if (skipCi || noCiStatuses.includes(entry.status)) {
            return { ...entry, ci: null };
          }
          const ci = await fetchCiStatus(entry.prNumber, execFn);
          return { ...entry, ci };
        }),
      );

      // Build meta.counts from the full (unfiltered) entries, not just the filtered slice
      const counts = {
        open: entries.filter(e => e.status === 'open').length,
        merged: entries.filter(e => e.status === 'merged').length,
        closed: entries.filter(e => e.status === 'closed').length,
        pending: enriched.filter(e => e.ci?.bucket === 'pending').length,
      };

      return reply.send({
        data: enriched,
        meta: {
          cycleId: safeCycleId,
          total: enriched.length,
          counts,
          timestamp: new Date().toISOString(),
        },
      });
    },
  );
}
