import { describe, it, expect, beforeEach } from "vitest";
import { FlywheelMonitor, InMemoryFlywheelFileAdapter, type SprintVelocity, type FlywheelHealth } from "../../src/flywheel/flywheel-monitor.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

describe("FlywheelMonitor", () => {
  let monitor: FlywheelMonitor;
  beforeEach(() => { monitor = new FlywheelMonitor(); });

  describe("recordSprintVelocity", () => {
    it("records velocity for a sprint", () => {
      monitor.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 12, durationMs: 604800000 });
      expect(monitor.getVelocities()).toHaveLength(1);
    });
  });

  describe("velocityRatio", () => {
    it("calculates ratio between consecutive sprints", () => {
      monitor.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 10, durationMs: 604800000 });
      monitor.recordSprintVelocity({ sprintId: "s2", tasksCompleted: 12, tasksPlanned: 12, durationMs: 604800000 });
      const ratio = monitor.getVelocityRatio();
      expect(ratio).toBeCloseTo(1.2, 1);
    });
    it("returns 1.0 with only one sprint", () => {
      monitor.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 10, durationMs: 604800000 });
      expect(monitor.getVelocityRatio()).toBe(1.0);
    });
  });

  describe("recordInheritanceEvent", () => {
    it("tracks inheritance events", () => {
      monitor.recordInheritanceEvent("cto", "arch", "typescript");
      expect(monitor.getInheritanceRate()).toBe(1);
    });
  });

  describe("getFlywheelHealth", () => {
    it("returns health status for all 4 flywheel components", () => {
      const health = monitor.getFlywheelHealth();
      expect(health.components).toHaveLength(4);
      expect(health.components.map((c) => c.name)).toEqual([
        "meta-learning",
        "graduated-autonomy",
        "capability-inheritance",
        "velocity-acceleration",
      ]);
    });
    it("components start as inactive", () => {
      const health = monitor.getFlywheelHealth();
      expect(health.components.every((c) => !c.active)).toBe(true);
    });
    it("meta-learning activates after insights recorded", () => {
      monitor.recordInsight("Pattern X is effective");
      monitor.recordInsight("Pattern Y should be avoided");
      const health = monitor.getFlywheelHealth();
      const ml = health.components.find((c) => c.name === "meta-learning")!;
      expect(ml.active).toBe(true);
    });
    it("graduated-autonomy activates after promotion recorded", () => {
      monitor.recordPromotionEvent("arch", 1, 2);
      const health = monitor.getFlywheelHealth();
      const ga = health.components.find((c) => c.name === "graduated-autonomy")!;
      expect(ga.active).toBe(true);
    });
    it("capability-inheritance activates after inheritance recorded", () => {
      monitor.recordInheritanceEvent("cto", "arch", "ts");
      const health = monitor.getFlywheelHealth();
      const ci = health.components.find((c) => c.name === "capability-inheritance")!;
      expect(ci.active).toBe(true);
    });
    it("velocity-acceleration activates with ratio > 1.0", () => {
      monitor.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 10, durationMs: 604800000 });
      monitor.recordSprintVelocity({ sprintId: "s2", tasksCompleted: 11, tasksPlanned: 10, durationMs: 604800000 });
      const health = monitor.getFlywheelHealth();
      const va = health.components.find((c) => c.name === "velocity-acceleration")!;
      expect(va.active).toBe(true);
    });
    it("allActive is true when all 4 components active", () => {
      monitor.recordInsight("insight1");
      monitor.recordInsight("insight2");
      monitor.recordPromotionEvent("a", 1, 2);
      monitor.recordInheritanceEvent("a", "b", "skill");
      monitor.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 10, durationMs: 604800000 });
      monitor.recordSprintVelocity({ sprintId: "s2", tasksCompleted: 12, tasksPlanned: 10, durationMs: 604800000 });
      expect(monitor.getFlywheelHealth().allActive).toBe(true);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits flywheel.health.updated on getFlywheelHealth when bus is provided", () => {
      const bus = new V4MessageBus();
      const busMonitor = new FlywheelMonitor(bus);
      busMonitor.getFlywheelHealth();
      expect(bus.getHistoryForTopic("flywheel.health.updated")).toHaveLength(1);
    });
  });

  // --- persistence ---

  describe("persistence", () => {
    it("save/load round-trip preserves all state", () => {
      const fs = new InMemoryFlywheelFileAdapter();
      const m = new FlywheelMonitor({ fileAdapter: fs });

      m.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 10, tasksPlanned: 12, durationMs: 604800000 });
      m.recordSprintVelocity({ sprintId: "s2", tasksCompleted: 14, tasksPlanned: 14, durationMs: 604800000 });
      m.recordInsight("pattern A works");
      m.recordInsight("pattern B fails");
      m.recordPromotionEvent("arch", 1, 2);
      m.recordInheritanceEvent("cto", "arch", "typescript");

      m.save("/tmp/flywheel.json");

      const restored = FlywheelMonitor.load("/tmp/flywheel.json", { fileAdapter: fs });

      expect(restored.getVelocities()).toHaveLength(2);
      expect(restored.getVelocities()[0].sprintId).toBe("s1");
      expect(restored.getVelocities()[1].tasksCompleted).toBe(14);
      expect(restored.getVelocityRatio()).toBeCloseTo(1.4, 1);
      expect(restored.getInheritanceRate()).toBe(1);

      const health = restored.getFlywheelHealth();
      expect(health.components.find((c) => c.name === "meta-learning")!.metric).toBe(2);
      expect(health.components.find((c) => c.name === "graduated-autonomy")!.metric).toBe(1);
      expect(health.components.find((c) => c.name === "capability-inheritance")!.metric).toBe(1);
      expect(health.allActive).toBe(true);
    });

    it("autoSave writes after each record call", () => {
      const fs = new InMemoryFlywheelFileAdapter();
      const m = new FlywheelMonitor({ autoSavePath: "/tmp/auto.json", fileAdapter: fs });

      m.recordInsight("first");
      expect(fs.fileExists("/tmp/auto.json")).toBe(true);

      // Parse and verify incremental saves
      const snap1 = JSON.parse(fs.readFile("/tmp/auto.json"));
      expect(snap1.insights).toEqual(["first"]);

      m.recordInsight("second");
      const snap2 = JSON.parse(fs.readFile("/tmp/auto.json"));
      expect(snap2.insights).toEqual(["first", "second"]);

      m.recordSprintVelocity({ sprintId: "s1", tasksCompleted: 5, tasksPlanned: 5, durationMs: 100 });
      const snap3 = JSON.parse(fs.readFile("/tmp/auto.json"));
      expect(snap3.velocities).toHaveLength(1);

      m.recordPromotionEvent("a", 1, 2);
      const snap4 = JSON.parse(fs.readFile("/tmp/auto.json"));
      expect(snap4.promotions).toHaveLength(1);

      m.recordInheritanceEvent("a", "b", "skill");
      const snap5 = JSON.parse(fs.readFile("/tmp/auto.json"));
      expect(snap5.inheritances).toHaveLength(1);
    });

    it("load with bus parameter preserves bus connectivity", () => {
      const fs = new InMemoryFlywheelFileAdapter();
      const m = new FlywheelMonitor({ fileAdapter: fs });
      m.recordInsight("i1");
      m.recordInsight("i2");
      m.save("/tmp/bus-test.json");

      const bus = new V4MessageBus();
      const restored = FlywheelMonitor.load("/tmp/bus-test.json", { bus, fileAdapter: fs });
      restored.getFlywheelHealth();
      expect(bus.getHistoryForTopic("flywheel.health.updated")).toHaveLength(1);
    });

    it("load from nonexistent file returns fresh FlywheelMonitor", () => {
      const fs = new InMemoryFlywheelFileAdapter();
      const restored = FlywheelMonitor.load("/tmp/does-not-exist.json", { fileAdapter: fs });
      expect(restored.getVelocities()).toHaveLength(0);
      expect(restored.getInheritanceRate()).toBe(0);
      expect(restored.getVelocityRatio()).toBe(1.0);
    });
  });
});
