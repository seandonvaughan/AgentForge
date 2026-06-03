// packages/core/src/team/engine/learnings/lesson-id.ts
//
// Stable, content-addressed identifier for a lesson text.
// sha256(normalised text)[:12] + slug — computed on-read at the dispatch seam.
// Same normalised text → same ID across re-forges; rewording cold-starts (v1).

import { createHash } from 'node:crypto';

function normalizeForHash(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function deriveSlug(t: string): string {
  const tokens = normalizeForHash(t).split(' ').filter((x) => x.length > 3);
  return tokens.slice(0, 4).join('-').slice(0, 48) || 'lesson';
}

/**
 * Compute a stable lesson ID from the lesson's text.
 *
 * Format: `<sha256_hex[:12]>-<slug>`
 *
 * The 12-char hash is the join key; the slug is debug sugar.
 * Normalisation is case-insensitive and strips punctuation so that minor
 * rewording variants of the same lesson produce the same ID.
 */
export function computeLessonId(lessonText: string): string {
  const hash = createHash('sha256').update(normalizeForHash(lessonText)).digest('hex').slice(0, 12);
  return `${hash}-${deriveSlug(lessonText)}`;
}
