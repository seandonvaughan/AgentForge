import { describe, it, expect, beforeEach } from "vitest";
import { FlywheelMonitor, type SprintVelocity, type FlywheelHealth } from "../../src/flywheel/flywheel-monitor.js";
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
});
