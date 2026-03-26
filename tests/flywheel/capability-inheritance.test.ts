import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityInheritance, type AgentSkill, type PropagationResult, type SkillCategory } from "../../src/flywheel/capability-inheritance.js";
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

  // --- getSkillsByCategory ---

  describe("getSkillsByCategory", () => {
    it("filters skills by category", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10, category: "technical" });
      ci.registerSkill("cto", { skillId: "planning", proficiency: 0.8, exerciseCount: 5, category: "strategic" });
      ci.registerSkill("cto", { skillId: "code-review", proficiency: 0.7, exerciseCount: 3, category: "quality" });

      const technical = ci.getSkillsByCategory("cto", "technical");
      expect(technical).toHaveLength(1);
      expect(technical[0].skillId).toBe("typescript");

      const strategic = ci.getSkillsByCategory("cto", "strategic");
      expect(strategic).toHaveLength(1);
      expect(strategic[0].skillId).toBe("planning");
    });

    it("returns empty array when no skills match category", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10, category: "technical" });
      expect(ci.getSkillsByCategory("cto", "operational")).toHaveLength(0);
    });

    it("returns empty array for unknown agent", () => {
      expect(ci.getSkillsByCategory("ghost", "technical")).toHaveLength(0);
    });
  });

  // --- listAllSkills ---

  describe("listAllSkills", () => {
    it("aggregates skills across agents", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10, category: "technical" });
      ci.registerSkill("architect", { skillId: "typescript", proficiency: 0.7, exerciseCount: 5, category: "technical" });
      ci.registerSkill("cto", { skillId: "planning", proficiency: 0.8, exerciseCount: 3, category: "strategic" });

      const all = ci.listAllSkills();
      const tsEntry = all.find((s) => s.skillId === "typescript")!;
      expect(tsEntry.agents).toContain("cto");
      expect(tsEntry.agents).toContain("architect");
      expect(tsEntry.category).toBe("technical");

      const planEntry = all.find((s) => s.skillId === "planning")!;
      expect(planEntry.agents).toEqual(["cto"]);
      expect(planEntry.category).toBe("strategic");
    });

    it("returns empty array when no skills registered", () => {
      expect(ci.listAllSkills()).toHaveLength(0);
    });
  });

  // --- category preserved through propagation ---

  describe("category preservation through propagation", () => {
    it("preserves category field when skill is propagated", () => {
      ci.registerSkill("cto", { skillId: "typescript", proficiency: 0.9, exerciseCount: 10, category: "technical", version: "1.0.0" });
      ci.optIn("architect", "typescript");
      ci.propagate("cto", "architect", "typescript");

      const skills = ci.getSkills("architect");
      const ts = skills.find((s) => s.skillId === "typescript")!;
      expect(ts.sourceAgentId).toBe("cto");
      expect(ts.category).toBe("technical");
      expect(ts.version).toBe("1.0.0");
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
