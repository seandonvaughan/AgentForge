/**
 * MemoryRegistry — Sprint 3.1a
 *
 * Central registry of all agent memory stores. Tracks schemas, ownership,
 * access policies, relevance decay, and expiration. Source of truth for
 * what knowledge exists and who can read/write it.
 *
 * Entries are indexed by id, with lookup by agent, category, tags, and keyword.
 */

import { randomUUID } from "node:crypto";
import type { MemoryRegistryEntry, MemoryCategory } from "../types/v4-api.js";

type StoreInput = Omit<MemoryRegistryEntry, "id" | "createdAt" | "updatedAt">;

export class MemoryRegistry {
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

  update(id: string, patch: Partial<Omit<MemoryRegistryEntry, "id" | "createdAt">>): MemoryRegistryEntry {
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

  getByCategory(category: MemoryCategory): MemoryRegistryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.category === category)
      .map((e) => this.clone(e));
  }

  searchByTags(tags: string[]): MemoryRegistryEntry[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return Array.from(this.entries.values())
      .filter((e) => e.tags.some((t) => tagSet.has(t.toLowerCase())))
      .map((e) => this.clone(e));
  }

  searchByKeyword(keyword: string): MemoryRegistryEntry[] {
    const lower = keyword.toLowerCase();
    return Array.from(this.entries.values())
      .filter((e) => e.summary.toLowerCase().includes(lower))
      .map((e) => this.clone(e));
  }

  findPotentialDuplicates(query: string): MemoryRegistryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(this.entries.values())
      .filter((e) => {
        const text = `${e.summary} ${e.tags.join(" ")}`.toLowerCase();
        return words.some((w) => text.includes(w));
      })
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
