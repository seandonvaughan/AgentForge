import { describe, it, expect, beforeEach } from "vitest";
import { StorageGovernor, DEFAULT_FILE_LIMIT, WARNING_THRESHOLD_PCT } from "../../src/registry/storage-governor.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

describe("StorageGovernor", () => {
  let gov: StorageGovernor;
  beforeEach(() => { gov = new StorageGovernor(); });

  describe("defaults", () => {
    it("has a default file limit of 10000", () => {
      expect(DEFAULT_FILE_LIMIT).toBe(10000);
    });
    it("warning threshold is 90%", () => {
      expect(WARNING_THRESHOLD_PCT).toBe(90);
    });
  });

  describe("register / count", () => {
    it("registers a file and tracks it", () => {
      gov.registerFile("/.forge/memory/cto/note-1.md", "cto");
      expect(gov.fileCount()).toBe(1);
    });
    it("register is idempotent for same path", () => {
      gov.registerFile("/.forge/memory/cto/note-1.md", "cto");
      gov.registerFile("/.forge/memory/cto/note-1.md", "cto");
      expect(gov.fileCount()).toBe(1);
    });
    it("tracks per-agent quotas", () => {
      gov.registerFile("/.forge/memory/cto/a.md", "cto");
      gov.registerFile("/.forge/memory/cto/b.md", "cto");
      gov.registerFile("/.forge/memory/arch/c.md", "architect");
      expect(gov.fileCountForAgent("cto")).toBe(2);
      expect(gov.fileCountForAgent("architect")).toBe(1);
    });
  });

  describe("unregister", () => {
    it("removes a tracked file", () => {
      gov.registerFile("/.forge/a.md", "cto");
      gov.unregisterFile("/.forge/a.md");
      expect(gov.fileCount()).toBe(0);
    });
    it("throws for unknown file", () => {
      expect(() => gov.unregisterFile("nope")).toThrow(/not tracked/);
    });
  });

  describe("limit enforcement", () => {
    it("canAdd returns true when under limit", () => {
      expect(gov.canAdd()).toBe(true);
    });
    it("canAdd returns false when at limit", () => {
      const small = new StorageGovernor(5);
      for (let i = 0; i < 5; i++) {
        small.registerFile(`/.forge/f${i}.md`, "a");
      }
      expect(small.canAdd()).toBe(false);
    });
    it("registerFile throws when at limit", () => {
      const small = new StorageGovernor(3);
      small.registerFile("a", "x");
      small.registerFile("b", "x");
      small.registerFile("c", "x");
      expect(() => small.registerFile("d", "x")).toThrow(/limit.*exceeded/i);
    });
  });

  describe("warning threshold", () => {
    it("isNearLimit returns false when well below threshold", () => {
      expect(gov.isNearLimit()).toBe(false);
    });
    it("isNearLimit returns true at 90%+ capacity", () => {
      const small = new StorageGovernor(10);
      for (let i = 0; i < 9; i++) {
        small.registerFile(`f${i}`, "a");
      }
      expect(small.isNearLimit()).toBe(true);
    });
  });

  describe("LRU eviction", () => {
    it("evictLRU removes the least-recently-accessed file", () => {
      const small = new StorageGovernor(5);
      small.registerFile("oldest", "a");  // first registered → oldest
      small.registerFile("newer", "a");
      small.registerFile("newest", "a");
      // Access "oldest" to make it fresh
      small.recordAccess("newest");
      small.recordAccess("newer");

      const evicted = small.evictLRU();
      expect(evicted).toBe("oldest");
      expect(small.fileCount()).toBe(2);
    });
    it("evictLRU throws when no files to evict", () => {
      expect(() => gov.evictLRU()).toThrow(/no files/i);
    });
  });

  describe("evictUntilBelow", () => {
    it("evicts enough files to get below target count", () => {
      const small = new StorageGovernor(10);
      for (let i = 0; i < 8; i++) {
        small.registerFile(`f${i}`, "a");
      }
      const evicted = small.evictUntilBelow(5);
      expect(evicted).toHaveLength(3);
      expect(small.fileCount()).toBe(5);
    });
    it("returns empty when already below target", () => {
      const small = new StorageGovernor(10);
      small.registerFile("a", "x");
      expect(small.evictUntilBelow(5)).toHaveLength(0);
    });
  });

  describe("per-agent quota", () => {
    it("setAgentQuota and enforces it", () => {
      gov.setAgentQuota("cto", 3);
      gov.registerFile("a", "cto");
      gov.registerFile("b", "cto");
      gov.registerFile("c", "cto");
      expect(() => gov.registerFile("d", "cto")).toThrow(/agent quota.*exceeded/i);
    });
    it("agents without quota use global limit", () => {
      const small = new StorageGovernor(5);
      for (let i = 0; i < 5; i++) {
        small.registerFile(`f${i}`, "noQuotaAgent");
      }
      expect(() => small.registerFile("f5", "noQuotaAgent")).toThrow(/limit.*exceeded/i);
    });
  });

  describe("usage report", () => {
    it("getUsageReport returns correct stats", () => {
      const small = new StorageGovernor(100);
      small.registerFile("a", "cto");
      small.registerFile("b", "cto");
      small.registerFile("c", "arch");
      const report = small.getUsageReport();
      expect(report.totalFiles).toBe(3);
      expect(report.limit).toBe(100);
      expect(report.usagePct).toBeCloseTo(3, 0);
      expect(report.nearLimit).toBe(false);
      expect(report.perAgent["cto"]).toBe(2);
      expect(report.perAgent["arch"]).toBe(1);
    });
  });

  describe("immutability", () => {
    it("usage report is a snapshot, not a live reference", () => {
      const small = new StorageGovernor(100);
      small.registerFile("a", "cto");
      const report = small.getUsageReport();
      small.registerFile("b", "cto");
      expect(report.totalFiles).toBe(1); // snapshot, not updated
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits storage events when bus is provided", () => {
      const bus = new V4MessageBus();
      // limit=10, warning at 90% = 9 files
      const busGov = new StorageGovernor(10, bus);

      // Fill to 9 files (90% threshold)
      for (let i = 0; i < 9; i++) {
        busGov.registerFile(`f${i}`, "cto");
      }
      // The 9th file crosses 90% threshold
      expect(bus.getHistoryForTopic("storage.warning").length).toBeGreaterThanOrEqual(1);

      // Evict and verify event
      busGov.evictLRU();
      expect(bus.getHistoryForTopic("storage.eviction")).toHaveLength(1);

      // Test quota exceeded
      const busGov2 = new StorageGovernor(100, bus);
      busGov2.setAgentQuota("limited", 1);
      busGov2.registerFile("q1", "limited");
      expect(() => busGov2.registerFile("q2", "limited")).toThrow(/quota/i);
      expect(bus.getHistoryForTopic("storage.quota.exceeded")).toHaveLength(1);
    });
  });
});
