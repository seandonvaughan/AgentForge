/**
 * AgentDatabase — SQLite database wrapper for AgentForge v4.7
 * P0-1: Core database setup with WAL mode + foreign keys
 * P0-7: getSessionTree() for delegation chain traversal
 */

import Sqlite from 'better-sqlite3';
import { ALL_DDL } from './schema.js';
import { QueryCache, SESSION_TREE_TTL_MS } from './query-cache.js';

export interface DatabaseOptions {
  path: string; // ':memory:' for tests
}

export interface SessionRow {
  id: string;
  agent_id: string;
  agent_name: string | null;
  model: string | null;
  task: string;
  response: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  estimated_tokens: number | null;
  autonomy_tier: number | null;
  resume_count: number;
  parent_session_id: string | null;
  delegation_depth: number;
  created_at: string;
}

const MAX_DELEGATION_DEPTH = 20;

export class AgentDatabase {
  private db: Sqlite.Database;
  private readonly cache = new QueryCache();

  constructor(options: DatabaseOptions) {
    this.db = new Sqlite(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.applySchema();
  }

  private applySchema(): void {
    const applyAll = this.db.transaction(() => {
      for (const ddl of ALL_DDL) {
        this.db.prepare(ddl).run();
      }
    });
    applyAll();
  }

  /**
   * Returns the full delegation chain starting from rootId (P0-7).
   * Includes the root session and all descendants ordered by delegation_depth.
   * Throws if depth exceeds MAX_DELEGATION_DEPTH (circular reference guard).
   */
  getSessionTree(rootId: string): SessionRow[] {
    const cacheKey = `session-tree:${rootId}`;
    const cached = this.cache.get<SessionRow[]>(cacheKey);
    if (cached !== undefined) return cached;

    // First verify the root exists
    const root = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(rootId);

    if (!root) {
      // Cache negative result to avoid repeated missing-root queries
      this.cache.set(cacheKey, [], SESSION_TREE_TTL_MS, ['sessions']);
      return [];
    }

    // Iterative BFS to collect all descendants, guarding against cycles.
    // Seed the queue with the already-fetched root row to avoid a double-fetch.
    const visited = new Set<string>();
    const results: SessionRow[] = [];
    const queue: SessionRow[] = [root];

    while (queue.length > 0) {
      const row = queue.shift()!;

      if (visited.has(row.id)) {
        // Cycle detected — skip (visited-set guard prevents re-enqueuing,
        // but guard here for safety)
        continue;
      }

      visited.add(row.id);

      if (row.delegation_depth > MAX_DELEGATION_DEPTH) {
        throw new Error(
          `Delegation depth ${row.delegation_depth} exceeds maximum of ${MAX_DELEGATION_DEPTH} — possible circular reference`
        );
      }

      results.push(row);

      // Find all direct children
      const children = this.db
        .prepare<[string], SessionRow>(
          'SELECT * FROM sessions WHERE parent_session_id = ?'
        )
        .all(row.id);

      for (const child of children) {
        if (!visited.has(child.id)) {
          queue.push(child);
        }
      }
    }

    // Sort by delegation_depth ascending
    results.sort((a, b) => a.delegation_depth - b.delegation_depth);

    this.cache.set(cacheKey, results, SESSION_TREE_TTL_MS, ['sessions']);
    return results;
  }

  /** Expose the shared QueryCache for use by SqliteAdapter. */
  getCache(): QueryCache {
    return this.cache;
  }

  getDb(): Sqlite.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
