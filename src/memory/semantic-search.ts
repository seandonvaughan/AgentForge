/**
 * SemanticSearch — v4.4 P1-1: BM25 Ranking with Synonym Expansion
 *
 * Upgraded from enhanced-tfidf to BM25 ranking with:
 *   - BM25 scoring (k1=1.5, b=0.75) replacing raw TF-IDF cosine similarity
 *   - Expanded synonym map with AgentForge-specific domain terms
 *   - Bigram phrase matching with 1.5x score boost for adjacent-pair matches
 *   - Query expansion with weighted synonym tokens
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
  // AgentForge-specific domain terms
  ["invoke", "call", "run", "execute", "dispatch", "trigger"],
  ["agent", "bot", "model", "assistant", "worker"],
  ["sprint", "iteration", "cycle"],
  ["reforge", "mutate", "patch", "override", "tune"],
  ["flywheel", "feedback", "loop", "compounding", "learning"],
  ["bus", "pubsub", "pubsub"],
  ["session", "conversation", "context", "thread"],
  ["forge", "generate", "create", "build", "assemble"],
  ["delegate", "assign", "route", "escalate"],
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
  strategy: "semantic" | "keyword" | "hybrid" | "enhanced-tfidf" | "bm25";
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
      return { hits: [], searchDurationMs: performance.now() - start, strategy: "bm25", query };
    }

    // Build document token maps (raw, without synonym expansion — BM25 uses raw TF)
    const docTokenMaps = entries.map((entry) =>
      this.tokenize(`${entry.summary} ${entry.tags.join(" ")}`)
    );

    // Compute average document length (in tokens) for BM25 normalization
    const totalTokens = docTokenMaps.reduce((sum, d) => {
      let count = 0;
      for (const freq of d.values()) count += freq;
      return sum + count;
    }, 0);
    const avgdl = docTokenMaps.length > 0 ? totalTokens / docTokenMaps.length : 1;

    // Compute IDF across all documents
    const idf = this.computeIDF(docTokenMaps);

    // Expand query tokens with synonyms for matching
    const expandedQuery = this.expandWithSynonyms(rawQueryTokens);

    // Extract query bigrams for phrase-match boost
    const queryBigrams = this.wordBigrams(query);

    // Score all entries using BM25
    const scored = entries.map((entry, idx) => {
      const docText = `${entry.summary} ${entry.tags.join(" ")}`;
      const docTokens = docTokenMaps[idx];
      let docLen = 0;
      for (const freq of docTokens.values()) docLen += freq;

      // BM25 parameters
      const k1 = 1.5;
      const b = 0.75;

      // Sum BM25 contributions for each (possibly synonym-expanded) query term
      let bm25Score = 0;
      for (const [word, queryWeight] of expandedQuery) {
        const idfWeight = idf.get(word) ?? 0;
        if (idfWeight === 0) continue;
        // Try to find raw term OR its synonym forms in the document
        const rawDocFreq = this.resolvedDocFreq(word, docTokens);
        if (rawDocFreq === 0) continue;
        const tf = rawDocFreq;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgdl));
        bm25Score += idfWeight * queryWeight * (numerator / denominator);
      }

      // Bigram phrase-match boost (1.5x multiplier for each matching phrase)
      let phraseBoost = 1.0;
      if (queryBigrams.size > 0) {
        const docBigrams = this.wordBigrams(docText);
        let matchingPhrases = 0;
        for (const phrase of queryBigrams) {
          if (docBigrams.has(phrase)) matchingPhrases++;
        }
        if (matchingPhrases > 0) {
          phraseBoost = 1.5;
        }
      }

      let score = bm25Score * phraseBoost;

      // Normalize BM25 scores into [0, 1].
      // Reference scale: each matched query term contributes ~1 BM25 unit on average;
      // using 0.2 * rawQueryTokens.size as the half-saturation point means a doc
      // scoring ≥ 1 BM25 unit per raw query token reaches ≥ 0.83, consistent with
      // the existing 0.82 similarity threshold.
      const halfSat = Math.max(rawQueryTokens.size, 1) * 0.2;
      score = score / (score + halfSat);

      // Clamp to [0, 1]
      score = Math.min(1, Math.max(0, score));

      return { entry, score };
    });

    // Filter by threshold; if too few results, fall back to progressively lower thresholds
    let filtered = scored.filter((s) => s.score >= threshold);
    let strategy: SearchResult["strategy"] = "bm25";

    if (filtered.length === 0) {
      filtered = scored.filter((s) => s.score >= KEYWORD_FALLBACK_THRESHOLD);
      strategy = "keyword";
    }
    if (filtered.length === 0) {
      filtered = scored.filter((s) => s.score > 0);
      strategy = "hybrid";
    }

    // If the user set a threshold lower than the fallback that was used,
    // include all entries above the user's threshold (monotonicity guarantee)
    if (threshold < KEYWORD_FALLBACK_THRESHOLD && strategy !== "bm25") {
      const wider = scored.filter((s) => s.score >= threshold);
      if (wider.length > filtered.length) {
        filtered = wider;
        strategy = "bm25";
      }
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
  // IDF computation (BM25-style: log((N - df + 0.5) / (df + 0.5) + 1))
  // ---------------------------------------------------------------------------

  private computeIDF(docs: Map<string, number>[]): Map<string, number> {
    const N = docs.length;
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
        // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        idf.set(word, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
      }
    }
    return idf;
  }

  // ---------------------------------------------------------------------------
  // Resolve document frequency for a query term, considering synonym forms
  // ---------------------------------------------------------------------------

  /**
   * Returns the raw frequency of `word` in `docTokens`.
   * For synonym-expanded query terms, the document stores raw (non-expanded) tokens,
   * so we look up the word directly.
   */
  private resolvedDocFreq(word: string, docTokens: Map<string, number>): number {
    return docTokens.get(word) ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Word-level bigrams for phrase matching
  // ---------------------------------------------------------------------------

  /** Returns the set of adjacent word pairs (bigrams) in `text`. */
  private wordBigrams(text: string): Set<string> {
    const normalized = text.toLowerCase().replace(/[^\w\s]/g, "");
    const words = normalized.split(/\s+/).filter(Boolean);
    const grams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      grams.add(`${words[i]} ${words[i + 1]}`);
    }
    return grams;
  }
}
