import { describe, it, expect, beforeEach } from "vitest";
import { MCPMemoryProvider } from "../../src/memory/mcp-memory-provider.js";
import { MemoryRegistry } from "../../src/registry/memory-registry.js";

describe("MCPMemoryProvider", () => {
  let registry: MemoryRegistry;
  let provider: MCPMemoryProvider;

  beforeEach(() => {
    registry = new MemoryRegistry();
    provider = new MCPMemoryProvider(registry);
  });

  describe("listResources", () => {
    it("returns empty when registry is empty", () => {
      const resources = provider.listResources();
      expect(resources).toHaveLength(0);
    });
    it("returns MCP resource descriptors for each memory entry", () => {
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "TDD works",
        contentPath: "/.forge/memory/cto/tdd.md",
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["testing"],
      });
      const resources = provider.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toMatch(/^memory:\/\//);
      expect(resources[0].name).toBe("TDD works");
      expect(resources[0].mimeType).toBe("text/markdown");
    });
  });

  describe("readResource", () => {
    it("returns memory content for valid URI", () => {
      const entry = registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "TDD works",
        contentPath: "/.forge/memory/cto/tdd.md",
        relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["testing"],
      });
      const result = provider.readResource(`memory://${entry.id}`);
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe(`memory://${entry.id}`);
      expect(result.contents[0].text).toContain("TDD works");
    });
    it("throws for unknown URI", () => {
      expect(() => provider.readResource("memory://nonexistent")).toThrow(/not found/);
    });
    it("records access on read", () => {
      const entry = registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "Test",
        contentPath: "p", relevanceScore: 0.5, decayRatePerDay: 0.01,
        lastAccessedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: null, tags: [],
      });
      provider.readResource(`memory://${entry.id}`);
      const updated = registry.get(entry.id)!;
      expect(new Date(updated.lastAccessedAt).getFullYear()).toBeGreaterThan(2020);
    });
  });

  describe("writeResource", () => {
    it("stores a new memory entry via MCP write", () => {
      const result = provider.writeResource({
        ownerAgentId: "cto",
        category: "mistake",
        summary: "Never skip tests",
        tags: ["quality"],
      });
      expect(result.id).toBeTruthy();
      expect(registry.count()).toBe(1);
    });
  });

  describe("searchResources", () => {
    it("searches by keyword", () => {
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "Performance tuning guide",
        contentPath: "p", relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["perf"],
      });
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "Testing best practices",
        contentPath: "p", relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["testing"],
      });
      const results = provider.searchResources("performance");
      expect(results).toHaveLength(1);
      expect(results[0].name).toContain("Performance");
    });
    it("searches by tags", () => {
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "A",
        contentPath: "p", relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: ["alpha"],
      });
      const results = provider.searchResources("", { tags: ["alpha"] });
      expect(results).toHaveLength(1);
    });
  });

  describe("deleteResource", () => {
    it("removes a memory entry via MCP delete", () => {
      const entry = registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "Temp",
        contentPath: "p", relevanceScore: 0.5, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: [],
      });
      provider.deleteResource(`memory://${entry.id}`);
      expect(registry.count()).toBe(0);
    });
  });

  describe("MCP compliance", () => {
    it("resource URIs follow memory:// scheme", () => {
      registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "X",
        contentPath: "p", relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: [],
      });
      const resources = provider.listResources();
      expect(resources.every((r) => r.uri.startsWith("memory://"))).toBe(true);
    });
    it("readResource returns standard MCP content structure", () => {
      const entry = registry.store({
        type: "memory", version: "1.0.0", ownerAgentId: "cto",
        category: "learning", summary: "Check",
        contentPath: "p", relevanceScore: 0.9, decayRatePerDay: 0.01,
        lastAccessedAt: new Date().toISOString(),
        expiresAt: null, tags: [],
      });
      const result = provider.readResource(`memory://${entry.id}`);
      expect(result).toHaveProperty("contents");
      expect(result.contents[0]).toHaveProperty("uri");
      expect(result.contents[0]).toHaveProperty("mimeType");
      expect(result.contents[0]).toHaveProperty("text");
    });
  });
});
