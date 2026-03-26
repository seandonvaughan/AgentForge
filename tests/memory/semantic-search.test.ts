import { describe, it, expect, beforeEach } from "vitest";
import { SemanticSearch, DEFAULT_SIMILARITY_THRESHOLD, KEYWORD_FALLBACK_THRESHOLD } from "../../src/memory/semantic-search.js";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";
import type { MemoryCategory } from "../../src/types/v4-api.js";

function seedRegistry(registry: MemoryRegistry) {
  const entries = [
    { summary: "TDD improves code quality and reduces bugs", tags: ["testing", "quality", "tdd"], category: "learning" as MemoryCategory },
    { summary: "Performance tuning requires profiling before optimizing", tags: ["performance", "optimization"], category: "learning" as MemoryCategory },
    { summary: "Never deploy on Friday without rollback plan", tags: ["deployment", "risk"], category: "mistake" as MemoryCategory },
    { summary: "Code review catch rate improves with smaller PRs", tags: ["review", "quality"], category: "learning" as MemoryCategory },
    { summary: "Memory leaks in long-running Node processes", tags: ["memory", "nodejs", "bugs"], category: "mistake" as MemoryCategory },
    { summary: "TypeScript strict mode catches 15% more bugs at compile time", tags: ["typescript", "quality", "bugs"], category: "learning" as MemoryCategory },
    { summary: "Agent collaboration improves with async messaging", tags: ["agents", "communication"], category: "learning" as MemoryCategory },
    { summary: "Budget overruns correlate with scope creep in Phase 2", tags: ["budget", "scope"], category: "mistake" as MemoryCategory },
  ];
  for (const e of entries) {
    registry.store({
      type: "memory", version: "1.0.0", ownerAgentId: "cto",
      category: e.category, summary: e.summary,
      contentPath: `/.forge/memory/cto/${e.tags[0]}.md`,
      relevanceScore: 0.9, decayRatePerDay: 0.01,
      lastAccessedAt: new Date().toISOString(),
      expiresAt: null, tags: e.tags,
    });
  }
}

describe("SemanticSearch", () => {
  let registry: MemoryRegistry;
  let search: SemanticSearch;

  beforeEach(() => {
    registry = new MemoryRegistry();
    search = new SemanticSearch(registry);
    seedRegistry(registry);
  });

  describe("thresholds", () => {
    it("default similarity threshold is 0.82", () => {
      expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.82);
    });
    it("keyword fallback threshold is 0.60", () => {
      expect(KEYWORD_FALLBACK_THRESHOLD).toBe(0.60);
    });
  });

  describe("search", () => {
    it("returns relevant results for a keyword query", () => {
      const results = search.search("testing quality");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("TDD"))).toBe(true);
    });
    it("returns results sorted by relevance score descending", () => {
      const results = search.search("quality bugs");
      const scores = results.hits.map((h) => h.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });
    it("respects maxResults limit", () => {
      const results = search.search("quality", { maxResults: 2 });
      expect(results.hits.length).toBeLessThanOrEqual(2);
    });
    it("filters by category", () => {
      const results = search.search("", { categories: ["mistake"] });
      expect(results.hits.every((h) => h.category === "mistake")).toBe(true);
    });
    it("returns empty for no-match query", () => {
      const results = search.search("quantum entanglement blockchain");
      expect(results.hits).toHaveLength(0);
    });
    it("search duration is tracked", () => {
      const results = search.search("testing");
      expect(results.searchDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("confidence levels", () => {
    it("exact-keyword matches have scores above fallback threshold", () => {
      const results = search.search("TDD testing quality");
      const tddHit = results.hits.find((h) => h.summary.includes("TDD"));
      expect(tddHit).toBeDefined();
      expect(tddHit!.score).toBeGreaterThanOrEqual(KEYWORD_FALLBACK_THRESHOLD);
    });
    it("results with exact keyword matches have reasonable scores", () => {
      const results = search.search("performance");
      expect(results.hits.length).toBeGreaterThan(0);
      const perfHit = results.hits.find((h) => h.summary.includes("Performance"));
      expect(perfHit).toBeDefined();
      expect(perfHit!.score).toBeGreaterThan(0);
    });
  });

  describe("keyword fallback", () => {
    it("falls back to keyword search for broad queries", () => {
      const results = search.search("bugs");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.strategy).toBeDefined();
    });
  });

  describe("custom threshold", () => {
    it("uses custom similarity threshold when provided", () => {
      const strict = search.search("quality", { similarityThreshold: 0.99 });
      const loose = search.search("quality", { similarityThreshold: 0.1 });
      expect(loose.hits.length).toBeGreaterThanOrEqual(strict.hits.length);
    });
  });

  describe("deduplication", () => {
    it("does not return duplicate entries", () => {
      const results = search.search("quality");
      const ids = results.hits.map((h) => h.entryId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe(">90% accuracy gate", () => {
    it("relevant queries return at least one correct result", () => {
      const testQueries = [
        { query: "testing", expectContains: "TDD" },
        { query: "performance optimization", expectContains: "profiling" },
        { query: "deploy Friday", expectContains: "Friday" },
        { query: "code review", expectContains: "review" },
        { query: "memory leak", expectContains: "Memory" },
        { query: "TypeScript strict", expectContains: "TypeScript" },
        { query: "agent messaging", expectContains: "Agent" },
        { query: "budget scope", expectContains: "Budget" },
        { query: "bugs compile", expectContains: "bugs" },
        { query: "smaller PRs", expectContains: "PRs" },
      ];
      let hits = 0;
      for (const tc of testQueries) {
        const results = search.search(tc.query);
        if (results.hits.some((h) => h.summary.includes(tc.expectContains))) {
          hits++;
        }
      }
      const accuracy = (hits / testQueries.length) * 100;
      expect(accuracy).toBeGreaterThanOrEqual(90);
    });
  });
});
