import { describe, it, expect } from "vitest";
import { DelegationManager } from "../../src/orchestrator/delegation-manager.js";
import type { DelegationGraph } from "../../src/types/team.js";

describe("delegation-manager", () => {
  const graph: DelegationGraph = {
    architect: ["coder", "security-auditor", "test-engineer"],
    coder: ["file-reader", "linter"],
    "security-auditor": ["file-reader"],
    "test-engineer": ["file-reader", "test-runner"],
  };

  const manager = new DelegationManager(graph);

  describe("canDelegate", () => {
    it("should return true for valid delegation paths", () => {
      expect(manager.canDelegate("architect", "coder")).toBe(true);
      expect(manager.canDelegate("architect", "security-auditor")).toBe(true);
      expect(manager.canDelegate("coder", "file-reader")).toBe(true);
      expect(manager.canDelegate("test-engineer", "test-runner")).toBe(true);
    });

    it("should return false for invalid delegation paths", () => {
      expect(manager.canDelegate("coder", "architect")).toBe(false);
      expect(manager.canDelegate("file-reader", "coder")).toBe(false);
      expect(manager.canDelegate("linter", "architect")).toBe(false);
    });

    it("should return false for agents not in the graph", () => {
      expect(manager.canDelegate("unknown-agent", "coder")).toBe(false);
      expect(manager.canDelegate("architect", "unknown-agent")).toBe(false);
    });

    it("should return false for self-delegation via canDelegate", () => {
      expect(manager.canDelegate("architect", "architect")).toBe(false);
    });
  });

  describe("createDelegation", () => {
    it("should create a delegation request with a unique ID", () => {
      const req = manager.createDelegation(
        "architect",
        "coder",
        "implement the login page"
      );

      expect(req.id).toBeTruthy();
      expect(typeof req.id).toBe("string");
      expect(req.from).toBe("architect");
      expect(req.to).toBe("coder");
      expect(req.task).toBe("implement the login page");
      expect(req.priority).toBe("normal");
    });

    it("should use the specified priority", () => {
      const req = manager.createDelegation(
        "architect",
        "coder",
        "urgent fix",
        "urgent"
      );

      expect(req.priority).toBe("urgent");
    });

    it("should generate unique IDs for separate calls", () => {
      const req1 = manager.createDelegation("architect", "coder", "task 1");
      const req2 = manager.createDelegation("architect", "coder", "task 2");

      expect(req1.id).not.toBe(req2.id);
    });

    it("should populate default context", () => {
      const req = manager.createDelegation(
        "architect",
        "coder",
        "some task"
      );

      expect(req.context.parent_task).toBeNull();
      expect(req.context.files_in_scope).toEqual([]);
      expect(req.context.deadline).toBeNull();
    });
  });

  describe("validateDelegation", () => {
    it("should validate a correct delegation", () => {
      const req = manager.createDelegation(
        "architect",
        "coder",
        "implement feature"
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should reject self-delegation", () => {
      const req = manager.createDelegation(
        "architect",
        "architect",
        "self task"
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("cannot delegate to itself");
    });

    it("should reject delegation from unknown agent", () => {
      const req = manager.createDelegation(
        "unknown-agent",
        "coder",
        "some task"
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not present in the delegation graph");
    });

    it("should reject delegation on unpermitted path", () => {
      const req = manager.createDelegation(
        "coder",
        "architect",
        "reverse delegation"
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not permitted to delegate");
    });
  });

  describe("getAvailableDelegates", () => {
    it("should return delegates for an agent in the graph", () => {
      const delegates = manager.getAvailableDelegates("architect");

      expect(delegates).toContain("coder");
      expect(delegates).toContain("security-auditor");
      expect(delegates).toContain("test-engineer");
      expect(delegates).toHaveLength(3);
    });

    it("should return empty array for agents not in the graph", () => {
      const delegates = manager.getAvailableDelegates("unknown-agent");

      expect(delegates).toEqual([]);
    });

    it("should return empty array for leaf agents", () => {
      const leafGraph: DelegationGraph = {
        architect: ["coder"],
        coder: [],
      };
      const leafManager = new DelegationManager(leafGraph);

      expect(leafManager.getAvailableDelegates("coder")).toEqual([]);
    });
  });
});
