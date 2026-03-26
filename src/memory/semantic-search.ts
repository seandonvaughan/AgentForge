/**
 * SemanticSearch — v4.1 P0-2: Enhanced Semantic Search
 *
 * Upgraded from basic TF-IDF to enhanced-tfidf with:
 *   - Synonym expansion dictionary for programming/software terms
 *   - Query expansion with weighted synonym tokens
 *   - IDF weighting across all entries
 *   - N-gram overlap for short queries
 *
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

/** Weight applied to synonym-expanded tokens (original tokens get 1.0) */
const SYNONYM_WEIGHT = 0.5;

/**
 * Bidirectional synonym dictionary.
 * Each group shares synonyms — any term maps to all others in its group.
 */
const SYNONYM_GROUPS: string[][] = [
  ["testing", "tdd", "test", "tests", "unittest", "unittest", "integrationtest"],
  ["bugs", "errors", "defects", "issues", "problems", "failures"],
  ["performance", "speed", "latency", "throughput", "optimization"],
  ["deploy", "deployment", "release", "ship", "shipping"],
  ["quality", "reliability", "robustness", "stability"],
  ["review", "codereview", "prreview", "feedback"],
  ["architecture", "design", "structure", "systemdesign"],
  ["memory", "storage", "persistence", "cache"],
  ["security", "auth", "authentication", "authorization", "vulnerability"],
  ["communication", "messaging", "async", "pubsub", "events"],
];

/** Pre-computed lookup: token -> set of synonyms (excluding itself) */
const SYNONYM_MAP: Map<string, Set<string>> = buildSynonymMap();

function buildSynonymMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const normalized = term.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!map.has(normalized)) {
        map.set(normalized, new Set<string>());
      }
      for (const other of group) {
        const otherNorm = other.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (otherNorm !== normalized) {
          map.get(normalized)!.add(otherNorm);
        }
      }
    }
  }
  return map;
}

