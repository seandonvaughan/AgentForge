import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import type { Skill } from "../../src/types/skill.js";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "test_skill",
    version: "1.0",
    category: "research",
    domain: "core",
    model_preference: "haiku",
    description: "A test skill.",
    parameters: [],
    gates: { pre: [], post: [] },
    composable_with: [],
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe("register", () => {
    it("should register a skill", () => {
      const skill = makeSkill({ name: "web_search" });
      registry.register(skill);

      expect(registry.getSkill("web_search")).toBe(skill);
    });

    it("should throw when registering a duplicate name", () => {
      const skill = makeSkill({ name: "web_search" });
      registry.register(skill);

      expect(() => registry.register(skill)).toThrow("already registered");
    });
  });

  describe("getSkill", () => {
    it("should return the skill by name", () => {
      const skill = makeSkill({ name: "summarize" });
      registry.register(skill);

      expect(registry.getSkill("summarize")).toBe(skill);
    });

    it("should return undefined for unknown skill", () => {
      expect(registry.getSkill("nonexistent")).toBeUndefined();
    });
  });

  describe("getByCategory", () => {
    it("should return all skills in a category", () => {
      registry.register(makeSkill({ name: "web_search", category: "research" }));
      registry.register(makeSkill({ name: "doc_lookup", category: "research" }));
      registry.register(makeSkill({ name: "summarize", category: "analysis" }));

      const researchSkills = registry.getByCategory("research");

      expect(researchSkills).toHaveLength(2);
      const names = researchSkills.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("doc_lookup");
    });

    it("should return empty array for category with no skills", () => {
      registry.register(makeSkill({ name: "web_search", category: "research" }));

      const planningSkills = registry.getByCategory("planning");

      expect(planningSkills).toEqual([]);
    });
  });

  describe("getByDomain", () => {
    it("should return all skills in a domain", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "summarize", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));

      const coreSkills = registry.getByDomain("core");

      expect(coreSkills).toHaveLength(2);
      const names = coreSkills.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("summarize");
    });

    it("should return empty array for domain with no skills", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));

      const marketingSkills = registry.getByDomain("marketing");

      expect(marketingSkills).toEqual([]);
    });
  });

  describe("getAvailableSkills", () => {
    it("should return core skills for any agent", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "summarize", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));

      const available = registry.getAvailableSkills({
        domain: "marketing",
      });

      expect(available).toHaveLength(2);
      const names = available.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("summarize");
    });

    it("should include the agent's own domain skills", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));
      registry.register(makeSkill({ name: "code_review", domain: "software" }));
      registry.register(makeSkill({ name: "market_research", domain: "marketing" }));

      const available = registry.getAvailableSkills({
        domain: "software",
      });

      expect(available).toHaveLength(3);
      const names = available.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("code_write");
      expect(names).toContain("code_review");
    });

    it("should include cross-domain skills when delegation domains are provided", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));
      registry.register(makeSkill({ name: "market_research", domain: "marketing" }));
      registry.register(makeSkill({ name: "financial_analysis", domain: "business" }));

      const available = registry.getAvailableSkills({
        domain: "software",
        delegationDomains: ["marketing"],
      });

      expect(available).toHaveLength(3);
      const names = available.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("code_write");
      expect(names).toContain("market_research");
      expect(names).not.toContain("financial_analysis");
    });

    it("should not duplicate skills when core domain is explicitly given", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));

      const available = registry.getAvailableSkills({
        domain: "core",
      });

      expect(available).toHaveLength(1);
      expect(available[0].name).toBe("web_search");
    });

    it("should return only core skills when agent has no additional domain skills", () => {
      registry.register(makeSkill({ name: "web_search", domain: "core" }));
      registry.register(makeSkill({ name: "code_write", domain: "software" }));

      const available = registry.getAvailableSkills({
        domain: "hr",
      });

      expect(available).toHaveLength(1);
      expect(available[0].name).toBe("web_search");
    });
  });
});
