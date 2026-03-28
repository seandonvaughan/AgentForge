import type { CacheEntry, CacheConfig } from './types.js';

function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const normalize = (s: string) => s.toLowerCase().trim();
  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1;

  // Jaccard similarity on word sets
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export class ResponseCache {
  private entries: Map<string, CacheEntry> = new Map();
  private config: CacheConfig;
  private hits = 0;
  private misses = 0;
  private totalSavingsUsd = 0;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      ttlMs: config.ttlMs ?? 5 * 60 * 1000, // 5 minutes default
      maxEntries: config.maxEntries ?? 500,
      similarityThreshold: config.similarityThreshold ?? 0.85,
    };
  }

  store(key: string, response: unknown, costUsd: number): CacheEntry {
    this.evictExpired();

    if (this.entries.size >= this.config.maxEntries) {
      // Evict oldest entry
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }

    const now = Date.now();
    const entry: CacheEntry = {
      key,
      response,
      costUsd,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      hits: 0,
    };

    this.entries.set(key, entry);
    return entry;
  }

  lookup(key: string): CacheEntry | null {
    this.evictExpired();

    // Exact match first
    const exact = this.entries.get(key);
    if (exact && exact.expiresAt > Date.now()) {
      exact.hits++;
      this.hits++;
      this.totalSavingsUsd += exact.costUsd;
      return exact;
    }

    // Semantic similarity search
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) continue;
      const similarity = stringSimilarity(key, entryKey);
      if (similarity >= this.config.similarityThreshold) {
        entry.hits++;
        this.hits++;
        this.totalSavingsUsd += entry.costUsd;
        return entry;
      }
    }

    this.misses++;
    return null;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      entries: this.entries.size,
      totalSavingsUsd: this.totalSavingsUsd,
    };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
