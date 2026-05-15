// packages/core/src/knowledge/persistence.ts
//
// Disk-backed persistence for the knowledge graph.
//
// Entities extracted from phase outputs (audit findings, code review) are
// appended to `.agentforge/knowledge/entities.jsonl` so they survive server
// restarts and accumulate across cycles. The server route hydrates its
// in-memory KnowledgeGraph from this file on startup.
//
// Design mirrors writeMemoryEntry() in memory/types.ts:
//   - Synchronous, non-fatal (write failures never break phase results)
//   - Exclusive lock file to prevent concurrent interleaved appends
//   - JSONL format — one JSON object per line, easy to append and read

import { appendFileSync, mkdirSync, readFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EntityExtractor } from './entity-extractor.js';
import type { Entity } from './types.js';

const KNOWLEDGE_DIR = '.agentforge/knowledge';
const ENTITIES_FILE = 'entities.jsonl';

// ── Lock helpers (identical to memory/types.ts pattern) ─────────────────────

function acquireLock(lockPath: string): boolean {
  try {
    // O_CREAT | O_EXCL: atomic create-if-absent — fails if lock already held.
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Input options for `writeKnowledgeEntry`.
 *
 * Every optional field is widened to `T | undefined` so callers under
 * `exactOptionalPropertyTypes: true` can safely pass expressions like
 * `ctx.cycleId` (typed `string | undefined`) without TS2379 errors.
 * The function normalises undefined values — they are omitted from the
 * persisted entity rather than stored as explicit `undefined` properties.
 */
export interface WriteKnowledgeEntryOptions {
  /** Free text to mine entity terms from (audit findings, review output, etc.) */
  text: string;
  /** Phase that produced the text — stored as entity property for filtering. */
  source: 'audit' | 'review' | string;
  /** Additional tags carried as an entity property for downstream consumers. */
  tags?: string[] | undefined;
  /** cycleId attached to each entity's properties so entities are traceable. */
  cycleId?: string | undefined;
  /**
   * Maximum number of entities to extract per call.  Defaults to 30 — enough
   * to capture meaningful signal without flooding the graph with noise terms.
   */
  maxEntities?: number | undefined;
}

/**
 * Extract entity-like terms from `opts.text` and append them to
 * `.agentforge/knowledge/entities.jsonl`.
 *
 * The extraction is purely heuristic (EntityExtractor.extractFromText):
 *   - Quoted strings
 *   - CamelCase identifiers (module/class names)
 *   - Capitalized multi-word phrases
 *
 * Returns the entities written.  Write failures are swallowed so phase
 * results are never affected by knowledge persistence errors.
 */
export function writeKnowledgeEntry(
  projectRoot: string,
  opts: WriteKnowledgeEntryOptions,
): Entity[] {
  if (!opts.text) return [];

  const extractor = new EntityExtractor();
  const rawNames = extractor.extractFromText(opts.text);

  // Deduplicate names (case-insensitive) and cap the result set.
  const seen = new Set<string>();
  const uniqueNames: string[] = [];
  for (const name of rawNames) {
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      uniqueNames.push(name);
    }
  }
  const cappedNames = uniqueNames.slice(0, opts.maxEntities ?? 30);
  if (cappedNames.length === 0) return [];

  const now = new Date().toISOString();
  const entities: Entity[] = cappedNames.map(name => ({
    id: randomUUID(),
    name,
    type: extractor.inferType(name),
    properties: {
      source: opts.source,
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    },
    createdAt: now,
    updatedAt: now,
  }));

  try {
    const knowledgeDir = join(projectRoot, KNOWLEDGE_DIR);
    mkdirSync(knowledgeDir, { recursive: true });

    const filePath = join(knowledgeDir, ENTITIES_FILE);
    const lockPath = `${filePath}.lock`;
    const locked = acquireLock(lockPath);
    try {
      const lines = entities.map(e => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(filePath, lines, 'utf8');
    } finally {
      if (locked) releaseLock(lockPath);
    }
  } catch {
    // non-fatal — phase result must not be affected by knowledge write failures
  }

  return entities;
}

/**
 * Load all persisted entity entries from `.agentforge/knowledge/entities.jsonl`.
 *
 * Returns an empty array when the file is absent or unreadable.  Malformed
 * lines are silently skipped so a single corrupt entry cannot prevent the
 * rest of the graph from loading.
 *
 * Intended to be called once at server startup to hydrate the in-memory
 * KnowledgeGraph from the cycle-accumulated entity store.
 */
export function loadKnowledgeEntities(projectRoot: string): Entity[] {
  try {
    const filePath = join(projectRoot, KNOWLEDGE_DIR, ENTITIES_FILE);
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const entities: Entity[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Entity;
        if (parsed && typeof parsed === 'object' && parsed.id && parsed.name && parsed.type) {
          entities.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return entities;
  } catch {
    return [];
  }
}
