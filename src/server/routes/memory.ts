import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, createReadStream, readdirSync, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../');

interface MemoryEntry {
  id?: string;
  filename?: string;
  key: string;
  value: string;
  type?: string;
  category?: string;
  agentId?: string;
  /** Original source field from JSONL (cycleId or agentId). */
  source?: string;
  summary?: string;
  tags?: string[];
  updatedAt?: string;
  createdAt?: string;
  /** Structured payload from the canonical CycleMemoryEntry schema (rank-1). */
  metadata?: Record<string, unknown>;
}

/** Maximum entries returned by the v5 memory endpoint. */
const V5_MEMORY_LIMIT = 200;

/**
 * Derive a human-readable summary and category from a JSONL entry's type and
 * value payload so the dashboard can render something meaningful instead of raw JSON.
 */
function _deriveJsonlMeta(
  type: string,
  rawValue: string,
): { summary: string; category: string } {
  // Map entry type to a dashboard category chip
  const categoryMap: Record<string, string> = {
    'cycle-outcome':  'project',
    'gate-verdict':   'feedback',
    'review-finding': 'feedback',
    'failure-pattern': 'lesson',
    'learned-fact':   'lesson',
  };
  const category = categoryMap[type] ?? 'project';

  // Attempt to parse the value as JSON and build a human-readable summary.
  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;

    if (type === 'cycle-outcome') {
      const sprint  = parsed.sprintVersion ?? '?';
      const stage   = parsed.stage ?? '?';
      const cost    = typeof parsed.costUsd === 'number' ? `$${(parsed.costUsd as number).toFixed(2)}` : '';
      const tests   = typeof parsed.testsPassed === 'number' ? `${parsed.testsPassed} tests` : '';
      const pr      = parsed.prUrl ? ' · PR opened' : '';
      const parts   = [sprint, stage, cost, tests].filter(Boolean).join(' · ');
      return { summary: parts + pr, category };
    }

    if (type === 'gate-verdict') {
      const verdict  = parsed.verdict   ?? '?';
      const sprint   = parsed.sprintVersion ?? '';
      const rationale = typeof parsed.rationale === 'string'
        ? (parsed.rationale as string).slice(0, 160)
        : '';
      const prefix = [sprint, verdict].filter(Boolean).join(' · ');
      return { summary: rationale ? `${prefix} — ${rationale}` : prefix, category };
    }

    if (type === 'review-finding') {
      // Prefer a top-level `message` field, then first value that is a string
      const msg = (parsed.message ?? parsed.text ?? parsed.description) as string | undefined;
      if (msg) return { summary: String(msg).slice(0, 200), category };
    }

    // Generic fallback: stringify the parsed object compactly
    const compact = JSON.stringify(parsed);
    return { summary: compact.slice(0, 200), category };
  } catch {
    // Value is not JSON — return as-is
    return { summary: rawValue.slice(0, 200), category };
  }
}

/**
 * Read all `.agentforge/memory/*.jsonl` files and return entries sorted
 * newest-first (by createdAt). Each entry gets a derived human-readable
 * `summary` and inferred `category` so dashboard filters work out-of-the-box.
 */
