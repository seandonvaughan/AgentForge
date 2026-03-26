// tests/orchestrator/session-lifecycle.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionLifecycle } from "../../src/orchestrator/session-lifecycle.js";
import type { TeamModeState } from "../../src/types/team-mode.js";

describe("SessionLifecycle", () => {
  let lifecycle: SessionLifecycle;

  beforeEach(() => {
    lifecycle = new SessionLifecycle();
  });

  describe("initial state", () => {
    it("should start as inactive", () => {
      expect(lifecycle.getState()).toBe("inactive");
    });
  });

  describe("valid transitions", () => {
    it("should transition inactive -> activating", () => {
      lifecycle.transition("activating");
      expect(lifecycle.getState()).toBe("activating");
    });

    it("should transition activating -> active", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      expect(lifecycle.getState()).toBe("active");
    });

    it("should transition active -> hibernating", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      expect(lifecycle.getState()).toBe("hibernating");
    });

    it("should transition hibernating -> hibernated", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      expect(lifecycle.getState()).toBe("hibernated");
    });

    it("should transition active -> deactivating", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("deactivating");
      expect(lifecycle.getState()).toBe("deactivating");
    });

    it("should transition deactivating -> inactive", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("deactivating");
      lifecycle.transition("inactive");
      expect(lifecycle.getState()).toBe("inactive");
    });

    it("should transition hibernated -> activating for resume", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      lifecycle.transition("activating");
      expect(lifecycle.getState()).toBe("activating");
    });
  });

  describe("invalid transitions", () => {
    it("should throw on inactive -> active (must go through activating)", () => {
      expect(() => lifecycle.transition("active")).toThrow();
    });

    it("should throw on active -> inactive (must go through deactivating)", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      expect(() => lifecycle.transition("inactive")).toThrow();
    });

    it("should throw on activating -> hibernated", () => {
      lifecycle.transition("activating");
      expect(() => lifecycle.transition("hibernated")).toThrow();
    });
  });

  describe("queries", () => {
    it("should report isActive correctly", () => {
      expect(lifecycle.isActive()).toBe(false);
      lifecycle.transition("activating");
      expect(lifecycle.isActive()).toBe(false);
      lifecycle.transition("active");
      expect(lifecycle.isActive()).toBe(true);
    });

    it("should report isHibernated correctly", () => {
      expect(lifecycle.isHibernated()).toBe(false);
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      expect(lifecycle.isHibernated()).toBe(true);
    });

    it("should report canAcceptTasks only when active", () => {
      expect(lifecycle.canAcceptTasks()).toBe(false);
      lifecycle.transition("activating");
      expect(lifecycle.canAcceptTasks()).toBe(false);
      lifecycle.transition("active");
      expect(lifecycle.canAcceptTasks()).toBe(true);
    });
  });

  describe("listeners", () => {
    it("should notify on transition", () => {
      const transitions: Array<{ from: TeamModeState; to: TeamModeState }> = [];
      lifecycle.onTransition((from, to) => transitions.push({ from, to }));

      lifecycle.transition("activating");
      lifecycle.transition("active");

      expect(transitions).toEqual([
        { from: "inactive", to: "activating" },
        { from: "activating", to: "active" },
      ]);
    });
  });
});