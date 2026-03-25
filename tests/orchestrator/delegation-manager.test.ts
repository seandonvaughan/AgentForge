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

  describe("delegateWork", () => {
    it("should create a delegation request with ownership_transfer: true", () => {
      const req = manager.delegateWork(
        "architect",
        "coder",
        "implement the login page",
        "user needs OAuth support",
        "full",
      );

      expect(req.id).toBeTruthy();
      expect(typeof req.id).toBe("string");
      expect(req.from).toBe("architect");
      expect(req.to).toBe("coder");
      expect(req.task).toBe("implement the login page");
      expect(req.ownership_transfer).toBe(true);
      expect(req.context.parent_task).toBe("user needs OAuth support");
      expect(req.priority).toBe("normal");
    });

    it("should use response_format 'full' by default", () => {
      const req = manager.delegateWork(
        "architect",
        "coder",
        "implement feature",
      );

      expect(req.ownership_transfer).toBe(true);
    });

    it("should generate unique IDs for separate calls", () => {
      const req1 = manager.delegateWork("architect", "coder", "task 1");
      const req2 = manager.delegateWork("architect", "coder", "task 2");

      expect(req1.id).not.toBe(req2.id);
    });

    it("should validate against delegation graph and reject invalid paths", () => {
      const req = manager.delegateWork(
        "coder",
        "architect",
        "reverse delegation",
        "some context",
        "summary",
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not permitted to delegate");
    });

    it("should validate against delegation graph and accept valid paths", () => {
      const req = manager.delegateWork(
        "architect",
        "coder",
        "implement feature",
        "context here",
        "structured",
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(true);
    });
  });

  describe("askCoworker", () => {
    it("should create a delegation request with ownership_transfer: false", () => {
      const req = manager.askCoworker(
        "architect",
        "security-auditor",
        "Is the auth module safe?",
        "reviewing login flow",
      );

      expect(req.id).toBeTruthy();
      expect(typeof req.id).toBe("string");
      expect(req.from).toBe("architect");
      expect(req.to).toBe("security-auditor");
      expect(req.task).toBe("Is the auth module safe?");
      expect(req.ownership_transfer).toBe(false);
      expect(req.context.parent_task).toBe("reviewing login flow");
      expect(req.priority).toBe("normal");
    });

    it("should generate unique IDs for separate calls", () => {
      const req1 = manager.askCoworker(
        "architect",
        "coder",
        "question 1",
      );
      const req2 = manager.askCoworker(
        "architect",
        "coder",
        "question 2",
      );

      expect(req1.id).not.toBe(req2.id);
    });

    it("should validate against delegation graph and reject invalid paths", () => {
      const req = manager.askCoworker(
        "file-reader",
        "architect",
        "who are you?",
        "just curious",
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(false);
    });

    it("should validate against delegation graph and accept valid paths", () => {
      const req = manager.askCoworker(
        "test-engineer",
        "test-runner",
        "what tests are failing?",
        "need status update",
      );
      const result = manager.validateDelegation(req);

      expect(result.valid).toBe(true);
    });

    it("should default context to empty when not provided", () => {
      const req = manager.askCoworker(
        "architect",
        "coder",
        "what is the status?",
      );

      expect(req.context.parent_task).toBeNull();
      expect(req.context.files_in_scope).toEqual([]);
      expect(req.context.deadline).toBeNull();
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
