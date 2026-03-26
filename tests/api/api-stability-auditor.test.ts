import { describe, it, expect, beforeEach } from "vitest";
import {
  APIStabilityAuditor,
  type APIEntry,
  type StabilityLevel,
} from "../../src/api/api-stability-auditor.js";

function makeEntry(overrides?: Partial<APIEntry>): APIEntry {
  return {
    name: "V4MessageBus",
    module: "communication",
    exportType: "class",
    stability: "stable",
    version: "1.0.0",
    ...overrides,
  };
}

describe("APIStabilityAuditor", () => {
  let auditor: APIStabilityAuditor;
  beforeEach(() => { auditor = new APIStabilityAuditor(); });

  describe("register", () => {
    it("registers an API entry", () => {
      auditor.register(makeEntry());
      expect(auditor.count()).toBe(1);
    });
    it("throws on duplicate name within same module", () => {
      auditor.register(makeEntry());
      expect(() => auditor.register(makeEntry())).toThrow(/already registered/);
    });
  });

  describe("classify", () => {
    it("classifies all public APIs as stable/beta/experimental", () => {
      auditor.register(makeEntry({ stability: "stable" }));
      auditor.register(makeEntry({ name: "SemanticSearch", stability: "beta" }));
      auditor.register(makeEntry({ name: "MetaLearning", stability: "experimental" }));
      const report = auditor.generateReport();
      expect(report.stable).toHaveLength(1);
      expect(report.beta).toHaveLength(1);
      expect(report.experimental).toHaveLength(1);
    });
  });

  describe("deprecation", () => {
    it("deprecate marks an API as deprecated with replacement", () => {
      auditor.register(makeEntry({ name: "OldBus" }));
      auditor.deprecate("OldBus", "communication", "Use V4MessageBus instead");
      const entry = auditor.get("OldBus", "communication")!;
      expect(entry.deprecated).toBe(true);
      expect(entry.deprecationMessage).toBe("Use V4MessageBus instead");
    });
    it("getDeprecated returns all deprecated APIs", () => {
      auditor.register(makeEntry({ name: "A" }));
      auditor.register(makeEntry({ name: "B" }));
      auditor.deprecate("A", "communication", "Use B");
      expect(auditor.getDeprecated()).toHaveLength(1);
    });
  });

  describe("breaking change detection", () => {
    it("detectBreakingChanges identifies removed stable APIs", () => {
      auditor.register(makeEntry({ name: "StableAPI", stability: "stable" }));
      const newAuditor = new APIStabilityAuditor();
      // StableAPI missing from new version
      const breaking = auditor.detectBreakingChanges(newAuditor);
      expect(breaking).toHaveLength(1);
      expect(breaking[0].type).toBe("removed");
      expect(breaking[0].name).toBe("StableAPI");
    });
    it("does not flag removed experimental APIs as breaking", () => {
      auditor.register(makeEntry({ name: "ExpAPI", stability: "experimental" }));
      const newAuditor = new APIStabilityAuditor();
      const breaking = auditor.detectBreakingChanges(newAuditor);
      expect(breaking).toHaveLength(0);
    });
    it("flags stability downgrade as breaking", () => {
      auditor.register(makeEntry({ name: "A", stability: "stable" }));
      const newAuditor = new APIStabilityAuditor();
      newAuditor.register(makeEntry({ name: "A", stability: "experimental" }));
      const breaking = auditor.detectBreakingChanges(newAuditor);
      expect(breaking.some((b) => b.type === "stability_downgrade")).toBe(true);
    });
  });

  describe("query", () => {
    it("getByModule returns entries for a module", () => {
      auditor.register(makeEntry({ name: "A", module: "comm" }));
      auditor.register(makeEntry({ name: "B", module: "comm" }));
      auditor.register(makeEntry({ name: "C", module: "session" }));
      expect(auditor.getByModule("comm")).toHaveLength(2);
    });
    it("getByStability filters by stability level", () => {
      auditor.register(makeEntry({ name: "A", stability: "stable" }));
      auditor.register(makeEntry({ name: "B", stability: "beta" }));
      expect(auditor.getByStability("stable")).toHaveLength(1);
    });
  });

  describe("semver audit", () => {
    it("generateReport includes version counts", () => {
      auditor.register(makeEntry({ name: "A", stability: "stable" }));
      auditor.register(makeEntry({ name: "B", stability: "stable" }));
      auditor.register(makeEntry({ name: "C", stability: "beta" }));
      const report = auditor.generateReport();
      expect(report.totalAPIs).toBe(3);
      expect(report.stable).toHaveLength(2);
      expect(report.beta).toHaveLength(1);
      expect(report.experimental).toHaveLength(0);
      expect(report.deprecated).toHaveLength(0);
    });
  });

  describe("immutability", () => {
    it("returned entries are copies", () => {
      auditor.register(makeEntry({ name: "X" }));
      const entry = auditor.get("X", "communication")!;
      entry.stability = "experimental";
      expect(auditor.get("X", "communication")!.stability).toBe("stable");
    });
  });
});
