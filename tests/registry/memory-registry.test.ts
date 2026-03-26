import { describe, it, expect, beforeEach } from "vitest";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import type { MemoryRegistryEntry, MemoryCategory } from "../../src/types/v4-api.js";

function makeEntry(overrides: Partial<MemoryRegistryEntry> = {}): Omit<MemoryRegistryEntry, "id" | "createdAt" | "updatedAt"> {
  return {
    type: "memory",
    version: "1.0.0",
    ownerAgentId: "cto",
    category: "learning" as MemoryCategory,
    summary: "TDD improves code quality",
    contentPath: "/.forge/memory/cto/learning-001.md",
    relevanceScore: 0.95,
    decayRatePerDay: 0.01,
    lastAccessedAt: new Date().toISOString(),
    expiresAt: null,
    tags: ["testing", "quality"],
    ...overrides,
  };
}

describe("MemoryRegistry", () => {
  let registry: MemoryRegistry;
  beforeEach(() => { registry = new MemoryRegistry(); });

  describe("store", () => {
    it("stores an entry and assigns an id", () => {
      const entry = registry.store(makeEntry());
      expect(entry.id).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
      expect(entry.category).toBe("learning");
    });
    it("assigns unique ids", () => {
      const a = registry.store(makeEntry({ summary: "A" }));
      const b = registry.store(makeEntry({ summary: "B" }));
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("get / getAll", () => {
    it("retrieves stored entry by id", () => {
      const stored = registry.store(makeEntry());
      const retrieved = registry.get(stored.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.summary).toBe(stored.summary);
    });
    it("returns null for unknown id", () => {
      expect(registry.get("nonexistent")).toBeNull();
    });
    it("getAll returns all entries", () => {
      registry.store(makeEntry({ summary: "A" }));
      registry.store(makeEntry({ summary: "B" }));
      expect(registry.getAll()).toHaveLength(2);
    });
  });

  describe("getByAgent", () => {
    it("filters entries by ownerAgentId", () => {
      registry.store(makeEntry({ ownerAgentId: "cto" }));
      registry.store(makeEntry({ ownerAgentId: "architect" }));
      registry.store(makeEntry({ ownerAgentId: "cto" }));
      expect(registry.getByAgent("cto")).toHaveLength(2);
      expect(registry.getByAgent("architect")).toHaveLength(1);
    });
  });

  describe("getByCategory", () => {
    it("filters entries by category", () => {
      registry.store(makeEntry({ category: "learning" }));
      registry.store(makeEntry({ category: "mistake" }));
      registry.store(makeEntry({ category: "learning" }));
      expect(registry.getByCategory("learning")).toHaveLength(2);
      expect(registry.getByCategory("mistake")).toHaveLength(1);
    });
  });

  describe("search by tags", () => {
    it("searchByTags returns entries matching any tag", () => {
      registry.store(makeEntry({ tags: ["testing", "quality"] }));
      registry.store(makeEntry({ tags: ["performance", "scale"] }));
      registry.store(makeEntry({ tags: ["quality", "review"] }));
      const results = registry.searchByTags(["quality"]);
      expect(results).toHaveLength(2);
    });
    it("searchByTags with multiple tags returns union", () => {
      registry.store(makeEntry({ tags: ["a"] }));
      registry.store(makeEntry({ tags: ["b"] }));
      registry.store(makeEntry({ tags: ["c"] }));
      const results = registry.searchByTags(["a", "b"]);
      expect(results).toHaveLength(2);
    });
    it("searchByTags returns empty for no matches", () => {
      registry.store(makeEntry({ tags: ["x"] }));
      expect(registry.searchByTags(["y"])).toHaveLength(0);
    });
  });

  describe("search by keyword", () => {
    it("searchByKeyword matches against summary", () => {
      registry.store(makeEntry({ summary: "TDD improves code quality" }));
      registry.store(makeEntry({ summary: "Performance tuning tips" }));
      const results = registry.searchByKeyword("quality");
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain("quality");
    });
    it("case-insensitive keyword search", () => {
      registry.store(makeEntry({ summary: "TDD Workflow" }));
      expect(registry.searchByKeyword("tdd")).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates an existing entry", () => {
      const stored = registry.store(makeEntry({ relevanceScore: 0.9 }));
      const updated = registry.update(stored.id, { relevanceScore: 0.5 });
      expect(updated.relevanceScore).toBe(0.5);
      expect(updated.updatedAt).toBeTruthy();
      expect(updated.id).toBe(stored.id);
    });
    it("throws for unknown id", () => {
      expect(() => registry.update("nope", { relevanceScore: 0.1 })).toThrow(/not found/);
    });
  });

  describe("remove", () => {
    it("removes entry by id", () => {
      const stored = registry.store(makeEntry());
      registry.remove(stored.id);
      expect(registry.get(stored.id)).toBeNull();
    });
    it("throws for unknown id", () => {
      expect(() => registry.remove("nope")).toThrow(/not found/);
    });
  });

  describe("access tracking", () => {
    it("recordAccess updates lastAccessedAt", () => {
      const stored = registry.store(makeEntry());
      const before = stored.lastAccessedAt;
      const accessed = registry.recordAccess(stored.id);
      expect(new Date(accessed.lastAccessedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe("decay", () => {
    it("applyDecay reduces relevance scores based on time since last access", () => {
      const old = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
      const stored = registry.store(makeEntry({
        relevanceScore: 1.0,
        decayRatePerDay: 0.05,
        lastAccessedAt: old,
      }));
      registry.applyDecay();
      const decayed = registry.get(stored.id)!;
      // After 10 days at 0.05/day: 1.0 - (10 * 0.05) = 0.50
      expect(decayed.relevanceScore).toBeCloseTo(0.5, 1);
    });
    it("does not decay below 0.0", () => {
      const ancient = new Date(Date.now() - 100 * 86400000).toISOString();
      const stored = registry.store(makeEntry({
        relevanceScore: 1.0,
        decayRatePerDay: 0.05,
        lastAccessedAt: ancient,
      }));
      registry.applyDecay();
      const decayed = registry.get(stored.id)!;
      expect(decayed.relevanceScore).toBe(0.0);
    });
  });

  describe("expiration", () => {
    it("removeExpired purges entries past their expiresAt", () => {
      const past = new Date(Date.now() - 1000).toISOString();
      registry.store(makeEntry({ expiresAt: past, summary: "expired" }));
      registry.store(makeEntry({ expiresAt: null, summary: "permanent" }));
      const removed = registry.removeExpired();
      expect(removed).toBe(1);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getAll()[0].summary).toBe("permanent");
    });
    it("removeExpired returns 0 when nothing to purge", () => {
      registry.store(makeEntry({ expiresAt: null }));
      expect(registry.removeExpired()).toBe(0);
    });
  });

  describe("deduplication", () => {
    it("findDuplicates returns entries with similarity above threshold", () => {
      registry.store(makeEntry({ summary: "TDD improves quality", tags: ["testing"] }));
      registry.store(makeEntry({ summary: "TDD improves code quality", tags: ["testing"] }));
      registry.store(makeEntry({ summary: "Performance monitoring", tags: ["ops"] }));
      // Keyword-based dedup: both share "TDD" and "quality"
      const dupes = registry.findPotentialDuplicates("TDD quality");
      expect(dupes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("immutability", () => {
    it("returned entries are copies, not references", () => {
      const stored = registry.store(makeEntry());
      const retrieved = registry.get(stored.id)!;
      retrieved.summary = "MUTATED";
      expect(registry.get(stored.id)!.summary).not.toBe("MUTATED");
    });
  });

  describe("count", () => {
    it("returns the number of entries", () => {
      expect(registry.count()).toBe(0);
      registry.store(makeEntry());
      registry.store(makeEntry());
      expect(registry.count()).toBe(2);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits memory lifecycle events when bus is provided", () => {
      const bus = new V4MessageBus();
      const busRegistry = new MemoryRegistry(bus);

      const entry = busRegistry.store(makeEntry());
      expect(bus.getHistoryForTopic("memory.stored")).toHaveLength(1);

      busRegistry.update(entry.id, { relevanceScore: 0.5 });
      expect(bus.getHistoryForTopic("memory.updated")).toHaveLength(1);

      busRegistry.remove(entry.id);
      expect(bus.getHistoryForTopic("memory.removed")).toHaveLength(1);

      // Test expired
      const past = new Date(Date.now() - 1000).toISOString();
      busRegistry.store(makeEntry({ expiresAt: past }));
      busRegistry.removeExpired();
      expect(bus.getHistoryForTopic("memory.expired")).toHaveLength(1);
    });
  });
});
