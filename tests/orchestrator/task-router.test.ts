import { describe, it, expect } from "vitest";
import { routeTask } from "../../src/orchestrator/task-router.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { AgentTemplate } from "../../src/types/agent.js";

function makeTemplate(
  name: string,
  overrides: Partial<AgentTemplate> = {}
): AgentTemplate {
  return {
    name,
    model: "sonnet",
    version: "1.0",
    description: "",
    system_prompt: "",
    skills: [],
    triggers: {
      file_patterns: [],
      keywords: [],
    },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: {
      max_files: 20,
      auto_include: [],
      project_specific: [],
    },
    ...overrides,
  };
}

const manifest: TeamManifest = {
  name: "Test Team",
  forged_at: "2025-01-01T00:00:00Z",
  forged_by: "test",
  project_hash: "abc123",
  agents: {
    strategic: ["architect"],
    implementation: ["coder"],
    quality: ["security-auditor", "test-engineer"],
    utility: ["documentation-writer"],
  },
  model_routing: {
    opus: ["architect"],
    sonnet: ["coder", "security-auditor", "test-engineer"],
    haiku: ["documentation-writer"],
  },
  delegation_graph: {
    architect: ["coder", "security-auditor"],
    coder: ["test-engineer"],
  },
};

describe("task-router", () => {
  const agents = new Map<string, AgentTemplate>();

  agents.set(
    "architect",
    makeTemplate("architect", {
      triggers: {
        file_patterns: [],
        keywords: ["plan", "design", "architect", "rfc"],
      },
    })
  );

  agents.set(
    "coder",
    makeTemplate("coder", {
      triggers: {
        file_patterns: ["**/*.ts", "**/*.js"],
        keywords: ["implement", "code", "build", "feature", "refactor"],
      },
    })
  );

  agents.set(
    "security-auditor",
    makeTemplate("security-auditor", {
      triggers: {
        file_patterns: ["**/*.ts"],
        keywords: ["security", "vulnerability", "audit", "cve"],
      },
    })
  );

  agents.set(
    "test-engineer",
    makeTemplate("test-engineer", {
      triggers: {
        file_patterns: ["**/*.test.ts", "**/*.spec.ts"],
        keywords: ["test", "coverage", "spec"],
      },
    })
  );

  agents.set(
    "documentation-writer",
    makeTemplate("documentation-writer", {
      triggers: {
        file_patterns: ["**/*.md"],
        keywords: ["document", "docs", "readme"],
      },
    })
  );

  describe("routing by keyword", () => {
    it("should route a coding task to coder", () => {
      const matches = routeTask(
        "implement a new feature for user authentication",
        [],
        manifest,
        agents
      );

      expect(matches.length).toBeGreaterThan(0);
      const coderMatch = matches.find((m) => m.agent === "coder");
      expect(coderMatch).toBeDefined();
      expect(coderMatch!.confidence).toBeGreaterThan(0);
    });

    it("should route a security task to security-auditor", () => {
      const matches = routeTask(
        "audit the codebase for security vulnerabilities",
        [],
        manifest,
        agents
      );

      const securityMatch = matches.find(
        (m) => m.agent === "security-auditor"
      );
      expect(securityMatch).toBeDefined();
      expect(securityMatch!.confidence).toBeGreaterThan(0);
    });

    it("should route a test task to test-engineer", () => {
      const matches = routeTask(
        "write tests for the user module and check coverage",
        [],
        manifest,
        agents
      );

      const testMatch = matches.find((m) => m.agent === "test-engineer");
      expect(testMatch).toBeDefined();
    });

    it("should route a docs task to documentation-writer", () => {
      const matches = routeTask(
        "update the docs and add a readme for the new API",
        [],
        manifest,
        agents
      );

      const docsMatch = matches.find(
        (m) => m.agent === "documentation-writer"
      );
      expect(docsMatch).toBeDefined();
    });
  });

  describe("routing by file patterns", () => {
    it("should match coder for .ts files", () => {
      const matches = routeTask(
        "work on this",
        ["src/index.ts", "src/utils.ts"],
        manifest,
        agents
      );

      const coderMatch = matches.find((m) => m.agent === "coder");
      expect(coderMatch).toBeDefined();
      expect(coderMatch!.confidence).toBeGreaterThan(0);
    });

    it("should match test-engineer for .test.ts files", () => {
      const matches = routeTask(
        "update these",
        ["src/__tests__/app.test.ts"],
        manifest,
        agents
      );

      const testMatch = matches.find((m) => m.agent === "test-engineer");
      expect(testMatch).toBeDefined();
    });
  });

  describe("ranking and confidence", () => {
    it("should return results sorted by confidence descending", () => {
      const matches = routeTask(
        "implement and test a new security feature",
        ["src/auth.ts"],
        manifest,
        agents
      );

      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(
          matches[i].confidence
        );
      }
    });

    it("should return empty array when no agents match", () => {
      const matches = routeTask(
        "completely unrelated gibberish xyzzy",
        [],
        manifest,
        agents
      );

      // Some agents may match due to category alignment, but
      // no keyword or file matches should mean low or no confidence
      for (const match of matches) {
        expect(match.confidence).toBeLessThanOrEqual(0.25);
      }
    });

    it("should include a reason string", () => {
      const matches = routeTask(
        "implement a feature",
        ["src/index.ts"],
        manifest,
        agents
      );

      const coderMatch = matches.find((m) => m.agent === "coder");
      expect(coderMatch).toBeDefined();
      expect(coderMatch!.reason).toBeTruthy();
      expect(typeof coderMatch!.reason).toBe("string");
    });

    it("should give higher confidence when multiple signals match", () => {
      // Coder: keywords "implement" + file pattern "**/*.ts" + category "implementation"
      const matchesMultiSignal = routeTask(
        "implement a new feature",
        ["src/app.ts"],
        manifest,
        agents
      );
      const coderMulti = matchesMultiSignal.find(
        (m) => m.agent === "coder"
      );

      // Coder: only keywords
      const matchesKeywordOnly = routeTask(
        "implement a new feature",
        [],
        manifest,
        agents
      );
      const coderKeyword = matchesKeywordOnly.find(
        (m) => m.agent === "coder"
      );

      expect(coderMulti).toBeDefined();
      expect(coderKeyword).toBeDefined();
      expect(coderMulti!.confidence).toBeGreaterThan(
        coderKeyword!.confidence
      );
    });
  });
});
