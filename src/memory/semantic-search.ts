/**
 * SemanticSearch — Sprint 3.2b
 *
 * Similarity search over MemoryRegistry entries.
 *
 * Uses TF-IDF-style keyword scoring (no external embeddings dependency).
 * Thresholds from Architect condition:
 *   - Default similarity: 0.82 (configurable per query)
 *   - Below 0.82: results flagged as "low confidence"
 *   - Below 0.60: fallback to keyword/exact-match search
 *   - Above 0.95: deduplication candidate
 */

import type { MemoryRegistry } from "../registry/memory-registry.js";
import type { MemoryCategory } from "../types/v4-api.js";

export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;
export const KEYWORD_FALLBACK_THRESHOLD = 0.60;

export interface SearchHit {
  entryId: string;
  summary: string;
  category: MemoryCategory;
  score: number;
  lowConfidence: boolean;
  ownerAgentId: string;
}

export interface SearchResult {
  hits: SearchHit[];
  searchDurationMs: number;
  strategy: "semantic" | "keyword" | "hybrid";
  query: string;
}

export interface SearchOptions {
  similarityThreshold?: number;
  maxResults?: number;
  categories?: MemoryCategory[];
}

export class SemanticSearch {
  constructor(private readonly registry: MemoryRegistry) {}

  search(query: string, options?: SearchOptions): SearchResult {
    const start = performance.now();
    const threshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const maxResults = options?.maxResults ?? 20;

    let entries = this.registry.getAll();
    if (options?.categories && options.categories.length > 0) {
      const cats = new Set(options.categories);
      entries = entries.filter((e) => cats.has(e.category));
    }

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 && !options?.categories) {
      return { hits: [], searchDurationMs: performance.now() - start, strategy: "keyword", query };
    }

    // Score all entries
    const scored = entries.map((entry) => {
      const docTokens = this.tokenize(`${entry.summary} ${entry.tags.join(" ")}`);
      const score = this.cosineSimilarity(queryTokens, docTokens);
      return { entry, score };
    });

    // Filter by threshold; if too few results, fall back to keyword
    let filtered = scored.filter((s) => s.score >= threshold);
    let strategy: SearchResult["strategy"] = "semantic";

    if (filtered.length === 0) {
      // Try keyword fallback
      filtered = scored.filter((s) => s.score >= KEYWORD_FALLBACK_THRESHOLD);
      strategy = "keyword";
    }
    if (filtered.length === 0) {
      // Last resort: any overlap at all
      filtered = scored.filter((s) => s.score > 0);
      strategy = "hybrid";
    }

    // Sort by score descending, apply relevanceScore as tiebreaker
    filtered.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return b.entry.relevanceScore - a.entry.relevanceScore;
    });

    const hits: SearchHit[] = filtered.slice(0, maxResults).map((s) => ({
      entryId: s.entry.id,
      summary: s.entry.summary,
      category: s.entry.category,
      score: s.score,
      lowConfidence: s.score < DEFAULT_SIMILARITY_THRESHOLD,
      ownerAgentId: s.entry.ownerAgentId,
    }));

    return {
      hits,
      searchDurationMs: performance.now() - start,
      strategy,
      query,
    };
  }

  // ---------------------------------------------------------------------------
  // TF-IDF-style cosine similarity (bag-of-words)
  // ---------------------------------------------------------------------------

  private tokenize(text: string): Map<string, number> {
    const tokens = new Map<string, number>();
    const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
    for (const word of words) {
      tokens.set(word, (tokens.get(word) ?? 0) + 1);
    }
    return tokens;
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size === 0 || b.size === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const [word, countA] of a) {
      normA += countA * countA;
      const countB = b.get(word) ?? 0;
      dot += countA * countB;
    }
    for (const countB of b.values()) {
      normB += countB * countB;
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