function readJsonlMemories(memoryDir: string): MemoryEntry[] {
  if (!existsSync(memoryDir)) return [];

  const entries: MemoryEntry[] = [];
  try {
    const files = readdirSync(memoryDir).filter(f => f.endsWith('.jsonl'));
    for (const filename of files) {
      try {
        const raw = readFileSync(join(memoryDir, filename), 'utf8');
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as {
              id?: string;
              type?: string;
              value?: string;
              createdAt?: string;
              source?: string;
              tags?: string[];
              metadata?: Record<string, unknown>;
            };
            if (!e.id || !e.type) continue;
            const rawValue = e.value ?? '';
            const { summary, category } = _deriveJsonlMeta(e.type, rawValue);
            entries.push({
              id: e.id,
              // key follows the convention <type>/<source> so the dashboard
              // can display a meaningful identifier without a dedicated field.
              key: e.source ? `${e.type}/${e.source}` : e.type,
              value: rawValue.slice(0, 500),
              summary,
              category,
              type: e.type,
              // Map source → agentId for the existing agent-filter UI, and
              // also surface it as `source` so the dashboard can build links.
              agentId: e.source,
              source: e.source,
              tags: e.tags ?? [],
              createdAt: e.createdAt,
              updatedAt: e.createdAt,
              // Pass through structured metadata from the rank-1 schema so
              // flywheel and dashboard consumers can read typed payloads.
              ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
            });
          } catch {
            // skip malformed lines without failing the whole file
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    return [];
  }

  // Newest entries first — ISO-8601 strings sort lexicographically
  return entries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * Async generator that streams entries from all `.agentforge/memory/*.jsonl`
 * files one line at a time, applying optional filters during the read so the
 * caller never needs to buffer the entire corpus.
 *
 * Filters applied inline (before yielding):
 *   typeFilter — exact match on the entry's `type` field
 *   sinceMs    — only entries whose `createdAt` timestamp >= sinceMs
 *   searchTerm — lowercase substring match across key/value/summary/tags
 *   agentFilter — exact match on `source` / `agentId`
 */
async function* streamJsonlMemories(
  memoryDir: string,
  opts: {
    typeFilter?: string;
    sinceMs?: number;
    searchTerm?: string;
    agentFilter?: string;
  } = {},
): AsyncGenerator<MemoryEntry> {
  if (!existsSync(memoryDir)) return;

  let files: string[];
  try {
    files = readdirSync(memoryDir).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return;
  }

  const { typeFilter, sinceMs, searchTerm, agentFilter } = opts;
  const hasSince = typeof sinceMs === 'number' && !Number.isNaN(sinceMs);

  for (const filename of files) {
    const filePath = join(memoryDir, filename);
    let rl: ReturnType<typeof createInterface> | undefined;
    try {
      const fileStream = createReadStream(filePath, { encoding: 'utf8' });
      rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let e: {
          id?: string;
          type?: string;
          value?: string;
          createdAt?: string;
          source?: string;
          tags?: string[];
          metadata?: Record<string, unknown>;
        };
        try {
          e = JSON.parse(line) as typeof e;
        } catch {
          continue; // skip malformed lines
        }
        if (!e.id || !e.type) continue;

        // ── inline filters ────────────────────────────────────────────────
        if (typeFilter && e.type !== typeFilter) continue;

        if (hasSince) {
          const entryMs = e.createdAt ? new Date(e.createdAt).getTime() : 0;
          if (entryMs < sinceMs!) continue;
        }

        const rawValue = e.value ?? '';
        const { summary, category } = _deriveJsonlMeta(e.type, rawValue);
        const entry: MemoryEntry = {
          id: e.id,
          key: e.source ? `${e.type}/${e.source}` : e.type,
          value: rawValue.slice(0, 500),
          summary,
          category,
          type: e.type,
          agentId: e.source,
          source: e.source,
          tags: e.tags ?? [],
          createdAt: e.createdAt,
          updatedAt: e.createdAt,
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        };

        if (agentFilter && agentFilter !== 'all' && entry.agentId !== agentFilter) continue;

        if (searchTerm) {
          const haystack = [entry.key, entry.value, entry.summary ?? '', (entry.tags ?? []).join(' ')]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(searchTerm)) continue;
        }

        yield entry;
      }
    } catch {
      // skip unreadable files
    } finally {
      rl?.close();
    }
  }
}

/** Read structured memory entries from the canonical data file. */
function readMemoriesJson(memoriesJsonPath: string): MemoryEntry[] {
  if (!existsSync(memoriesJsonPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(memoriesJsonPath, 'utf8')) as {
      entries?: Array<{
        id?: string;
        filename?: string;
        category?: string;
        agentId?: string;
        summary?: string;
        tags?: string[];
        updatedAt?: string;
        createdAt?: string;
      }>;
    };
    return (raw.entries ?? []).map(e => ({
      id: e.id,
      filename: e.filename,
      // Backward-compat key/value fields expected by existing consumers
      key: e.filename ?? e.id ?? '',
      value: (e.summary ?? '').slice(0, 500),
      category: e.category,
      agentId: e.agentId,
      summary: e.summary,
      tags: e.tags ?? [],
      updatedAt: e.updatedAt,
      createdAt: e.createdAt,
    }));
  } catch {
    return [];
  }
}

export async function memoryRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter; projectRoot?: string }
) {
  const { adapter } = opts;
  const root = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const MEMORIES_JSON_PATH = join(root, '.agentforge/data/memories.json');
  const MEMORY_JSONL_DIR = join(root, '.agentforge/memory');

  app.get('/api/v1/memory', async (req, reply) => {
    const query = req.query as { search?: string; agent?: string };
    const searchTerm = (query.search ?? '').toLowerCase().trim();
    const agentFilter = (query.agent ?? 'all').trim();

    const entries: MemoryEntry[] = [];

    // Primary: KV store (real-time agent-written memory)
    try {
      const db = adapter.getAgentDatabase().getDb();
      const rows = db
        .prepare<[], { key: string; value: string; updated_at: string }>(
          'SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC'
        )
        .all();

      for (const row of rows) {
        entries.push({
          key: row.key,
          value: row.value.slice(0, 500),
          updatedAt: row.updated_at,
        });
      }
    } catch {
      // kv_store may not exist or be empty — fall through
    }

    // Secondary: structured memories.json (operator-curated + autonomous-loop learned)
    if (entries.length === 0) {
      const fileEntries = readMemoriesJson(MEMORIES_JSON_PATH);
      entries.push(...fileEntries);
    }

    // Tertiary: raw session file listing (legacy fallback)
    if (entries.length === 0) {
      try {
        const sessionsDir = join(root, '.agentforge/sessions');
        if (existsSync(sessionsDir)) {
          const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
          for (const filename of files) {
            try {
              const stat = statSync(join(sessionsDir, filename));
              entries.push({
                key: `sessions/${filename}`,
                value: filename,
                updatedAt: stat.mtime.toISOString(),
              });
            } catch {
              // skip unreadable files
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Apply search filter across key, value, summary, and tags
    const afterSearch = searchTerm
      ? entries.filter(e => {
          const haystack = [
            e.key,
            e.value,
            e.summary ?? '',
            (e.tags ?? []).join(' '),
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(searchTerm);
        })
      : entries;

    // Apply agent filter
    const afterAgent =
      agentFilter && agentFilter !== 'all'
        ? afterSearch.filter(e => e.agentId === agentFilter)
        : afterSearch;

    return reply.send({ data: afterAgent, meta: { total: afterAgent.length } });
  });

  // GET /api/v5/memory — serves the latest 200 cross-cycle memory entries.
  //
  // Data sources (all merged — NOT a waterfall):
  //   1. .agentforge/memory/*.jsonl  (cycle-outcome, gate-verdict, review-finding, etc.)
  //   2. KV store (SQLite kv_store table — real-time agent writes)
  //   3. .agentforge/data/memories.json (operator-curated + autonomous-loop entries)
  //   4. .agentforge/sessions/*.json  (legacy file-listing fallback; only if 1-3 empty)
  //
  // Sources 1-3 are always merged so operator-curated knowledge surfaces alongside
  // live cycle data. Deduplication is by entry id so no row appears twice.
  //
  // Query params:
  //   search  — substring match across key, value, summary, tags
  //   agent   — exact match on agentId (legacy alias; maps to `source` in JSONL)
  //   agentId — exact match on agentId (preferred spelling; same semantics as agent)
  //   type    — exact match on the entry's `type` field (e.g. "cycle-outcome")
  //   since   — ISO-8601 timestamp; only entries with createdAt >= since
  app.get('/api/v5/memory', async (req, reply) => {
    const query = req.query as {
      search?: string;
      agent?: string;
      agentId?: string;
      type?: string;
      since?: string;
    };
    const searchTerm = (query.search ?? '').toLowerCase().trim();
    // Accept both `agent` (legacy) and `agentId` (new canonical param); agentId wins.
    const agentFilter = (query.agentId ?? query.agent ?? 'all').trim();
    const typeFilter = (query.type ?? '').trim();
    const sinceMs = query.since ? new Date(query.since).getTime() : NaN;
    const hasSince = !Number.isNaN(sinceMs);

    // Collect all entries; track seen IDs to deduplicate across sources.
    const seenIds = new Set<string>();
    const entries: MemoryEntry[] = [];

    function addEntry(e: MemoryEntry): void {
      // Build a dedup key from id or key; fall back to type+createdAt to ensure
      // entries with neither field set still participate in deduplication rather
      // than bypassing the guard entirely (MAJOR finding from v10.1.0 review).
      const id = e.id ?? e.key;
      const dedupeKey = id || (e.type && e.createdAt ? `${e.type}:${e.createdAt}` : undefined);
      if (dedupeKey && seenIds.has(dedupeKey)) return;
      if (dedupeKey) seenIds.add(dedupeKey);
      entries.push(e);
    }

    // Source 1: JSONL files — authoritative cross-cycle memory store
    for (const e of readJsonlMemories(MEMORY_JSONL_DIR)) addEntry(e);

    // Source 2: KV store (real-time agent-written memory)
    try {
      const db = adapter.getAgentDatabase().getDb();
      const rows = db
        .prepare<[], { key: string; value: string; updated_at: string }>(
          'SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC'
        )
        .all();

      for (const row of rows) {
        addEntry({
          id: row.key,
          key: row.key,
          value: row.value.slice(0, 500),
          updatedAt: row.updated_at,
        });
      }
    } catch {
      // kv_store may not exist or be empty — fall through
    }

    // Source 3: memories.json — always merged (not a fallback) so operator-curated
    // knowledge surfaces alongside live cycle data regardless of JSONL volume.
    for (const e of readMemoriesJson(MEMORIES_JSON_PATH)) {
      addEntry({ ...e, id: e.id ?? e.key });
    }

    // Quaternary: raw session file listing (legacy fallback)
    if (entries.length === 0) {
      try {
        const sessionsDir = join(root, '.agentforge/sessions');
        if (existsSync(sessionsDir)) {
          const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
          for (const filename of files) {
            try {
              const stat = statSync(join(sessionsDir, filename));
              const key = `sessions/${filename}`;
              entries.push({
                id: key,
                key,
                value: filename,
                updatedAt: stat.mtime.toISOString(),
              });
            } catch {
              // skip unreadable files
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Collect unique agents and types from ALL entries (not just the capped
    // window) so dropdown options in the UI reflect the full data set.
    const agents = [...new Set(entries.map(e => e.agentId).filter(Boolean) as string[])].sort();
    const types = [...new Set(entries.map(e => e.type).filter(Boolean) as string[])].sort();

    // Apply all filters to the full entry list BEFORE capping.  This ensures
    // meta.total reflects true match counts (not cap-window counts), fixing the
    // "meta.total reports paginated count" MAJOR finding from v10.1.0 review.

    // Apply search filter
    const afterSearch = searchTerm
      ? entries.filter(e => {
          const haystack = [e.key, e.value, e.summary ?? '', (e.tags ?? []).join(' ')]
            .join(' ')
            .toLowerCase();
          return haystack.includes(searchTerm);
        })
      : entries;

    // Apply agent filter
    const afterAgent =
      agentFilter && agentFilter !== 'all'
        ? afterSearch.filter(e => e.agentId === agentFilter)
        : afterSearch;

    // Apply type filter
    const afterType = typeFilter
      ? afterAgent.filter(e => e.type === typeFilter)
      : afterAgent;

    // Apply since filter
    const afterSince = hasSince
      ? afterType.filter(e => {
          const entryMs = e.createdAt ? new Date(e.createdAt).getTime() : 0;
          return entryMs >= sinceMs;
        })
      : afterType;

    // Cap to V5_MEMORY_LIMIT after filtering so callers get the most recent
    // matching entries and meta.total accurately shows how many matched.
    const totalFiltered = afterSince.length;
    const data = afterSince.slice(0, V5_MEMORY_LIMIT);

    return reply.send({ data, agents, types, meta: { total: totalFiltered, limit: V5_MEMORY_LIMIT, returned: data.length } });
  });

  // GET /api/v5/memory/stream — NDJSON streaming endpoint.
  //
  // Identical filter surface to GET /api/v5/memory but returns entries as
  // Newline-Delimited JSON (one JSON object per line) streamed from disk
  // without buffering the full corpus.  Only reads .agentforge/memory/*.jsonl;
  // KV-store and memories.json sources are NOT included (they are small and
  // already covered by the paginated endpoint).
  //
  // Use this endpoint when:
  //   • The caller needs to process entries incrementally (e.g., dashboard
  //     virtual scroll with lazy loading).
  //   • The JSONL corpus is large enough that buffering 200 entries is
  //     insufficient and a complete filtered dump is required.
  //
  // Query params: same as GET /api/v5/memory
  //   search, agentId, agent, type, since
  //
  // Response: application/x-ndjson; one MemoryEntry JSON object per line.
  //   An empty result is a 200 with an empty body.
  app.get('/api/v5/memory/stream', async (req, reply) => {
    const query = req.query as {
      search?: string;
      agent?: string;
      agentId?: string;
      type?: string;
      since?: string;
    };
    const searchTerm  = (query.search ?? '').toLowerCase().trim() || undefined;
    const agentFilter = (query.agentId ?? query.agent ?? '').trim() || undefined;
    const typeFilter  = (query.type ?? '').trim() || undefined;
    const sinceMs     = query.since ? new Date(query.since).getTime() : undefined;

    reply.raw.setHeader('Content-Type', 'application/x-ndjson');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Transfer-Encoding', 'chunked');

    try {
      for await (const entry of streamJsonlMemories(MEMORY_JSONL_DIR, { typeFilter, sinceMs, searchTerm, agentFilter })) {
        reply.raw.write(JSON.stringify(entry) + '\n');
      }
    } catch {
      // swallow mid-stream errors; partial data already sent
    } finally {
      reply.raw.end();
    }
  });

  // DELETE /api/v5/memory/:id — remove a kv_store entry by key
  app.delete<{ Params: { id: string } }>('/api/v5/memory/:id', async (req, reply) => {
    const key = decodeURIComponent(req.params.id);
    try {
      const db = adapter.getAgentDatabase().getDb();
      const result = db
        .prepare<[string]>('DELETE FROM kv_store WHERE key = ?')
        .run(key);
      if (result.changes === 0) {
        return reply.status(404).send({ error: 'Entry not found', key });
      }
      return reply.send({ ok: true, key });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });
}
