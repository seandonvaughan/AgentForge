/**
 * QueryCache — TTL-based in-memory cache with tag invalidation.
 *
 * Mirrors src/db/query-cache.ts for use in the packages/db workspace package.
 * Kept as a copy to avoid a cross-package dependency on the root src/ layer.
 */

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly tags: ReadonlyArray<string>;
}

export class QueryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly tagIndex = new Map<string, Set<string>>();

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.evict(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, tags: string[] = []): void {
    this.evict(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, tags });
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) { keys = new Set(); this.tagIndex.set(tag, keys); }
      keys.add(key);
    }
  }

  invalidateTag(tag: string): void {
    const keys = this.tagIndex.get(tag);
    if (!keys) return;
    for (const key of keys) this.entries.delete(key);
    this.tagIndex.delete(tag);
  }

  invalidateTags(tags: string[]): void {
    for (const tag of tags) this.invalidateTag(tag);
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const tag of entry.tags) this.tagIndex.get(tag)?.delete(key);
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.tagIndex.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const SESSION_TTL_MS = 5_000;
export const SESSIONS_LIST_TTL_MS = 2_000;
export const COSTS_TTL_MS = 10_000;
export const MISC_TTL_MS = 5_000;
