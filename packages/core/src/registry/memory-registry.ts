// packages/core/src/registry/memory-registry.ts
//
// Type-only stub migrated from root src/registry/memory-registry.ts.
// The full MemoryRegistry class (with V4MessageBus integration) remains
// in root src/ until the registry module is itself migrated.
// Only the type shape is needed so that autonomous phase-handler
// constructors can declare their dependency.

import type { MemoryRegistryEntry } from "../team/engine/types/v4-api.js";

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

// Re-export as MemoryRegistry so existing imports resolve unchanged.
export type { MemoryRegistryLike as MemoryRegistry };
