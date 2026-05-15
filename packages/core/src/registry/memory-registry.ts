// packages/core/src/registry/memory-registry.ts
//
// Full MemoryRegistry class migrated from root src/registry/memory-registry.ts.
// The class implements MemoryRegistryLike so phase-handlers can inject it by
// interface while tests (and runtime callers) can instantiate it directly.

import { randomUUID } from "node:crypto";
import type { MemoryRegistryEntry, MemoryCategory } from "../team/engine/types/v4-api.js";

type StoreInput = Omit<MemoryRegistryEntry, "id" | "createdAt" | "updatedAt">;

/**
 * Minimal interface matching the MemoryRegistry class contract
 * used by ReviewPhaseHandler and ExecutePhaseHandler.
 */
export interface MemoryRegistryLike {
  store(input: StoreInput): MemoryRegistryEntry;
  get(id: string): MemoryRegistryEntry | null;
  getAll(): MemoryRegistryEntry[];
  findByTags(tags: string[]): MemoryRegistryEntry[];
  findByCategory(category: string): MemoryRegistryEntry[];
  /** Tag-based search (OR match) ordered by relevance. */
  searchByTags(tags: string[]): MemoryRegistryEntry[];
  /** Category-based lookup. */
  getByCategory(category: string): MemoryRegistryEntry[];
}

/**
 * Central in-memory registry of agent memory entries.
 * Tracks schemas, ownership, access policies, relevance decay, and expiration.
 * Source of truth for what knowledge exists and who can read/write it.
 */
export class MemoryRegistry implements MemoryRegistryLike {
  private entries = new Map<string, MemoryRegistryEntry>();

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  store(input: StoreInput): MemoryRegistryEntry {
    const now = new Date().toISOString();
    const entry: MemoryRegistryEntry = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(entry.id, entry);
    return this.clone(entry);
  }

  get(id: string): MemoryRegistryEntry | null {
    const e = this.entries.get(id);
    return e ? this.clone(e) : null;
  }

  getAll(): MemoryRegistryEntry[] {
    return Array.from(this.entries.values()).map((e) => this.clone(e));
  }

  update(
    id: string,
    patch: Partial<Omit<MemoryRegistryEntry, "id" | "createdAt">>,
  ): MemoryRegistryEntry {
    const existing = this.entries.get(id);
    if (!existing) throw new Error(`Memory entry "${id}" not found`);
    const updated: MemoryRegistryEntry = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(id, updated);
    return this.clone(updated);
  }

  remove(id: string): void {
    if (!this.entries.has(id)) throw new Error(`Memory entry "${id}" not found`);
    this.entries.delete(id);
  }

  count(): number {
    return this.entries.size;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getByAgent(agentId: string): MemoryRegistryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.ownerAgentId === agentId)
      .map((e) => this.clone(e));
  }

  getByCategory(category: string): MemoryRegistryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.category === (category as MemoryCategory))
      .map((e) => this.clone(e));
  }

  /** Alias for getByCategory — satisfies MemoryRegistryLike interface. */
  findByCategory(category: string): MemoryRegistryEntry[] {
    return this.getByCategory(category);
  }

  searchByTags(tags: string[]): MemoryRegistryEntry[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return Array.from(this.entries.values())
      .filter((e) => e.tags.some((t) => tagSet.has(t.toLowerCase())))
      .map((e) => this.clone(e));
  }

  /** Alias for searchByTags — satisfies MemoryRegistryLike interface. */
  findByTags(tags: string[]): MemoryRegistryEntry[] {
    return this.searchByTags(tags);
  }

  searchByKeyword(keyword: string): MemoryRegistryEntry[] {
    const lower = keyword.toLowerCase();
    return Array.from(this.entries.values())
      .filter((e) => e.summary.toLowerCase().includes(lower))
      .map((e) => this.clone(e));
  }

  // ---------------------------------------------------------------------------
  // Access tracking & decay
  // ---------------------------------------------------------------------------

  recordAccess(id: string): MemoryRegistryEntry {
    return this.update(id, { lastAccessedAt: new Date().toISOString() });
  }

  applyDecay(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.decayRatePerDay <= 0) continue;
      const lastAccess = new Date(entry.lastAccessedAt).getTime();
      const daysSinceAccess = (now - lastAccess) / 86400000;
      const decayed = Math.max(0, entry.relevanceScore - daysSinceAccess * entry.decayRatePerDay);
      this.entries.set(id, { ...entry, relevanceScore: decayed, updatedAt: new Date().toISOString() });
    }
  }

  // ---------------------------------------------------------------------------
  // Expiration
  // ---------------------------------------------------------------------------

  removeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private clone(entry: MemoryRegistryEntry): MemoryRegistryEntry {
    return { ...entry, tags: [...entry.tags] };
  }
}
