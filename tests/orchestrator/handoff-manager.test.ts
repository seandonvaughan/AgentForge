import { describe, it, expect } from "vitest";
import { HandoffManager } from "../../src/orchestrator/handoff-manager.js";
import type { Handoff } from "../../src/types/orchestration.js";

describe("handoff-manager", () => {
  describe("createHandoff", () => {
    it("should build a valid Handoff with all fields populated", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "Architecture design for auth module",
          location: "docs/auth-design.md",
          confidence: 0.9,
        },
        ["Should we use JWT or session tokens?"],
        ["Must use PostgreSQL", "No ORM — raw SQL only"],
        "complete",
      );

      expect(handoff.from).toBe("architect");
      expect(handoff.to).toBe("coder");
      expect(handoff.artifact.type).toBe("plan");
      expect(handoff.artifact.summary).toBe(
        "Architecture design for auth module",
      );
      expect(handoff.artifact.location).toBe("docs/auth-design.md");
      expect(handoff.artifact.confidence).toBe(0.9);
      expect(handoff.open_questions).toEqual([
        "Should we use JWT or session tokens?",
      ]);
      expect(handoff.constraints).toEqual([
        "Must use PostgreSQL",
        "No ORM — raw SQL only",
      ]);
      expect(handoff.status).toBe("complete");
    });

    it("should accept empty open_questions and constraints", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "coder",
        "test-engineer",
        {
          type: "code",
          summary: "Login endpoint implementation",
          location: "src/routes/login.ts",
          confidence: 0.85,
        },
        [],
        [],
        "partial",
      );

      expect(handoff.open_questions).toEqual([]);
      expect(handoff.constraints).toEqual([]);
      expect(handoff.status).toBe("partial");
    });

    it("should support all artifact types", () => {
      const manager = new HandoffManager();
      const types = [
        "code",
        "document",
        "analysis",
        "plan",
        "review",
        "data",
      ] as const;

      for (const artifactType of types) {
        const handoff = manager.createHandoff(
          "agent-a",
          "agent-b",
          {
            type: artifactType,
            summary: `A ${artifactType} artifact`,
            location: `/artifacts/${artifactType}`,
            confidence: 0.7,
          },
          [],
          [],
          "complete",
        );
        expect(handoff.artifact.type).toBe(artifactType);
      }
    });

    it("should support all status values", () => {
      const manager = new HandoffManager();
      const statuses = ["complete", "partial", "needs_review"] as const;

      for (const status of statuses) {
        const handoff = manager.createHandoff(
          "agent-a",
          "agent-b",
          {
            type: "code",
            summary: "Some work",
            location: "src/file.ts",
            confidence: 0.5,
          },
          [],
          [],
          status,
        );
        expect(handoff.status).toBe(status);
      }
    });
  });

  describe("buildHandoffContext", () => {
    it("should produce a context string with artifact summary, open questions, and constraints", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "Database schema for user management",
          location: "docs/db-schema.sql",
          confidence: 0.95,
        },
        ["Should soft-delete be used?", "Index strategy for user lookups?"],
        ["Use UUID primary keys", "All tables need created_at/updated_at"],
        "complete",
      );

      const context = manager.buildHandoffContext(handoff, "coder");

      // Must include artifact summary
      expect(context).toContain("Database schema for user management");
      // Must include artifact location
      expect(context).toContain("docs/db-schema.sql");
      // Must include artifact type
      expect(context).toContain("plan");
      // Must include confidence
      expect(context).toContain("0.95");
      // Must include open questions
      expect(context).toContain("Should soft-delete be used?");
      expect(context).toContain("Index strategy for user lookups?");
      // Must include constraints
      expect(context).toContain("Use UUID primary keys");
      expect(context).toContain(
        "All tables need created_at/updated_at",
      );
      // Must include target agent name
      expect(context).toContain("coder");
      // Must include source agent name
      expect(context).toContain("architect");
      // Must include status
      expect(context).toContain("complete");
    });

    it("should handle handoff with no open questions", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "coder",
        "test-engineer",
        {
          type: "code",
          summary: "REST API implementation",
          location: "src/api/routes.ts",
          confidence: 0.8,
        },
        [],
        ["Must maintain backwards compatibility"],
        "complete",
      );

      const context = manager.buildHandoffContext(handoff, "test-engineer");

      expect(context).toContain("REST API implementation");
      expect(context).toContain("Must maintain backwards compatibility");
      expect(context).toContain("test-engineer");
    });

    it("should handle handoff with no constraints", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "analyst",
        "architect",
        {
          type: "analysis",
          summary: "Requirements analysis",
          location: "docs/requirements.md",
          confidence: 0.75,
        },
        ["What is the expected load?"],
        [],
        "needs_review",
      );

      const context = manager.buildHandoffContext(handoff, "architect");

      expect(context).toContain("Requirements analysis");
      expect(context).toContain("What is the expected load?");
      expect(context).toContain("needs_review");
    });
  });

  describe("validateHandoff", () => {
    it("should return valid for a well-formed handoff", () => {
      const manager = new HandoffManager();
      const handoff = manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "System design",
          location: "docs/design.md",
          confidence: 0.9,
        },
        [],
        [],
        "complete",
      );

      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("should reject handoff with empty 'from' field", () => {
      const handoff: Handoff = {
        from: "",
        to: "coder",
        artifact: {
          type: "code",
          summary: "Some work",
          location: "src/file.ts",
          confidence: 0.5,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("from"))).toBe(true);
    });

    it("should reject handoff with empty 'to' field", () => {
      const handoff: Handoff = {
        from: "architect",
        to: "",
        artifact: {
          type: "code",
          summary: "Some work",
          location: "src/file.ts",
          confidence: 0.5,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("to"))).toBe(true);
    });

    it("should reject handoff with empty artifact summary", () => {
      const handoff: Handoff = {
        from: "architect",
        to: "coder",
        artifact: {
          type: "code",
          summary: "",
          location: "src/file.ts",
          confidence: 0.5,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
    });

    it("should reject handoff with empty artifact location", () => {
      const handoff: Handoff = {
        from: "architect",
        to: "coder",
        artifact: {
          type: "code",
          summary: "Some work",
          location: "",
          confidence: 0.5,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("location"))).toBe(true);
    });

    it("should reject handoff with confidence below 0", () => {
      const handoff: Handoff = {
        from: "architect",
        to: "coder",
        artifact: {
          type: "code",
          summary: "Some work",
          location: "src/file.ts",
          confidence: -0.1,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("should reject handoff with confidence above 1", () => {
      const handoff: Handoff = {
        from: "architect",
        to: "coder",
        artifact: {
          type: "code",
          summary: "Some work",
          location: "src/file.ts",
          confidence: 1.5,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("should collect multiple errors at once", () => {
      const handoff: Handoff = {
        from: "",
        to: "",
        artifact: {
          type: "code",
          summary: "",
          location: "",
          confidence: 2,
        },
        open_questions: [],
        constraints: [],
        status: "complete",
      };

      const manager = new HandoffManager();
      const result = manager.validateHandoff(handoff);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("getHandoffHistory", () => {
    it("should return handoffs where the agent is the sender", () => {
      const manager = new HandoffManager();
      manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "Design doc",
          location: "docs/design.md",
          confidence: 0.9,
        },
        [],
        [],
        "complete",
      );

      const history = manager.getHandoffHistory("architect");
      expect(history).toHaveLength(1);
      expect(history[0].from).toBe("architect");
      expect(history[0].to).toBe("coder");
    });

    it("should return handoffs where the agent is the receiver", () => {
      const manager = new HandoffManager();
      manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "Design doc",
          location: "docs/design.md",
          confidence: 0.9,
        },
        [],
        [],
        "complete",
      );

      const history = manager.getHandoffHistory("coder");
      expect(history).toHaveLength(1);
      expect(history[0].from).toBe("architect");
      expect(history[0].to).toBe("coder");
    });

    it("should return empty array for agent with no handoffs", () => {
      const manager = new HandoffManager();
      const history = manager.getHandoffHistory("unknown-agent");
      expect(history).toEqual([]);
    });

    it("should track multiple handoffs across different agents", () => {
      const manager = new HandoffManager();

      manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "Design doc",
          location: "docs/design.md",
          confidence: 0.9,
        },
        [],
        [],
        "complete",
      );

      manager.createHandoff(
        "coder",
        "test-engineer",
        {
          type: "code",
          summary: "Implementation",
          location: "src/feature.ts",
          confidence: 0.85,
        },
        ["Edge cases covered?"],
        [],
        "partial",
      );

      manager.createHandoff(
        "architect",
        "security-auditor",
        {
          type: "document",
          summary: "Security requirements",
          location: "docs/security.md",
          confidence: 0.7,
        },
        [],
        ["OWASP Top 10 must be addressed"],
        "needs_review",
      );

      // architect sent two handoffs
      const architectHistory = manager.getHandoffHistory("architect");
      expect(architectHistory).toHaveLength(2);

      // coder received one, sent one
      const coderHistory = manager.getHandoffHistory("coder");
      expect(coderHistory).toHaveLength(2);

      // test-engineer received one
      const testHistory = manager.getHandoffHistory("test-engineer");
      expect(testHistory).toHaveLength(1);

      // security-auditor received one
      const secHistory = manager.getHandoffHistory("security-auditor");
      expect(secHistory).toHaveLength(1);

      // unrelated agent has none
      const noneHistory = manager.getHandoffHistory("unrelated-agent");
      expect(noneHistory).toEqual([]);
    });

    it("should return handoffs in creation order", () => {
      const manager = new HandoffManager();

      manager.createHandoff(
        "architect",
        "coder",
        {
          type: "plan",
          summary: "First handoff",
          location: "docs/first.md",
          confidence: 0.9,
        },
        [],
        [],
        "complete",
      );

      manager.createHandoff(
        "architect",
        "coder",
        {
          type: "review",
          summary: "Second handoff",
          location: "docs/second.md",
          confidence: 0.8,
        },
        [],
        [],
        "partial",
      );

      const history = manager.getHandoffHistory("architect");
      expect(history).toHaveLength(2);
      expect(history[0].artifact.summary).toBe("First handoff");
      expect(history[1].artifact.summary).toBe("Second handoff");
    });
  });
});
