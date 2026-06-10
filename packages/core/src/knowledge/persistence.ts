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
   * Only consulted when `extractTerms` is true.
   */
  maxEntities?: number | undefined;
  /**
   * v25 — opt-in heuristic term-entity extraction (default OFF).
   *
   * The auto-extracted CamelCase/quoted-phrase terms proved to be chaff in
   * practice (~1800 term entities vs 0 useful notes on disk), so by default
   * writeKnowledgeEntry persists ONLY the full-text note entity. Pass
   * `extractTerms: true` to also mine and persist term entities.
   */
  extractTerms?: boolean | undefined;
}

/**
 * Persist a full-text NOTE entity (and, opt-in, extracted term entities) to
 * `.agentforge/knowledge/entities.jsonl`.
 *
 * Term extraction is purely heuristic (EntityExtractor.extractFromText):
 *   - Quoted strings
 *   - CamelCase identifiers (module/class names)
 *   - Capitalized multi-word phrases
 *
 * v25: term extraction is OFF by default (`extractTerms: true` re-enables it)
 * — the note entity is the useful artifact; term soup flooded the store.
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
  const now = new Date().toISOString();
  const entities: Entity[] = [];

  // v25 — term-entity extraction is opt-in (default OFF). The ~30 heuristic
  // terms per call drowned the store in chaff; only the note below is the
  // default persisted artifact.
  if (opts.extractTerms === true) {
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

    for (const name of cappedNames) {
      entities.push({
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
      });
    }
  }

  // W1 — in addition to the extracted TERMS above, persist one full-text NOTE
  // entity carrying the source text itself. Terms make the graph queryable;
  // notes make it USEFUL as prompt context (kb-retrieval injects note
  // descriptions, not term soup, into agent and planner prompts).
  const noteText = opts.text.replace(/\s+/g, ' ').trim();
  if (noteText.length >= 20) {
    const noteName = noteText.split(' ').slice(0, 8).join(' ');
    entities.push({
      id: randomUUID(),
      name: noteName.length > 80 ? `${noteName.slice(0, 79)}…` : noteName,
      type: 'concept',
      description: noteText.length > 500 ? `${noteText.slice(0, 499)}…` : noteText,
      properties: {
        kind: 'note',
        source: opts.source,
        ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
        ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  if (entities.length === 0) return [];

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
