import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityInheritance, type AgentSkill, type PropagationResult } from "../../src/flywheel/capability-inheritance.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

describe("CapabilityInheritance", () => {
  let ci: CapabilityInheritance;
  beforeEach(() => { ci = new CapabilityInheritance(); });

  describe("registerSkill", () => {
    it("registers a skill for an agent", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10 });
      expect(ci.getSkills("cto")).toHaveLength(1);
    });
    it("updates existing skill if re-registered", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.5, exerciseCount: 3 });
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10 });
      const skills = ci.getSkills("cto");
      expect(skills).toHaveLength(1);
      expect(skills[0].proficiency).toBe(0.9);
    });
  });

  describe("propagate", () => {
    it("propagates a skill from source to target agent", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10 });
      ci.optIn("architect", "typescript");
      const result = ci.propagate("cto", "architect", "typescript");
      expect(result.success).toBe(true);
      expect(result.targetSkillProficiency).toBeGreaterThan(0);
      const skills = ci.getSkills("architect");
      expect(skills.some((s) => s.skillId === "typescript")).toBe(true);
    });
    it("fails if target has not opted in", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10 });
      const result = ci.propagate("cto", "architect", "typescript");
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/opted-in|opt-in/i);
    });
    it("fails if source does not have the skill", () => {
      ci.optIn("architect", "typescript");
      const result = ci.propagate("cto", "architect", "typescript");
      expect(result.success).toBe(false);
    });
    it("inherited skill has lower proficiency than source", () => {
      ci.registerSkill("cto", { skillId: "ts", proficiency: 0.9, exerciseCount: 10 });
      ci.optIn("arch", "ts");
      ci.propagate("cto", "arch", "ts");
      const skill = ci.getSkills("arch").find((s) => s.skillId === "ts")!;
      expect(skill.proficiency).toBeLessThan(0.9);
      expect(skill.sourceAgentId).toBe("cto");
    });
  });

  describe("opt-in mechanism", () => {
    it("optIn registers interest", () => {
      ci.optIn("architect", "typescript");
      expect(ci.hasOptedIn("architect", "typescript")).toBe(true);
    });
    it("optOut removes interest", () => {
      ci.optIn("architect", "typescript");
      ci.optOut("architect", "typescript");
      expect(ci.hasOptedIn("architect", "typescript")).toBe(false);
    });
  });

  describe("compatibility check", () => {
    it("checkCompatibility returns true for compatible skills", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.8, exerciseCount: 5 });
      expect(ci.checkCompatibility("cto", "architect", "typescript")).toBe(true);
    });
    it("returns false if source proficiency too low", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.2, exerciseCount: 1 });
      expect(ci.checkCompatibility("cto", "architect", "typescript")).toBe(false);
    });
  });

  describe("getPropagationHistory", () => {
    it("tracks all propagation attempts", () => {
      ci.registerSkill("cto", { skillId: "ts", proficiency: 0.9, exerciseCount: 10 });
      ci.optIn("arch", "ts");
      ci.propagate("cto", "arch", "ts");
      const history = ci.getPropagationHistory();
      expect(history).toHaveLength(1);
      expect(history[0].success).toBe(true);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits flywheel.skill.propagated on successful propagation", () => {
      const bus = new V4MessageBus();
      const busCi = new CapabilityInheritance(bus);
      busCi.registerSkill("cto", { skillId: "ts", proficiency: 0.9, exerciseCount: 10 });
      busCi.optIn("arch", "ts");
      busCi.propagate("cto", "arch", "ts");
      expect(bus.getHistoryForTopic("flywheel.skill.propagated")).toHaveLength(1);
    });

    it("does not emit flywheel.skill.propagated on failed propagation", () => {
      const bus = new V4MessageBus();
      const busCi = new CapabilityInheritance(bus);
      // No opt-in, so propagation fails
      busCi.registerSkill("cto", { skillId: "ts", proficiency: 0.9, exerciseCount: 10 });
      busCi.propagate("cto", "arch", "ts");
      expect(bus.getHistoryForTopic("flywheel.skill.propagated")).toHaveLength(0);
    });
  });
});
