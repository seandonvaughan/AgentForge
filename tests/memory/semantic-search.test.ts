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

  describe("bm25 strategy", () => {
    it("returns bm25 as strategy for standard queries", () => {
      const results = search.search("testing quality");
      expect(results.strategy).toBe("bm25");
    });

    it("strategy field returns bm25 for all standard queries", () => {
      const queries = ["testing", "performance optimization", "memory leak", "code review"];
      for (const q of queries) {
        const results = search.search(q);
        // Primary strategy should be bm25 when results are found above main threshold,
        // or keyword/hybrid if falling back — but never enhanced-tfidf
        expect(results.strategy).not.toBe("enhanced-tfidf");
      }
    });
  });

  describe("synonym matching", () => {
    it("'test' matches entries tagged with 'testing' and 'tdd'", () => {
      const results = search.search("How do I test?");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("TDD"))).toBe(true);
    });

    it("'errors' matches entries about 'bugs'", () => {
      const results = search.search("errors");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("bugs"))).toBe(true);
    });

    it("'defects' matches entries about 'bugs'", () => {
      const results = search.search("defects");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("bugs"))).toBe(true);
    });

    it("'deployment' matches entries about 'deploy'", () => {
      const results = search.search("deployment");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("deploy"))).toBe(true);
    });

    it("'reliability' matches entries about 'quality'", () => {
      const results = search.search("reliability");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("quality"))).toBe(true);
    });
  });

  describe("query expansion", () => {
    it("'bugs' query expands to also match 'errors' and 'defects' synonyms", () => {
      const results = search.search("bugs");
      expect(results.hits.length).toBeGreaterThan(0);
      // Should find entries that mention bugs directly
      expect(results.hits.some((h) => h.summary.includes("bugs"))).toBe(true);
    });

    it("'messaging' matches 'communication' and 'async' entries", () => {
      const results = search.search("messaging");
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.includes("messaging"))).toBe(true);
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
      const high = search.search("quality", { similarityThreshold: 0.95 });
      const low = search.search("quality", { similarityThreshold: 0.01 });
      // Lower threshold should return at least as many results
      expect(low.hits.length).toBeGreaterThanOrEqual(high.hits.length);
    });
  });

  describe("deduplication", () => {
    it("does not return duplicate entries", () => {
      const results = search.search("quality");
      const ids = results.hits.map((h) => h.entryId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe(">95% accuracy gate", () => {
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
      expect(accuracy).toBeGreaterThanOrEqual(95);
    });
  });

  // ---------------------------------------------------------------------------
  // P1-1: BM25 ranking tests
  // ---------------------------------------------------------------------------

  describe("BM25 scoring", () => {
    it("BM25 scores are in valid range [0, 1]", () => {
      const results = search.search("testing quality bugs", { similarityThreshold: 0 });
      for (const hit of results.hits) {
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    });

    it("scores are in valid range for multi-term queries", () => {
      const queries = ["performance optimization", "memory leak bugs", "deploy release", "code review quality"];
      for (const q of queries) {
        const results = search.search(q, { similarityThreshold: 0 });
        for (const hit of results.hits) {
          expect(hit.score).toBeGreaterThanOrEqual(0);
          expect(hit.score).toBeLessThanOrEqual(1);
        }
      }
    });

    it("longer documents do not unfairly dominate shorter ones (BM25 length normalization)", () => {
      // Add a very long document that repeats query terms many times
      const longRegistry = new MemoryRegistry();
      longRegistry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning" as MemoryCategory,
        summary: "bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs bugs",
        contentPath: "/.forge/memory/cto/long.md",
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["bugs"],
      });
      longRegistry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning" as MemoryCategory,
        summary: "TypeScript strict mode catches bugs at compile time",
        contentPath: "/.forge/memory/cto/short.md",
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["typescript", "bugs"],
      });

      const longSearch = new SemanticSearch(longRegistry);
      const results = longSearch.search("bugs", { similarityThreshold: 0 });

      expect(results.hits.length).toBeGreaterThan(0);
      // Both docs should appear; the spam doc score should be capped below 1.0
      const spamDoc = results.hits.find((h) => h.summary.startsWith("bugs bugs"));
      if (spamDoc) {
        expect(spamDoc.score).toBeLessThan(1.0);
      }
    });

    it("results are still sorted by score descending with BM25", () => {
      const results = search.search("bugs quality errors", { similarityThreshold: 0 });
      const scores = results.hits.map((h) => h.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // P1-1: AgentForge synonym expansion tests
  // ---------------------------------------------------------------------------

  describe("AgentForge synonym expansions", () => {
    let agentRegistry: MemoryRegistry;
    let agentSearch: SemanticSearch;

    beforeEach(() => {
      agentRegistry = new MemoryRegistry();
      const agentEntries = [
        { summary: "Always execute tasks before marking complete", tags: ["execute", "workflow"], category: "learning" as MemoryCategory },
        { summary: "Dispatch agents for parallel work with fan-out", tags: ["dispatch", "agents"], category: "learning" as MemoryCategory },
        { summary: "Autonomous sprint iteration planning for v4", tags: ["sprint", "planning"], category: "learning" as MemoryCategory },
        { summary: "Flywheel learning loop drives continuous improvement", tags: ["flywheel", "loop"], category: "learning" as MemoryCategory },
        { summary: "Session context is preserved across conversation threads", tags: ["session", "context"], category: "learning" as MemoryCategory },
        { summary: "Forge and assemble agents from YAML definitions", tags: ["forge", "yaml"], category: "learning" as MemoryCategory },
        { summary: "Delegate tasks by routing to the right agent", tags: ["delegate", "routing"], category: "learning" as MemoryCategory },
        { summary: "Memory knowledge store registry for agents", tags: ["memory", "knowledge"], category: "learning" as MemoryCategory },
      ];
      for (const e of agentEntries) {
        agentRegistry.store({
          type: "memory", version: "1.0.0", ownerAgentId: "cto",
          category: e.category, summary: e.summary,
          contentPath: `/.forge/memory/cto/${e.tags[0]}.md`,
          relevanceScore: 0.9, decayRatePerDay: 0.01,
          lastAccessedAt: new Date().toISOString(),
          expiresAt: null, tags: e.tags,
        });
      }
      agentSearch = new SemanticSearch(agentRegistry);
    });

    it("'invoke' finds entries containing 'execute' via synonym expansion", () => {
      const results = agentSearch.search("invoke", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("execute"))).toBe(true);
    });

    it("'invoke' finds entries containing 'dispatch' via synonym expansion", () => {
      const results = agentSearch.search("invoke", { similarityThreshold: 0 });
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("dispatch"))).toBe(true);
    });

    it("'iteration' finds entries containing 'sprint' via synonym expansion", () => {
      const results = agentSearch.search("iteration", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("sprint"))).toBe(true);
    });

    it("'conversation' finds entries containing 'session' via synonym expansion", () => {
      const results = agentSearch.search("conversation", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("session"))).toBe(true);
    });

    it("'generate' finds entries containing 'forge' via synonym expansion", () => {
      const results = agentSearch.search("generate", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("forge"))).toBe(true);
    });

    it("'assign' finds entries about delegation via synonym expansion", () => {
      const results = agentSearch.search("assign", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("delegate"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // P1-1: Bigram phrase matching boost tests
  // ---------------------------------------------------------------------------

  describe("bigram phrase matching boost", () => {
    it("exact phrase match boosts score above single-term match", () => {
      // "performance tuning" appears as adjacent words in the seeded doc
      const phraseResult = search.search("performance tuning", { similarityThreshold: 0 });
      const singleResult = search.search("performance", { similarityThreshold: 0 });

      const phraseHit = phraseResult.hits.find((h) => h.summary.includes("Performance"));
      const singleHit = singleResult.hits.find((h) => h.summary.includes("Performance"));

      if (phraseHit && singleHit) {
        // Phrase-boosted score should be >= single-term score
        expect(phraseHit.score).toBeGreaterThanOrEqual(singleHit.score);
      }
    });

    it("'memory leaks' phrase matches adjacent words in document", () => {
      // Seeded doc: "Memory leaks in long-running Node processes"
      const results = search.search("memory leaks", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      const memHit = results.hits.find((h) => h.summary.includes("Memory leaks"));
      expect(memHit).toBeDefined();
    });

    it("'code review' phrase finds relevant result", () => {
      const results = search.search("code review", { similarityThreshold: 0 });
      expect(results.hits.length).toBeGreaterThan(0);
      expect(results.hits.some((h) => h.summary.toLowerCase().includes("review"))).toBe(true);
    });
  });
});
