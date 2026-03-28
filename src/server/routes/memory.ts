import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

interface MemoryEntry {
  key: string;
  value: string;
  updatedAt?: string;
}

export async function memoryRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

  app.get('/api/v1/memory', async (_req, reply) => {
    const entries: MemoryEntry[] = [];

    // Try reading from adapter KV store
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
      // kv_store may not exist or be empty — fall through to file fallback
    }

    // Fall back to listing session JSON files from .agentforge/sessions/
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
              // skip
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return reply.send({ data: entries, meta: { total: entries.length } });
  });
}
