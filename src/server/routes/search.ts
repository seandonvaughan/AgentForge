/**
 * Search Routes — POST /api/v5/search
 *
 * Full-text keyword search across sessions, agents, cycles, and sprints.
 * Uses LIKE-based queries for SQLite-backed data and in-memory filtering for
 * filesystem-backed data. Results are scored by term-frequency relevance and
 * returned sorted highest-score first.
 *
 * Request body:  { query: string; limit?: number; types?: string[] }
 * Response body: { data: SearchResult[]; meta: { total: number; query: string } }
 */

import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../');

/** Derive the filesystem paths for a given project root. */
function makePaths(projectRoot: string) {
  return {
    CYCLES_DIR:          join(projectRoot, '.agentforge/cycles'),
    CYCLES_ARCHIVED_DIR: join(projectRoot, '.agentforge/cycles-archived'),
    SPRINTS_DIR:         join(projectRoot, '.agentforge/sprints'),
    MEMORY_JSONL_DIR:    join(projectRoot, '.agentforge/memory'),
    MEMORIES_JSON_PATH:  join(projectRoot, '.agentforge/data/memories.json'),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id?: string;
  content: string;
  /** Normalized relevance score 0-1. */
  score: number;
  metadata?: Record<string, unknown>;
  type?: string;
  source?: string;
}

const VALID_TYPES = new Set(['session', 'agent', 'cycle', 'sprint', 'memory']);

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a query string into lowercase, non-empty terms.
 * Deduplicates to avoid inflating scores for repeated terms.
 */
function tokenize(text: string): string[] {
  return [...new Set(
    text.toLowerCase().split(/\s+/).filter(t => t.length > 0)
  )];
}

/**
 * Score a document string against a set of query tokens.
 *
 * Returns a value in [0, 1]:
 *   - 1.0  = every token found in the document
 *   - 0.0  = no tokens found
 * Documents that match no tokens are excluded (score === 0).
 */
function score(document: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = document.toLowerCase();
  const hits = tokens.filter(t => lower.includes(t)).length;
  return hits / tokens.length;
}

// ---------------------------------------------------------------------------
// Per-type search implementations
// ---------------------------------------------------------------------------

/** Search sessions using SQLite LIKE on task, response, agent_id, and status. */
function searchSessions(
  adapter: SqliteAdapter,
  tokens: string[],
  limit: number,
): SearchResult[] {
  // Use a broad listSessions pull and score in memory — avoids crafting a
  // complex multi-column LIKE SQL query while keeping the adapter API simple.
  const sessions = adapter.listSessions({ limit: 500 });
  const results: SearchResult[] = [];

  for (const s of sessions) {
    const document = [
      s.agent_id ?? '',
      s.agent_name ?? '',
      s.task ?? '',
      s.response ?? '',
      s.status ?? '',
      s.model ?? '',
    ].join(' ');

    const relevance = score(document, tokens);
    if (relevance === 0) continue;

    results.push({
      id:      s.id,
      content: s.task ?? s.agent_id ?? '',
      score:   relevance,
      type:    'session',
      source:  s.agent_id,
      metadata: {
        status:    s.status,
        agent_id:  s.agent_id,
        model:     s.model,
        started_at: s.started_at,
      },
    });
  }

  // Sort by relevance descending, cap at limit
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Search agents by agentId and description derived from sessions. */
function searchAgents(
  adapter: SqliteAdapter,
  tokens: string[],
  limit: number,
): SearchResult[] {
  const sessions = adapter.listSessions({ limit: 500 });

  // Aggregate unique agents from session data
  const agentMap = new Map<string, { agentId: string; sessionCount: number; lastStatus: string }>();
  for (const s of sessions) {
    const existing = agentMap.get(s.agent_id);
    if (existing) {
      existing.sessionCount++;
    } else {
      agentMap.set(s.agent_id, {
        agentId: s.agent_id,
        sessionCount: 1,
        lastStatus: s.status ?? '',
      });
    }
  }

  const results: SearchResult[] = [];
  for (const [agentId, info] of agentMap) {
    const document = [agentId, info.lastStatus].join(' ');
    const relevance = score(document, tokens);
    if (relevance === 0) continue;

    results.push({
      id:      agentId,
      content: agentId,
      score:   relevance,
      type:    'agent',
      source:  agentId,
      metadata: {
        sessionCount: info.sessionCount,
        lastStatus:   info.lastStatus,
      },
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Search cycle directories from filesystem. */
function searchCycles(
  tokens: string[],
  limit: number,
  paths: ReturnType<typeof makePaths>,
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const [baseDir, isArchived] of [
    [paths.CYCLES_DIR,          false],
    [paths.CYCLES_ARCHIVED_DIR, true],
  ] as Array<[string, boolean]>) {
    if (!existsSync(baseDir)) continue;

    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cycleId  = entry.name;
      const cycleDir = join(baseDir, cycleId);

      let cycleJson: Record<string, unknown> = {};
      try {
        const cycleFile = join(cycleDir, 'cycle.json');
        if (existsSync(cycleFile)) {
          cycleJson = JSON.parse(readFileSync(cycleFile, 'utf-8')) as Record<string, unknown>;
        }
      } catch {
        // Skip malformed cycle files
        continue;
      }

      const document = [
        cycleId,
        cycleJson.stage ?? '',
        cycleJson.sprintVersion ?? '',
        isArchived ? 'archived' : 'active',
      ].join(' ');

      const relevance = score(document, tokens);
      if (relevance === 0) continue;

      results.push({
        id:      cycleId,
        content: `Cycle ${cycleId} — stage: ${cycleJson.stage ?? 'unknown'}`,
        score:   relevance,
        type:    'cycle',
        source:  isArchived ? 'cycles-archived' : 'cycles',
        metadata: {
          stage:         cycleJson.stage,
          sprintVersion: cycleJson.sprintVersion,
          startedAt:     cycleJson.startedAt,
          completedAt:   cycleJson.completedAt,
          isArchived,
        },
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Search sprint JSON files from the filesystem. */
function searchSprints(
  tokens: string[],
  limit: number,
  paths: ReturnType<typeof makePaths>,
): SearchResult[] {
  if (!existsSync(paths.SPRINTS_DIR)) return [];

  const files = readdirSync(paths.SPRINTS_DIR).filter(f => f.endsWith('.json') && !f.includes('$'));
  const results: SearchResult[] = [];

  for (const filename of files) {
    let parsed: Record<string, unknown>;
    try {
      let raw: unknown = JSON.parse(readFileSync(join(paths.SPRINTS_DIR, filename), 'utf-8'));
      if (typeof raw === 'string') raw = JSON.parse(raw);
      parsed = raw as Record<string, unknown>;
    } catch {
      continue;
    }

    // Handle wrapped sprint arrays
    const sprintList: Array<Record<string, unknown>> = Array.isArray(parsed.sprints)
      ? (parsed.sprints as Array<Record<string, unknown>>)
      : [parsed];

    for (const sprint of sprintList) {
      const items = Array.isArray(sprint.items) ? sprint.items : [];
      const itemTitles = items
        .map((i: unknown) => (typeof i === 'object' && i !== null ? (i as Record<string, unknown>).title ?? '' : ''))
        .join(' ');

      const document = [
        sprint.version ?? '',
        sprint.title ?? '',
        sprint.phase ?? '',
        sprint.status ?? '',
        sprint.theme ?? '',
        itemTitles,
      ].join(' ');

      const relevance = score(document, tokens);
      if (relevance === 0) continue;

      const sprintId = String(sprint.sprintId ?? sprint.id ?? sprint.version ?? filename);
      results.push({
        id:      sprintId,
        content: String(sprint.title ?? `Sprint ${sprint.version}`),
        score:   relevance,
        type:    'sprint',
        source:  filename,
        metadata: {
          version:   sprint.version,
          phase:     sprint.phase,
          status:    sprint.status,
          itemCount: items.length,
        },
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Search memory entries from JSONL files and the SQLite KV store. */
function searchMemory(
  adapter: SqliteAdapter,
  tokens: string[],
  limit: number,
  paths: ReturnType<typeof makePaths>,
): SearchResult[] {
  const results: SearchResult[] = [];

  // --- JSONL files (primary: cycle-outcome, gate-verdict, review-finding, etc.) ---
  if (existsSync(paths.MEMORY_JSONL_DIR)) {
    try {
      const files = readdirSync(paths.MEMORY_JSONL_DIR).filter(f => f.endsWith('.jsonl'));
      for (const filename of files) {
        try {
          const raw = readFileSync(join(paths.MEMORY_JSONL_DIR, filename), 'utf-8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line) as {
                id?: string;
                type?: string;
                value?: string;
                source?: string;
                tags?: string[];
                createdAt?: string;
              };
              if (!e.id) continue;

              const document = [
                e.id,
                e.type ?? '',
                e.value ?? '',
                e.source ?? '',
                (e.tags ?? []).join(' '),
              ].join(' ');

              const relevance = score(document, tokens);
              if (relevance === 0) continue;

              results.push({
                id:      e.id,
                content: (e.value ?? e.type ?? e.id).slice(0, 280),
                score:   relevance,
                type:    'memory',
                source:  e.source ?? filename,
                metadata: {
                  memoryType: e.type,
                  source:     e.source,
                  tags:       (e.tags ?? []).join(', '),
                  createdAt:  e.createdAt,
                },
              });
            } catch {
              // skip malformed lines
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // MEMORY_JSONL_DIR unreadable — fall through
    }
  }

  // --- Structured memories.json (operator-curated / autonomous-loop learned) ---
  if (existsSync(paths.MEMORIES_JSON_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(paths.MEMORIES_JSON_PATH, 'utf-8')) as {
        entries?: Array<{
          id?: string;
          filename?: string;
          category?: string;
          agentId?: string;
          summary?: string;
          tags?: string[];
          updatedAt?: string;
        }>;
      };
      for (const e of raw.entries ?? []) {
        const document = [
          e.filename ?? '',
          e.category ?? '',
          e.agentId ?? '',
          e.summary ?? '',
          (e.tags ?? []).join(' '),
        ].join(' ');

        const relevance = score(document, tokens);
        if (relevance === 0) continue;

        const id = e.id ?? e.filename ?? '';
        results.push({
          id,
          content: (e.summary ?? e.filename ?? id).slice(0, 280),
          score:   relevance,
          type:    'memory',
          source:  e.agentId ?? 'memories.json',
          metadata: {
            memoryType: 'structured',
            category:   e.category,
            agentId:    e.agentId,
            tags:       (e.tags ?? []).join(', '),
            updatedAt:  e.updatedAt,
          },
        });
      }
    } catch {
      // skip malformed memories.json
    }
  }

  // --- SQLite KV store (real-time agent-written memory) ---
  try {
    const db = adapter.getAgentDatabase().getDb();
    const rows = db
      .prepare<[], { key: string; value: string; updated_at: string }>(
        'SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC'
      )
      .all();
    for (const row of rows) {
      const document = [row.key, row.value].join(' ');
      const relevance = score(document, tokens);
      if (relevance === 0) continue;

      results.push({
        id:      row.key,
        content: (row.value).slice(0, 280),
        score:   relevance,
        type:    'memory',
        source:  'kv-store',
        metadata: {
          memoryType: 'kv',
          updatedAt:  row.updated_at,
        },
      });
    }
  } catch {
    // kv_store table may not exist — skip silently
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export interface SearchRoutesOptions {
  adapter: SqliteAdapter;
  /** Override the project root directory. Defaults to the compiled module root. */
  projectRoot?: string;
}

export async function searchRoutes(
  app: FastifyInstance,
  opts: SearchRoutesOptions,
) {
  const { adapter } = opts;

  /**
   * POST /api/v5/search
   *
   * Body:
   *   query  — search terms (required, non-empty)
   *   limit  — max results to return (default 20, max 100)
   *   types  — restrict to specific content types; omit for all types
   */
  app.post<{
    Body: { query?: unknown; limit?: unknown; types?: unknown };
  }>('/api/v5/search', async (req, reply) => {
    const body = req.body ?? {};

    // Validate query
    if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
      return reply.status(400).send({ error: 'query is required and must be a non-empty string' });
    }

    const queryStr = body.query.trim();
    const rawLimit = typeof body.limit === 'number' ? body.limit : 20;
    const limit    = Math.min(Math.max(1, rawLimit), 100);

    // Resolve enabled types — empty/absent means all types
    let enabledTypes: Set<string>;
    if (Array.isArray(body.types) && body.types.length > 0) {
      const filtered = (body.types as unknown[])
        .filter((t): t is string => typeof t === 'string' && VALID_TYPES.has(t));
      enabledTypes = new Set(filtered.length > 0 ? filtered : VALID_TYPES);
    } else {
      enabledTypes = new Set(VALID_TYPES);
    }

    const tokens = tokenize(queryStr);
    if (tokens.length === 0) {
      return reply.send({ data: [], meta: { total: 0, query: queryStr } });
    }

    // Per-type budget: each source contributes up to `limit` candidates.
    // After merging, we re-sort and cap at the global limit.
    const perTypeBudget = limit;

    // Derive filesystem paths once; reused by all filesystem-backed searchers.
    // Use the injected projectRoot (e.g. from workspace config) when available.
    const paths = makePaths(opts.projectRoot ?? DEFAULT_PROJECT_ROOT);

    const all: SearchResult[] = [];

    if (enabledTypes.has('session')) {
      all.push(...searchSessions(adapter, tokens, perTypeBudget));
    }
    if (enabledTypes.has('agent')) {
      all.push(...searchAgents(adapter, tokens, perTypeBudget));
    }
    if (enabledTypes.has('cycle')) {
      all.push(...searchCycles(tokens, perTypeBudget, paths));
    }
    if (enabledTypes.has('sprint')) {
      all.push(...searchSprints(tokens, perTypeBudget, paths));
    }
    if (enabledTypes.has('memory')) {
      all.push(...searchMemory(adapter, tokens, perTypeBudget, paths));
    }

    // Global sort by score, then cap
    all.sort((a, b) => b.score - a.score);
    const data = all.slice(0, limit);

    return reply.send({
      data,
      meta: { total: data.length, query: queryStr },
    });
  });
}
