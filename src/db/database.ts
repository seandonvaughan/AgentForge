/**
 * AgentDatabase — SQLite database wrapper for AgentForge v4.7
 * P0-1: Core database setup with WAL mode + foreign keys
 * P0-7: getSessionTree() for delegation chain traversal
 */

import Sqlite from 'better-sqlite3';
import { ALL_DDL } from './schema.js';

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

  constructor(options: DatabaseOptions) {
    this.db = new Sqlite(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.applySchema();
  }

  private applySchema(): void {
    for (const ddl of ALL_DDL) {
      this.db.prepare(ddl).run();
    }
  }

  /**
   * Returns the full delegation chain starting from rootId (P0-7).
   * Includes the root session and all descendants ordered by delegation_depth.
   * Throws if depth exceeds MAX_DELEGATION_DEPTH (circular reference guard).
   */
  getSessionTree(rootId: string): SessionRow[] {
    // First verify the root exists
    const root = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(rootId);

    if (!root) {
      return [];
    }

    // Check if root already has suspicious depth
    if (root.delegation_depth > MAX_DELEGATION_DEPTH) {
      throw new Error(
        `Delegation depth ${root.delegation_depth} exceeds maximum of ${MAX_DELEGATION_DEPTH} — possible circular reference`
      );
    }

    // Iterative BFS to collect all descendants, guarding against cycles
    const visited = new Set<string>();
    const results: SessionRow[] = [];
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      if (visited.has(currentId)) {
        // Cycle detected
        throw new Error(
          `Circular reference detected in delegation chain at session ${currentId}`
        );
      }

      visited.add(currentId);

      const row = this.db
        .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
        .get(currentId);

      if (row) {
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
          .all(currentId);

        for (const child of children) {
          if (!visited.has(child.id)) {
            queue.push(child.id);
          }
        }
      }
    }

    // Sort by delegation_depth ascending
    results.sort((a, b) => a.delegation_depth - b.delegation_depth);

    return results;
  }

  getDb(): Sqlite.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
