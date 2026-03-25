import { describe, it, expect } from "vitest";
import { composeTeam } from "../../src/builder/team-composer.js";
import type { FullScanResult } from "../../src/scanner/index.js";

/**
 * Creates a minimal FullScanResult for testing, with overrides applied.
 */
function makeScanResult(overrides: Partial<{
  files: Partial<FullScanResult["files"]>;
  dependencies: Partial<FullScanResult["dependencies"]>;
  ci: Partial<FullScanResult["ci"]>;
  git: Partial<FullScanResult["git"]>;
}>): FullScanResult {
  return {
    files: {
      files: [],
      languages: {},
      frameworks_detected: [],
      total_files: 0,
      total_loc: 0,
      directory_structure: [],
      ...overrides.files,
    },
    git: {
      total_commits: 0,
      contributors: [],
      active_files: [],
      branch_count: 0,
      branch_strategy: "unknown",
      churn_rate: [],
      commit_frequency: [],
      age_days: 0,
      ...overrides.git,
    },
    dependencies: {
      package_manager: "unknown",
      dependencies: [],
      total_production: 0,
      total_development: 0,
      framework_dependencies: [],
      test_frameworks: [],
      build_tools: [],
      linters: [],
      ...overrides.dependencies,
    },
    ci: {
      ci_provider: "none",
      config_files: [],
      pipelines: [],
      test_commands: [],
      build_commands: [],
      deploy_targets: [],
      has_linting: false,
      has_type_checking: false,
      has_security_scanning: false,
      has_docker: false,
      dockerfile_count: 0,
      ...overrides.ci,
    },
  };
}

describe("team-composer", () => {
  describe("core agents", () => {
    it("should always include the five core agents", () => {
      const scan = makeScanResult({});
      const result = composeTeam(scan);

      expect(result.agents).toContain("architect");
      expect(result.agents).toContain("coder");
      expect(result.agents).toContain("researcher");
      expect(result.agents).toContain("file-reader");
      expect(result.agents).toContain("linter");
    });

    it("should assign correct default models to core agents", () => {
      const scan = makeScanResult({});
      const result = composeTeam(scan);

      expect(result.model_assignments["architect"]).toBe("opus");
      expect(result.model_assignments["coder"]).toBe("sonnet");
      expect(result.model_assignments["researcher"]).toBe("sonnet");
      expect(result.model_assignments["file-reader"]).toBe("haiku");
      expect(result.model_assignments["linter"]).toBe("haiku");
    });
  });

  describe("conditional security-auditor", () => {
    it("should include security-auditor when auth dependencies exist", () => {
      const scan = makeScanResult({
        dependencies: {
          dependencies: [
            { name: "passport", version: "^0.6.0", type: "production", category: "auth" },
          ],
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("security-auditor");
    });

    it("should include security-auditor when database deps exist", () => {
      const scan = makeScanResult({
        dependencies: {
          dependencies: [
            { name: "prisma", version: "^5.0.0", type: "production", category: "database" },
          ],
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("security-auditor");
    });

    it("should include security-auditor for large projects (>20 files)", () => {
      const scan = makeScanResult({
        files: { total_files: 25 },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("security-auditor");
    });

    it("should include security-auditor when auth patterns in file paths", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/auth/jwt-handler.ts",
              language: "TypeScript",
              loc: 50,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("security-auditor");
    });
  });

  describe("conditional test-engineer", () => {
    it("should include test-engineer when test frameworks detected", () => {
      const scan = makeScanResult({
        dependencies: {
          test_frameworks: ["vitest"],
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("test-engineer");
      expect(result.agents).toContain("test-runner");
    });

    it("should include test-engineer when test files exist", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/__tests__/app.test.ts",
              language: "TypeScript",
              loc: 30,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("test-engineer");
    });

    it("should not include test-engineer when no tests detected", () => {
      const scan = makeScanResult({});

      const result = composeTeam(scan);

      expect(result.agents).not.toContain("test-engineer");
      expect(result.agents).not.toContain("test-runner");
    });
  });

  describe("conditional devops-engineer", () => {
    it("should include devops-engineer when CI is configured", () => {
      const scan = makeScanResult({
        ci: { ci_provider: "github-actions" },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("devops-engineer");
    });

    it("should include devops-engineer when Docker is detected", () => {
      const scan = makeScanResult({
        ci: { has_docker: true },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("devops-engineer");
    });

    it("should not include devops-engineer when no CI or Docker", () => {
      const scan = makeScanResult({});

      const result = composeTeam(scan);

      expect(result.agents).not.toContain("devops-engineer");
    });
  });

  describe("conditional documentation-writer", () => {
    it("should include documentation-writer for large projects (>50 files)", () => {
      const scan = makeScanResult({
        files: { total_files: 60 },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("documentation-writer");
    });

    it("should include documentation-writer for multi-language projects", () => {
      const scan = makeScanResult({
        files: {
          languages: { TypeScript: 10, Python: 5 },
        },
      });

      const result = composeTeam(scan);

      expect(result.agents).toContain("documentation-writer");
    });
  });

  describe("custom agent generation", () => {
    it("should add api-specialist for API-heavy projects", () => {
      const apiFiles = Array.from({ length: 6 }, (_, i) => ({
        file_path: `src/controllers/controller-${i}.ts`,
        language: "TypeScript" as const,
        loc: 100,
        imports: [],
        exports: [],
        framework_indicators: [],
        patterns: [],
      }));

      const scan = makeScanResult({
        files: { files: apiFiles },
      });

      const result = composeTeam(scan);

      const apiSpec = result.custom_agents.find(
        (a) => a.name === "api-specialist"
      );
      expect(apiSpec).toBeDefined();
      expect(apiSpec!.base_template).toBe("coder");
    });

    it("should add db-specialist for database-heavy projects", () => {
      const scan = makeScanResult({
        dependencies: {
          dependencies: [
            { name: "prisma", version: "^5.0.0", type: "production", category: "database" },
            { name: "redis", version: "^4.0.0", type: "production", category: "database" },
          ],
        },
      });

      const result = composeTeam(scan);

      const dbSpec = result.custom_agents.find(
        (a) => a.name === "db-specialist"
      );
      expect(dbSpec).toBeDefined();
    });

    it("should add ml-engineer for ML projects", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/model.py",
              language: "Python",
              loc: 200,
              imports: ["torch", "transformers"],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
        },
      });

      const result = composeTeam(scan);

      const mlEng = result.custom_agents.find(
        (a) => a.name === "ml-engineer"
      );
      expect(mlEng).toBeDefined();
    });

    it("should assign sonnet model to custom agents", () => {
      const apiFiles = Array.from({ length: 6 }, (_, i) => ({
        file_path: `src/routes/route-${i}.ts`,
        language: "TypeScript" as const,
        loc: 50,
        imports: [],
        exports: [],
        framework_indicators: [],
        patterns: [],
      }));

      const scan = makeScanResult({
        files: { files: apiFiles },
      });

      const result = composeTeam(scan);

      expect(result.model_assignments["api-specialist"]).toBe("sonnet");
    });
  });
});
