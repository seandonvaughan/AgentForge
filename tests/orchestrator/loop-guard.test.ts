import { describe, it, expect, beforeEach } from "vitest";
import { LoopGuard } from "../../src/orchestrator/loop-guard.js";

describe("loop-guard", () => {
  let guard: LoopGuard;

  beforeEach(() => {
    guard = new LoopGuard();
  });

  describe("default limits", () => {
    it("should use correct default limits", () => {
      // review_cycle=3, delegation_depth=5, retry_same_agent=2, total_actions=50
      // Verify by incrementing up to (but not past) each limit
      for (let i = 0; i < 3; i++) {
        expect(guard.increment("review_cycle")).toEqual({ allowed: true });
      }
      expect(guard.increment("review_cycle").allowed).toBe(false);

      const guard2 = new LoopGuard();
      for (let i = 0; i < 5; i++) {
        expect(guard2.increment("delegation_depth")).toEqual({ allowed: true });
      }
      expect(guard2.increment("delegation_depth").allowed).toBe(false);

      const guard3 = new LoopGuard();
      for (let i = 0; i < 2; i++) {
        expect(guard3.increment("retry_same_agent")).toEqual({ allowed: true });
      }
      expect(guard3.increment("retry_same_agent").allowed).toBe(false);

      const guard4 = new LoopGuard();
      for (let i = 0; i < 50; i++) {
        expect(guard4.increment("total_actions")).toEqual({ allowed: true });
      }
      expect(guard4.increment("total_actions").allowed).toBe(false);
    });
  });

  describe("increment", () => {
    it("should return allowed: true when under limit", () => {
      const result = guard.increment("review_cycle");

      expect(result).toEqual({ allowed: true });
    });

    it("should return allowed: true for each call up to the limit", () => {
      // review_cycle default is 3
      expect(guard.increment("review_cycle")).toEqual({ allowed: true });
      expect(guard.increment("review_cycle")).toEqual({ allowed: true });
      expect(guard.increment("review_cycle")).toEqual({ allowed: true });
    });

    it("should return allowed: false with reason after hitting the limit", () => {
      // review_cycle default is 3 — exhaust it
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      guard.increment("review_cycle");

      const result = guard.increment("review_cycle");

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("review_cycle");
      expect(result.reason).toContain("3");
    });

    it("should track delegation_depth independently", () => {
      // delegation_depth default is 5
      for (let i = 0; i < 5; i++) {
        expect(guard.increment("delegation_depth")).toEqual({ allowed: true });
      }

      const result = guard.increment("delegation_depth");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("delegation_depth");
    });

    it("should track total_actions independently", () => {
      // total_actions default is 50
      for (let i = 0; i < 50; i++) {
        expect(guard.increment("total_actions")).toEqual({ allowed: true });
      }

      const result = guard.increment("total_actions");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("total_actions");
    });

    it("should track retry_same_agent independently", () => {
      // retry_same_agent default is 2
      expect(guard.increment("retry_same_agent")).toEqual({ allowed: true });
      expect(guard.increment("retry_same_agent")).toEqual({ allowed: true });

      const result = guard.increment("retry_same_agent");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("retry_same_agent");
    });

    it("should not interfere between different limit types", () => {
      // Exhaust review_cycle
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      expect(guard.increment("review_cycle").allowed).toBe(false);

      // delegation_depth should still be fine
      expect(guard.increment("delegation_depth")).toEqual({ allowed: true });
    });
  });

  describe("custom limits", () => {
    it("should override defaults via constructor", () => {
      const custom = new LoopGuard({ review_cycle: 1 });

      expect(custom.increment("review_cycle")).toEqual({ allowed: true });
      expect(custom.increment("review_cycle").allowed).toBe(false);
    });

    it("should keep non-overridden limits at defaults", () => {
      const custom = new LoopGuard({ review_cycle: 10 });

      // delegation_depth should still default to 5
      for (let i = 0; i < 5; i++) {
        expect(custom.increment("delegation_depth")).toEqual({ allowed: true });
      }
      expect(custom.increment("delegation_depth").allowed).toBe(false);
    });

    it("should allow overriding multiple limits at once", () => {
      const custom = new LoopGuard({
        review_cycle: 1,
        delegation_depth: 2,
        retry_same_agent: 1,
        total_actions: 10,
      });

      expect(custom.increment("review_cycle")).toEqual({ allowed: true });
      expect(custom.increment("review_cycle").allowed).toBe(false);

      expect(custom.increment("delegation_depth")).toEqual({ allowed: true });
      expect(custom.increment("delegation_depth")).toEqual({ allowed: true });
      expect(custom.increment("delegation_depth").allowed).toBe(false);

      expect(custom.increment("retry_same_agent")).toEqual({ allowed: true });
      expect(custom.increment("retry_same_agent").allowed).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset a specific counter", () => {
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      expect(guard.increment("review_cycle").allowed).toBe(false);

      guard.reset("review_cycle");

      // Should be allowed again after reset
      expect(guard.increment("review_cycle")).toEqual({ allowed: true });
    });

    it("should not affect other counters when resetting one", () => {
      guard.increment("review_cycle");
      guard.increment("delegation_depth");
      guard.increment("delegation_depth");

      guard.reset("review_cycle");

      const counters = guard.getCounters();
      expect(counters.review_cycle).toBe(0);
      expect(counters.delegation_depth).toBe(2);
    });

    it("should allow full cycle again after reset", () => {
      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        guard.increment("review_cycle");
      }
      expect(guard.increment("review_cycle").allowed).toBe(false);

      guard.reset("review_cycle");

      // Should be able to go through the full cycle again
      for (let i = 0; i < 3; i++) {
        expect(guard.increment("review_cycle")).toEqual({ allowed: true });
      }
      expect(guard.increment("review_cycle").allowed).toBe(false);
    });
  });

  describe("getCounters", () => {
    it("should return all current counts", () => {
      const counters = guard.getCounters();

      expect(counters).toEqual({
        review_cycle: 0,
        delegation_depth: 0,
        retry_same_agent: 0,
        total_actions: 0,
      });
    });

    it("should reflect increments accurately", () => {
      guard.increment("review_cycle");
      guard.increment("review_cycle");
      guard.increment("delegation_depth");
      guard.increment("total_actions");
      guard.increment("total_actions");
      guard.increment("total_actions");

      const counters = guard.getCounters();

      expect(counters).toEqual({
        review_cycle: 2,
        delegation_depth: 1,
        retry_same_agent: 0,
        total_actions: 3,
      });
    });

    it("should return a copy, not a mutable reference", () => {
      guard.increment("review_cycle");

      const counters = guard.getCounters();
      counters.review_cycle = 999;

      // The internal state should not be changed
      expect(guard.getCounters().review_cycle).toBe(1);
    });
  });
});
