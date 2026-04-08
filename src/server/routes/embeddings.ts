import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  id?: string;
  content: string;
  /** Relevance score in [0, 1] — term-frequency based, not vector similarity. */
  score: number;
  metadata?: Record<string, unknown>;
  type?: string;
  source?: string;
}

interface SearchRequestBody {
  query?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Scoring helper
// ---------------------------------------------------------------------------

/**
 * Score a piece of text against a set of query terms.
 *
 * Returns the fraction of unique query terms that appear in the text,
 * so "all 3 of 3 terms found" → 1.0, "2 of 4 terms found" → 0.5.
 * The minimum returned score for any match is 0.1 (to distinguish "matched
 * but weak" from "not matched at all" which returns 0).
 */
function scoreText(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = terms.filter(t => lower.includes(t)).length;
  if (hits === 0) return 0;
  return Math.max(0.1, hits / terms.length);
}

/** Combine multiple field values into a single searchable string. */
function concat(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function embeddingsRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

  /**
   * POST /api/v5/embeddings/search
   *
   * Body: { query: string, limit?: number }
   * Response: { data: SearchResult[], meta: { total: number } }
   *
   * Performs a keyword search across three indices:
   *   1. sessions  — task, response, agent_id, agent_name, status
   *   2. kv_store  — key, value (agent-written runtime memory)
   *   3. feedback  — message, category, agent_id
   *
   * Results are ranked by score descending; sources are labelled for the UI.
   */
  app.post<{ Body: SearchRequestBody }>('/api/v5/embeddings/search', async (req, reply) => {
    const body = (req.body ?? {}) as SearchRequestBody;
    const rawQuery = typeof body.query === 'string' ? body.query.trim() : '';

    if (!rawQuery) {
      return reply.send({ data: [], meta: { total: 0 } });
    }

    const limit = typeof body.limit === 'number' && body.limit > 0
      ? Math.min(body.limit, 200)
      : 20;

    // Tokenise query into lowercase terms (deduplicated, min 2 chars)
    const terms = [...new Set(
      rawQuery.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
    )];

    const results: SearchResult[] = [];

    // -------------------------------------------------------------------------
    // 1. Sessions index
    // -------------------------------------------------------------------------
    try {
      const sessions = adapter.listSessions({ limit: 500 });
      for (const s of sessions) {
        const text = concat(s.task, s.response, s.agent_id, s.agent_name, s.status);
        const score = scoreText(text, terms);
        if (score > 0) {
          results.push({
            id: s.id,
            content: s.task ?? s.response ?? s.agent_id,
            score,
            type: 'session',
            source: s.agent_id,
            metadata: {
              status: s.status,
              agent: s.agent_id,
              model: s.model ?? undefined,
              started_at: s.started_at ?? undefined,
            },
          });
        }
      }
    } catch {
      // sessions table absent — safe to skip
    }

    // -------------------------------------------------------------------------
    // 2. KV store / memory index
    // -------------------------------------------------------------------------
    try {
      const db = adapter.getAgentDatabase().getDb();
      const kvRows = db
        .prepare<[], { key: string; value: string; updated_at: string }>(
          'SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC LIMIT 500'
        )
        .all();

      for (const row of kvRows) {
        const text = concat(row.key, row.value);
        const score = scoreText(text, terms);
        if (score > 0) {
          results.push({
            id: row.key,
            content: row.value.slice(0, 500),
            score,
            type: 'memory',
            source: row.key,
            metadata: { updated_at: row.updated_at },
          });
        }
      }
    } catch {
      // kv_store absent — safe to skip
    }

    // -------------------------------------------------------------------------
    // 3. Feedback index
    // -------------------------------------------------------------------------
    try {
      const feedback = adapter.listFeedback({ limit: 500 });
      for (const f of feedback) {
        const text = concat(f.message, f.category, f.agent_id);
        const score = scoreText(text, terms);
        if (score > 0) {
          results.push({
            id: f.id,
            content: f.message,
            score,
            type: 'feedback',
            source: f.agent_id,
            metadata: {
              category: f.category,
              agent: f.agent_id,
              sentiment: f.sentiment ?? undefined,
              created_at: f.created_at,
            },
          });
        }
      }
    } catch {
      // feedback table absent — safe to skip
    }

    // Sort by score descending, then truncate to requested limit
    results.sort((a, b) => b.score - a.score);
    const page = results.slice(0, limit);

    return reply.send({ data: page, meta: { total: results.length } });
  });
}
