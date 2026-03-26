import { describe, it, expect, beforeEach } from "vitest";
import { AutonomyGovernor, type AgentAutonomyRecord } from "../../src/flywheel/autonomy-governor.js";

describe("AutonomyGovernor", () => {
  let gov: AutonomyGovernor;
  beforeEach(() => { gov = new AutonomyGovernor(); });

  describe("register", () => {
    it("registers an agent at a starting tier", () => {
      gov.register("cto", 2);
      expect(gov.getTier("cto")).toBe(2);
    });
  });

  describe("evaluate promotion", () => {
    it("promotes agent when criteria met", () => {
      gov.register("arch", 1);
      gov.recordSuccess("arch");
      gov.recordSuccess("arch");
      gov.recordSuccess("arch");
      gov.recordSuccess("arch");
      gov.recordSuccess("arch"); // 5 consecutive successes
      const result = gov.evaluatePromotion("arch");
      expect(result.promoted).toBe(true);
      expect(result.newTier).toBe(2);
      expect(gov.getTier("arch")).toBe(2);
    });
    it("does not promote without enough successes", () => {
      gov.register("arch", 1);
      gov.recordSuccess("arch");
      gov.recordSuccess("arch");
      const result = gov.evaluatePromotion("arch");
      expect(result.promoted).toBe(false);
    });
    it("does not promote beyond tier 4", () => {
      gov.register("ceo", 4);
      for (let i = 0; i < 10; i++) gov.recordSuccess("ceo");
      const result = gov.evaluatePromotion("ceo");
      expect(result.promoted).toBe(false);
      expect(gov.getTier("ceo")).toBe(4);
    });
  });

  describe("evaluate demotion", () => {
    it("demotes agent after consecutive failures", () => {
      gov.register("agent", 3);
      gov.recordFailure("agent");
      gov.recordFailure("agent");
      gov.recordFailure("agent"); // 3 consecutive failures
      const result = gov.evaluateDemotion("agent");
      expect(result.demoted).toBe(true);
      expect(result.newTier).toBe(2);
    });
    it("does not demote below tier 1", () => {
      gov.register("agent", 1);
      for (let i = 0; i < 5; i++) gov.recordFailure("agent");
      const result = gov.evaluateDemotion("agent");
      expect(result.demoted).toBe(false);
    });
    it("success resets failure streak", () => {
      gov.register("agent", 3);
      gov.recordFailure("agent");
      gov.recordFailure("agent");
      gov.recordSuccess("agent"); // resets streak
      gov.recordFailure("agent");
      const result = gov.evaluateDemotion("agent");
      expect(result.demoted).toBe(false);
    });
  });

  describe("getRecord", () => {
    it("returns agent's full autonomy record", () => {
      gov.register("cto", 2);
      gov.recordSuccess("cto");
      gov.recordFailure("cto");
      const record = gov.getRecord("cto")!;
      expect(record.totalSuccesses).toBe(1);
      expect(record.totalFailures).toBe(1);
      expect(record.tier).toBe(2);
    });
    it("returns null for unregistered agent", () => {
      expect(gov.getRecord("ghost")).toBeNull();
    });
  });

  describe("listByTier", () => {
    it("lists agents at a specific tier", () => {
      gov.register("a", 1);
      gov.register("b", 2);
      gov.register("c", 2);
      expect(gov.listByTier(2)).toHaveLength(2);
    });
  });

  describe("history", () => {
    it("getPromotionHistory returns all promotions", () => {
      gov.register("x", 1);
      for (let i = 0; i < 5; i++) gov.recordSuccess("x");
      gov.evaluatePromotion("x");
      expect(gov.getPromotionHistory()).toHaveLength(1);
      expect(gov.getPromotionHistory()[0].agentId).toBe("x");
    });
  });
});
