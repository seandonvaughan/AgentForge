/**
 * af_kb_search — keyword search over the AgentForge knowledge base's
 * full-text NOTE entities (.agentforge/knowledge/entities.jsonl).
 *
 * Reads the JSONL directly: the mcp-server package deliberately does not
 * depend on @agentforge/core (SQLite weight), so the scoring here mirrors
 * core/src/knowledge/kb-retrieval.ts — keep the two in lockstep.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const AfKbSearchInput = z.object({
  query: z.string().min(1).max(1024),
  k: z.number().int().min(1).max(20).optional(),
});

export type AfKbSearchInputType = z.infer<typeof AfKbSearchInput>;

export interface AfKbSearchHit {
  name: string;
  text: string;
  source: string;
  createdAt: string;
  score: number;
}

export interface AfKbSearchResult {
  ok: boolean;
  data: { hits: AfKbSearchHit[] } | null;
  error: { code: string; message: string } | null;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into',
  'add', 'use', 'new', 'all', 'not', 'when', 'so',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface NoteEntity {
  name?: string;
  description?: string;
  createdAt?: string;
  properties?: { kind?: string; source?: string };
}

export function afKbSearch(input: AfKbSearchInputType, projectRoot: string): AfKbSearchResult {
  const topK = input.k ?? 5;
  const queryTokens = new Set(tokenize(input.query));
  if (queryTokens.size === 0) {
    return { ok: false, data: null, error: { code: 'EMPTY_QUERY', message: 'query has no searchable tokens' } };
  }

  const filePath = join(projectRoot, '.agentforge', 'knowledge', 'entities.jsonl');
  if (!existsSync(filePath)) {
    return { ok: true, data: { hits: [] }, error: null };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: { code: 'READ_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const hits: AfKbSearchHit[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entity: NoteEntity;
    try {
      entity = JSON.parse(trimmed) as NoteEntity;
    } catch {
      continue;
    }
    if (entity.properties?.kind !== 'note') continue;
    if (typeof entity.description !== 'string' || entity.description.length === 0) continue;

    let score = 0;
    for (const t of tokenize(entity.name ?? '')) if (queryTokens.has(t)) score += 2;
    for (const t of tokenize(entity.description)) if (queryTokens.has(t)) score += 1;
    if (score === 0) continue;

    const createdAt = typeof entity.createdAt === 'string' ? entity.createdAt : '';
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays <= 14) score += 0.5;

    hits.push({
      name: entity.name ?? '(unnamed)',
      text: entity.description,
      source: typeof entity.properties?.source === 'string' ? entity.properties.source : 'unknown',
      createdAt,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? 1 : -1));
  return { ok: true, data: { hits: hits.slice(0, topK) }, error: null };
}
