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
  category?: string;
  agentId?: string;
  summary?: string;
  tags?: string[];
  updatedAt?: string;
  createdAt?: string;
}

const MEMORIES_JSON_PATH = join(PROJECT_ROOT, '.agentforge/data/memories.json');

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

  // GET /api/v5/memory — v5 alias; same logic with guaranteed id + agents list
  app.get('/api/v5/memory', async (req, reply) => {
    const query = req.query as { search?: string; agent?: string };
    const searchTerm = (query.search ?? '').toLowerCase().trim();
    const agentFilter = (query.agent ?? 'all').trim();

    const entries: MemoryEntry[] = [];

    // Primary: KV store
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

    // Secondary: memories.json
    if (entries.length === 0) {
      const fileEntries = readMemoriesJson();
      for (const e of fileEntries) {
        entries.push({ ...e, id: e.id ?? e.key });
      }
    }

    // Tertiary: raw session file listing
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

    // Collect unique agents before filtering (for the client dropdown)
    const agents = [...new Set(entries.map(e => e.agentId).filter(Boolean) as string[])].sort();

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

    return reply.send({ data: afterAgent, agents, meta: { total: afterAgent.length } });
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
