/**
 * Phase 3 Integration Tests — Sprint 3.3
 *
 * Gate criteria:
 *  - Memory registry contains entries for all agent memory stores
 *  - MCP resource provider passes MCP compliance tests
 *  - Semantic search returns relevant results above 0.82 threshold in >90% of test queries
 *  - Storage governor enforces 10k limit (test: attempt to exceed, verify eviction)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";
import { StorageGovernor, DEFAULT_FILE_LIMIT } from "../../src/registry/storage-governor.js";
import { MCPMemoryProvider } from "../../src/memory/mcp-memory-provider.js";
import { SemanticSearch, DEFAULT_SIMILARITY_THRESHOLD } from "../../src/memory/semantic-search.js";
import type { MemoryCategory } from "../../src/types/v4-api.js";

// Agent list from the v4 27-agent team
const AGENT_IDS = [
  "ceo", "cto", "coo", "cfo",
  "architect", "meta-architect",
  "team-mode-lead", "intelligence-lead", "persistence-lead",
  "org-graph-agent", "delegation-protocol-agent",
  "bus-agent", "review-router-agent", "meeting-coordinator-agent",
  "memory-registry-agent", "mcp-memory-provider", "semantic-search-agent", "storage-governor",
  "session-lifecycle-agent", "reforge-engine-agent", "reforge-guardrail-agent",
  "api-stability-auditor", "pm-agent", "qa-lead",
  "pillar3-test-agent", "pillar4-test-agent", "dashboard-dev",
];

function seedFullRegistry(registry: MemoryRegistry) {
  for (const agentId of AGENT_IDS) {
    registry.store({
      type: "memory", version: "1.0.0", ownerAgentId: agentId,
      category: "learning", summary: `${agentId} initialization memory`,
      contentPath: `/.forge/memory/${agentId}/init.md`,
      relevanceScore: 0.9, decayRatePerDay: 0.005,
      lastAccessedAt: new Date().toISOString(),
      expiresAt: null, tags: [agentId, "init"],
    });
  }
}

describe("Phase 3 gate — memory registry for all agents", () => {
  it("every agent in the 27-agent team has a registry entry", () => {
    const registry = new MemoryRegistry();
    seedFullRegistry(registry);

    for (const agentId of AGENT_IDS) {
      const entries = registry.getByAgent(agentId);
      expect(entries.length).toBeGreaterThanOrEqual(1);
    }
    expect(registry.count()).toBeGreaterThanOrEqual(AGENT_IDS.length);
  });
});

describe("Phase 3 gate — MCP compliance", () => {
  let registry: MemoryRegistry;
  let provider: MCPMemoryProvider;

  beforeEach(() => {
    registry = new MemoryRegistry();
    provider = new MCPMemoryProvider(registry);
    seedFullRegistry(registry);
  });

  it("listResources returns one resource per agent", () => {
    const resources = provider.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(AGENT_IDS.length);
    expect(resources.every((r) => r.uri.startsWith("memory://"))).toBe(true);
  });

  it("readResource returns valid MCP structure for every resource", () => {
    const resources = provider.listResources();
    for (const r of resources) {
      const result = provider.readResource(r.uri);
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe(r.uri);
      expect(result.contents[0].mimeType).toBe("text/markdown");
      expect(result.contents[0].text.length).toBeGreaterThan(0);
    }
  });

  it("write + read round-trip preserves data", () => {
    const { id } = provider.writeResource({
      ownerAgentId: "cto", category: "mistake",
      summary: "Always validate inputs", tags: ["validation"],
    });
    const result = provider.readResource(`memory://${id}`);
    expect(result.contents[0].text).toContain("Always validate inputs");
  });

  it("delete removes the resource", () => {
    const { id } = provider.writeResource({
      ownerAgentId: "cto", category: "learning",
      summary: "Temp entry", tags: [],
    });
    provider.deleteResource(`memory://${id}`);
    expect(() => provider.readResource(`memory://${id}`)).toThrow(/not found/);
  });
});

describe("Phase 3 gate — semantic search >90% accuracy", () => {
  let registry: MemoryRegistry;
  let search: SemanticSearch;

  beforeEach(() => {
    registry = new MemoryRegistry();
    search = new SemanticSearch(registry);
    // Seed diverse knowledge base
    const entries = [
      { summary: "TDD improves code quality and reduces bugs", tags: ["testing", "quality", "tdd"], cat: "learning" as MemoryCategory },
      { summary: "Performance tuning requires profiling before optimizing", tags: ["performance", "profiling"], cat: "learning" as MemoryCategory },
      { summary: "Never deploy on Friday without rollback plan", tags: ["deployment", "risk", "friday"], cat: "mistake" as MemoryCategory },
      { summary: "Code review catch rate improves with smaller PRs", tags: ["review", "quality", "pr"], cat: "learning" as MemoryCategory },
      { summary: "Memory leaks in long-running Node processes", tags: ["memory", "nodejs", "leaks"], cat: "mistake" as MemoryCategory },
      { summary: "TypeScript strict mode catches 15% more bugs at compile time", tags: ["typescript", "quality", "strict"], cat: "learning" as MemoryCategory },
      { summary: "Agent collaboration improves with async messaging", tags: ["agents", "async", "messaging"], cat: "learning" as MemoryCategory },
      { summary: "Budget overruns correlate with scope creep in Phase 2", tags: ["budget", "scope", "overrun"], cat: "mistake" as MemoryCategory },
      { summary: "Delegation protocol must check ancestor authority", tags: ["delegation", "authority", "org-graph"], cat: "learning" as MemoryCategory },
      { summary: "MCP resources use URI scheme for addressability", tags: ["mcp", "uri", "resources"], cat: "learning" as MemoryCategory },
    ];
    for (const e of entries) {
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: e.cat, summary: e.summary, contentPath: "p",
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: e.tags,
      });
    }
  });

  it(">90% of test queries return correct top result", () => {
    const queries = [
      { query: "testing quality TDD", expect: "TDD" },
      { query: "performance profiling", expect: "profiling" },
      { query: "deploy Friday rollback", expect: "Friday" },
      { query: "code review PR", expect: "review" },
      { query: "memory leak Node", expect: "Memory" },
      { query: "TypeScript strict bugs", expect: "TypeScript" },
      { query: "agent async messaging", expect: "Agent" },
      { query: "budget scope overrun", expect: "Budget" },
      { query: "delegation authority", expect: "Delegation" },
      { query: "MCP URI resources", expect: "MCP" },
    ];
    let hits = 0;
    for (const q of queries) {
      const results = search.search(q.query);
      if (results.hits.length > 0 && results.hits[0].summary.includes(q.expect)) hits++;
    }
    expect(hits / queries.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("Phase 3 gate — storage governor 10k limit", () => {
  it("enforces file limit and evicts via LRU", () => {
    const limit = 100; // scaled-down for test speed
    const gov = new StorageGovernor(limit);
    for (let i = 0; i < limit; i++) {
      gov.registerFile(`/.forge/f${i}`, "cto");
    }
    expect(gov.canAdd()).toBe(false);
    expect(() => gov.registerFile("overflow", "cto")).toThrow(/limit.*exceeded/i);

    // Evict one, then add succeeds
    const evicted = gov.evictLRU();
    expect(evicted).toBeTruthy();
    expect(gov.canAdd()).toBe(true);
    gov.registerFile("new-file", "cto");
    expect(gov.fileCount()).toBe(limit);
  });

  it("isNearLimit fires at 90%", () => {
    const gov = new StorageGovernor(100);
    for (let i = 0; i < 89; i++) gov.registerFile(`f${i}`, "a");
    expect(gov.isNearLimit()).toBe(false);
    gov.registerFile("f89", "a");
    expect(gov.isNearLimit()).toBe(true);
  });

  it("DEFAULT_FILE_LIMIT is 10000", () => {
    expect(DEFAULT_FILE_LIMIT).toBe(10000);
  });

  it("per-agent quotas prevent a single agent from monopolizing storage", () => {
    const gov = new StorageGovernor(1000);
    gov.setAgentQuota("greedy", 5);
    for (let i = 0; i < 5; i++) gov.registerFile(`g${i}`, "greedy");
    expect(() => gov.registerFile("g5", "greedy")).toThrow(/agent quota.*exceeded/i);
    // Other agents unaffected
    gov.registerFile("other0", "polite");
    expect(gov.fileCount()).toBe(6);
  });
});

describe("Phase 3 gate — all components compose", () => {
  it("MCP write → semantic search → read round-trip", () => {
    const registry = new MemoryRegistry();
    const provider = new MCPMemoryProvider(registry);
    const search = new SemanticSearch(registry);

    provider.writeResource({
      ownerAgentId: "architect", category: "learning",
      summary: "Event-driven architecture reduces coupling",
      tags: ["architecture", "events"],
    });
    provider.writeResource({
      ownerAgentId: "cto", category: "learning",
      summary: "Microservices increase operational complexity",
      tags: ["architecture", "microservices"],
    });

    const results = search.search("event driven architecture");
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0].summary).toContain("Event-driven");

    // Read via MCP
    const resource = provider.readResource(`memory://${results.hits[0].entryId}`);
    expect(resource.contents[0].text).toContain("Event-driven");
  });

  it("storage governor + memory registry coordinate file tracking", () => {
    const registry = new MemoryRegistry();
    const gov = new StorageGovernor(50);

    for (let i = 0; i < 10; i++) {
      const entry = registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: `Entry ${i}`,
        contentPath: `/.forge/memory/cto/entry-${i}.md`,
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: [],
      });
      gov.registerFile(entry.contentPath, "cto");
    }
    expect(gov.fileCount()).toBe(10);
    expect(registry.count()).toBe(10);
  });
});
