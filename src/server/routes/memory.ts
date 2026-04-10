import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

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
}

/** Maximum entries returned by the v5 memory endpoint. */
const V5_MEMORY_LIMIT = 200;

const MEMORIES_JSON_PATH = join(PROJECT_ROOT, '.agentforge/data/memories.json');
const MEMORY_JSONL_DIR = join(PROJECT_ROOT, '.agentforge/memory');

/**
 * Read all `.agentforge/memory/*.jsonl` files and return entries sorted
 * newest-first (by createdAt). This is the primary data source for the v5
 * memory endpoint — it covers cycle-outcome, gate-verdict, review-finding,
 * failure-pattern, and learned-fact entries emitted by cycle phases.
 */
function readJsonlMemories(): MemoryEntry[] {
  if (!existsSync(MEMORY_JSONL_DIR)) return [];

  const entries: MemoryEntry[] = [];
  try {
    const files = readdirSync(MEMORY_JSONL_DIR).filter(f => f.endsWith('.jsonl'));
    for (const filename of files) {
      try {
        const raw = readFileSync(join(MEMORY_JSONL_DIR, filename), 'utf8');
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
            };
            if (!e.id || !e.type) continue;
            entries.push({
              id: e.id,
              // key follows the convention <type>/<source> so the dashboard
              // can display a meaningful identifier without a dedicated field.
              key: e.source ? `${e.type}/${e.source}` : e.type,
              value: (e.value ?? '').slice(0, 500),
              type: e.type,
              // Map source → agentId for the existing agent-filter UI, and
              // also surface it as `source` so the dashboard can build links.
              agentId: e.source,
              source: e.source,
              tags: e.tags ?? [],
              createdAt: e.createdAt,
              updatedAt: e.createdAt,
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

/** Read structured memory entries from the canonical data file. */
function readMemoriesJson(): MemoryEntry[] {
  if (!existsSync(MEMORIES_JSON_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(MEMORIES_JSON_PATH, 'utf8')) as {
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
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

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
      const fileEntries = readMemoriesJson();
      entries.push(...fileEntries);
    }

    // Tertiary: raw session file listing (legacy fallback)
    if (entries.length === 0) {
      try {
        const sessionsDir = join(PROJECT_ROOT, '.agentforge/sessions');
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
  // Data source priority:
  //   1. .agentforge/memory/*.jsonl  (new primary — cycle-outcome, gate-verdict, etc.)
  //   2. KV store (SQLite kv_store table — real-time agent writes)
  //   3. .agentforge/data/memories.json (operator-curated + autonomous-loop entries)
  //   4. .agentforge/sessions/*.json  (legacy file-listing fallback)
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

    const entries: MemoryEntry[] = [];

    // Primary: JSONL files — the authoritative cross-cycle memory store
    const jsonlEntries = readJsonlMemories();
    entries.push(...jsonlEntries);

    // Secondary: KV store (real-time agent-written memory; merged on top of JSONL)
    try {
      const db = adapter.getAgentDatabase().getDb();
      const rows = db
        .prepare<[], { key: string; value: string; updated_at: string }>(
          'SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC'
        )
        .all();

      for (const row of rows) {
        entries.push({
          id: row.key,
          key: row.key,
          value: row.value.slice(0, 500),
          updatedAt: row.updated_at,
        });
      }
    } catch {
      // kv_store may not exist or be empty — fall through
    }

    // Tertiary: memories.json (operator-curated entries; only if nothing found yet)
    if (entries.length === 0) {
      const fileEntries = readMemoriesJson();
      for (const e of fileEntries) {
        entries.push({ ...e, id: e.id ?? e.key });
      }
    }

    // Quaternary: raw session file listing (legacy fallback)
    if (entries.length === 0) {
      try {
        const sessionsDir = join(PROJECT_ROOT, '.agentforge/sessions');
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

    // Cap to latest V5_MEMORY_LIMIT entries before building the agents/types
    // lists so filters and dropdowns reflect only what the client will see.
    const capped = entries.slice(0, V5_MEMORY_LIMIT);

    // Collect unique agents and types before filtering (for client dropdowns)
    const agents = [...new Set(capped.map(e => e.agentId).filter(Boolean) as string[])].sort();
    const types = [...new Set(capped.map(e => e.type).filter(Boolean) as string[])].sort();

    // Apply search filter
    const afterSearch = searchTerm
      ? capped.filter(e => {
          const haystack = [e.key, e.value, e.summary ?? '', (e.tags ?? []).join(' ')]
            .join(' ')
            .toLowerCase();
          return haystack.includes(searchTerm);
        })
      : capped;

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

    return reply.send({ data: afterSince, agents, types, meta: { total: afterSince.length, limit: V5_MEMORY_LIMIT } });
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
