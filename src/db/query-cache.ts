/**
 * QueryCache — TTL-based in-memory cache with tag invalidation.
 *
 * Designed for caching synchronous SQLite query results in the autonomous
 * loop hot-path. Tags group related cache entries so a single write operation
 * can purge all entries that may be stale (e.g., invalidate ALL session-list
 * queries when any session is inserted or updated).
 *
 * Usage:
 *   const cache = new QueryCache();
 *   cache.set('session:abc', row, SESSION_TTL_MS, ['sessions']);
 *   const hit = cache.get<SessionRow>('session:abc'); // undefined on miss/expiry
 *   cache.invalidateTag('sessions');
 */

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly tags: ReadonlyArray<string>;
}

export class QueryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  /** Maps each tag to the set of cache keys associated with it. */
  private readonly tagIndex = new Map<string, Set<string>>();

  /**
   * Retrieve a cached value by key.
   * Returns `undefined` on cache miss or if the entry has expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.evict(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Store a value under `key` for `ttlMs` milliseconds.
   * Provide `tags` to group entries for batch invalidation.
   */
  set<T>(key: string, value: T, ttlMs: number, tags: string[] = []): void {
    // Remove any prior entry for this key (cleans up stale tag associations).
    this.evict(key);

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      tags,
    });

    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Invalidate all cache entries associated with `tag`.
   * Call this from write operations to ensure stale data is never served.
   */
  invalidateTag(tag: string): void {
    const keys = this.tagIndex.get(tag);
    if (!keys) return;
    for (const key of keys) {
      this.entries.delete(key);
    }
    this.tagIndex.delete(tag);
  }

  /** Invalidate all entries associated with any of the given tags. */
  invalidateTags(tags: string[]): void {
    for (const tag of tags) {
      this.invalidateTag(tag);
    }
  }

  /** Remove a single entry and its tag index associations. */
  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const tag of entry.tags) {
      this.tagIndex.get(tag)?.delete(key);
    }
    this.entries.delete(key);
  }

  /** Remove all entries and tag mappings. */
  clear(): void {
    this.entries.clear();
    this.tagIndex.clear();
  }

  /** Number of currently live entries (may include expired ones not yet evicted). */
  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// TTL constants — tuned for the autonomous loop cycle frequency
// ---------------------------------------------------------------------------

/** Individual session lookups: 5 s. Invalidated on any session write. */
export const SESSION_TTL_MS = 5_000;

/**
 * Session list / count queries: 2 s. Shorter because status changes (pending →
 * completed) are the primary driver of loop progress and must be visible quickly.
 */
export const SESSIONS_LIST_TTL_MS = 2_000;

/** Delegation tree traversals: 5 s. Invalidated on any session write. */
export const SESSION_TREE_TTL_MS = 5_000;

/** Cost aggregations: 10 s. Cost data is append-only and rarely hot. */
export const COSTS_TTL_MS = 10_000;

/** Miscellaneous reads (feedback, outcomes, promotions): 5 s. */
export const MISC_TTL_MS = 5_000;
