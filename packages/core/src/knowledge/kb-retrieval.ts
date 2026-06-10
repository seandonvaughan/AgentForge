// packages/core/src/knowledge/kb-retrieval.ts
//
// Deterministic keyword retrieval over the knowledge base's full-text NOTE
// entities (W1). Used to inject task-relevant project knowledge into agent
// item prompts and the epic planner prompt, and to back the MCP
// `af_kb_search` tool. Pure keyword scoring — no embeddings dependency, so
// it works identically on every machine; the server's /knowledge/query route
// upgrades to vector search when the embedding index is available.

import type { Entity } from './types.js';
import { loadKnowledgeEntities } from './persistence.js';

export interface KbNoteHit {
  /** Short display name (first words of the note). */
  name: string;
  /** The full note text (≤500 chars at write time). */
  text: string;
  source: string;
  createdAt: string;
  score: number;
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

function isNote(e: Entity): boolean {
  return e.properties?.['kind'] === 'note' && typeof e.description === 'string' && e.description.length > 0;
}

/**
 * Score every note entity against `query` by token overlap (name hits weigh
 * double) with a small recency tiebreak, and return the top-K. Empty array
 * when the KB has no notes or nothing matches.
 */
export function searchKnowledgeNotes(
  projectRoot: string,
  query: string,
  topK = 3,
): KbNoteHit[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const notes = loadKnowledgeEntities(projectRoot).filter(isNote);
  if (notes.length === 0) return [];

  const scored: KbNoteHit[] = [];
  for (const note of notes) {
    const nameTokens = tokenize(note.name);
    const bodyTokens = tokenize(note.description ?? '');
    let score = 0;
    for (const t of nameTokens) if (queryTokens.has(t)) score += 2;
    for (const t of bodyTokens) if (queryTokens.has(t)) score += 1;
    if (score === 0) continue;

    const ageDays = (Date.now() - new Date(note.createdAt).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays <= 14) score += 0.5;

    scored.push({
      name: note.name,
      text: note.description!,
      source: typeof note.properties?.['source'] === 'string' ? (note.properties['source'] as string) : 'unknown',
      createdAt: note.createdAt,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? 1 : -1));
  return scored.slice(0, topK);
}

/**
 * Render hits as a prompt block. Empty string when no hits — callers splice
 * the result directly and get a no-op on fresh repos.
 */
export function buildKbPromptBlock(hits: KbNoteHit[], heading = '## Project knowledge'): string {
  if (hits.length === 0) return '';
  const bullets = hits.map((h) => `- [${h.source}] ${h.text}`);
  return [heading, 'Accumulated findings about THIS repository — treat as ground truth unless the code contradicts it.', '', ...bullets].join('\n');
}