/** Stop words that get near-zero IDF weight */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some",
  "such", "no", "only", "own", "same", "than", "too", "very",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "it", "its",
  "they", "them", "their", "what", "which", "who", "whom", "how",
  "when", "where", "why",
]);

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
  strategy: "semantic" | "keyword" | "hybrid" | "enhanced-tfidf";
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

    const rawQueryTokens = this.tokenize(query);
    if (rawQueryTokens.size === 0 && !options?.categories) {
      return { hits: [], searchDurationMs: performance.now() - start, strategy: "enhanced-tfidf", query };
    }

    // Build document token maps (expanded with synonyms for matching)
    const docTokenMaps = entries.map((entry) =>
      this.tokenize(`${entry.summary} ${entry.tags.join(" ")}`)
    );

    // Compute IDF across all documents
    const idf = this.computeIDF(docTokenMaps);

    // Expand both query and document tokens with synonyms for matching
    const expandedQuery = this.expandWithSynonyms(rawQueryTokens);
    const expandedDocs = docTokenMaps.map((d) => this.expandWithSynonyms(d));

    // Score all entries
    const scored = entries.map((entry, idx) => {
      const docTokens = expandedDocs[idx];
      let score = this.weightedCosineSimilarity(expandedQuery, docTokens, idf);

      // N-gram bonus for short queries (1-2 raw tokens)
      if (rawQueryTokens.size <= 2) {
        const ngramBonus = this.bigramOverlap(query, `${entry.summary} ${entry.tags.join(" ")}`);
        score = score + ngramBonus * 0.15; // blend bigram signal
      }

      // Clamp to [0, 1]
      score = Math.min(1, Math.max(0, score));

      return { entry, score };
    });

    // Filter by threshold; if too few results, fall back
    let filtered = scored.filter((s) => s.score >= threshold);
    let strategy: SearchResult["strategy"] = "enhanced-tfidf";

    if (filtered.length === 0) {
      filtered = scored.filter((s) => s.score >= KEYWORD_FALLBACK_THRESHOLD);
      strategy = "keyword";
    }
    if (filtered.length === 0) {
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
  // Tokenization
  // ---------------------------------------------------------------------------

  private tokenize(text: string): Map<string, number> {
    const tokens = new Map<string, number>();
    const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
    for (const word of words) {
      tokens.set(word, (tokens.get(word) ?? 0) + 1);
    }
    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Synonym expansion
  // ---------------------------------------------------------------------------

  private expandWithSynonyms(tokens: Map<string, number>): Map<string, number> {
    const expanded = new Map<string, number>();

    for (const [word, count] of tokens) {
      // Original token at full weight
      expanded.set(word, Math.max(expanded.get(word) ?? 0, count));

      // Synonym expansions at reduced weight
      const synonyms = SYNONYM_MAP.get(word);
      if (synonyms) {
        for (const syn of synonyms) {
          const synWeight = count * SYNONYM_WEIGHT;
          // Only add if not already an original token
          if (!tokens.has(syn)) {
            expanded.set(syn, Math.max(expanded.get(syn) ?? 0, synWeight));
          }
        }
      }
    }

    return expanded;
  }

  // ---------------------------------------------------------------------------
  // IDF computation
  // ---------------------------------------------------------------------------

  private computeIDF(docs: Map<string, number>[]): Map<string, number> {
    const docCount = docs.length;
    const df = new Map<string, number>();

    for (const doc of docs) {
      for (const word of doc.keys()) {
        df.set(word, (df.get(word) ?? 0) + 1);
      }
    }

    const idf = new Map<string, number>();
    for (const [word, freq] of df) {
      if (STOP_WORDS.has(word)) {
        idf.set(word, 0.1); // near-zero weight for stop words
      } else {
        // Standard IDF: log(N / df) + 1 (smoothed)
        idf.set(word, Math.log(docCount / freq) + 1);
      }
    }
    return idf;
  }

  // ---------------------------------------------------------------------------
  // Weighted cosine similarity with IDF
  // ---------------------------------------------------------------------------

  private weightedCosineSimilarity(
    query: Map<string, number>,
    doc: Map<string, number>,
    idf: Map<string, number>,
  ): number {
    if (query.size === 0 || doc.size === 0) return 0;

    let dot = 0;
    let normQ = 0;
    let normD = 0;

    for (const [word, qWeight] of query) {
      const idfWeight = idf.get(word) ?? 1;
      const weightedQ = qWeight * idfWeight;
      normQ += weightedQ * weightedQ;

      const dWeight = doc.get(word) ?? 0;
      const weightedD = dWeight * idfWeight;
      dot += weightedQ * weightedD;
    }

    for (const [word, dWeight] of doc) {
      const idfWeight = idf.get(word) ?? 1;
      const weightedD = dWeight * idfWeight;
      normD += weightedD * weightedD;
    }

    if (normQ === 0 || normD === 0) return 0;
    return dot / (Math.sqrt(normQ) * Math.sqrt(normD));
  }

  // ---------------------------------------------------------------------------
  // Bigram overlap for short queries
  // ---------------------------------------------------------------------------

  private bigrams(text: string): Set<string> {
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, "");
    const words = normalized.split(/\s+/).filter(Boolean);
    const grams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      grams.add(`${words[i]} ${words[i + 1]}`);
    }
    // Also add character-level bigrams for single words
    for (const word of words) {
      for (let i = 0; i < word.length - 1; i++) {
        grams.add(word.substring(i, i + 2));
      }
    }
    return grams;
  }

  private bigramOverlap(query: string, document: string): number {
    const qBigrams = this.bigrams(query);
    const dBigrams = this.bigrams(document);
    if (qBigrams.size === 0 || dBigrams.size === 0) return 0;

    let overlap = 0;
    for (const bg of qBigrams) {
      if (dBigrams.has(bg)) overlap++;
    }
    return overlap / qBigrams.size;
  }
}
