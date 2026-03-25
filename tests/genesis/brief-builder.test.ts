import { describe, it, expect } from "vitest";
import { buildBrief } from "../../src/genesis/brief-builder.js";
import type { FullScanResult } from "../../src/scanner/index.js";
import type {
  ResearchFindings,
  IntegrationRef,
} from "../../src/types/analysis.js";

// ---------------------------------------------------------------------------
// Helpers — build mock data
// ---------------------------------------------------------------------------

function makeScanResult(
  overrides: Partial<FullScanResult> = {},
): FullScanResult {
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("brief-builder", () => {
  describe("buildBrief from scan only", () => {
    it("should populate context.codebase from scan result", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 200,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
            {
              file_path: "src/utils.ts",
              language: "typescript",
              loc: 150,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 2 },
          frameworks_detected: ["express"],
          total_files: 2,
          total_loc: 350,
          directory_structure: ["src"],
        },
        dependencies: {
          package_manager: "npm",
          dependencies: [],
          total_production: 5,
          total_development: 3,
          framework_dependencies: ["express"],
          test_frameworks: ["vitest"],
          build_tools: ["tsc"],
          linters: ["eslint"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.context.codebase).toBeDefined();
      expect(brief.context.codebase!.primary_language).toBe("typescript");
      expect(brief.context.codebase!.languages).toContain("typescript");
      expect(brief.context.codebase!.frameworks).toContain("express");
      expect(brief.context.codebase!.size.files).toBe(2);
      expect(brief.context.codebase!.size.loc).toBe(350);
    });

    it("should infer project type as 'software' for a codebase project", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/app.ts",
              language: "typescript",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.project.type).toBe("software");
    });

    it("should infer stage 'early' for a small young project", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "index.ts",
              language: "typescript",
              loc: 50,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 50,
          directory_structure: [],
        },
        git: {
          total_commits: 5,
          contributors: [],
          active_files: [],
          branch_count: 1,
          branch_strategy: "unknown",
          churn_rate: [],
          commit_frequency: [],
          age_days: 10,
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.project.stage).toBe("early");
    });

    it("should infer stage 'mature' for a large well-established project", () => {
      const scan = makeScanResult({
        files: {
          files: Array.from({ length: 100 }, (_, i) => ({
            file_path: `src/file-${i}.ts`,
            language: "typescript",
            loc: 200,
            imports: [],
            exports: [],
            framework_indicators: [],
            patterns: [],
          })),
          languages: { typescript: 100 },
          frameworks_detected: ["react", "express"],
          total_files: 100,
          total_loc: 20000,
          directory_structure: ["src", "tests", "docs"],
        },
        git: {
          total_commits: 500,
          contributors: [
            { name: "alice", email: "a@x.com", commit_count: 300 },
            { name: "bob", email: "b@x.com", commit_count: 200 },
          ],
          active_files: [],
          branch_count: 10,
          branch_strategy: "git-flow",
          churn_rate: [],
          commit_frequency: [],
          age_days: 365,
        },
        ci: {
          ci_provider: "github-actions",
          config_files: [".github/workflows/ci.yml"],
          pipelines: [],
          test_commands: ["npm test"],
          build_commands: ["npm run build"],
          deploy_targets: ["aws"],
          has_linting: true,
          has_type_checking: true,
          has_security_scanning: true,
          has_docker: true,
          dockerfile_count: 1,
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.project.stage).toBe("mature");
    });

    it("should set a default project name from scan context", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/main.py",
              language: "python",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { python: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.project.name).toBeTruthy();
    });
  });

  describe("buildBrief from scan + interview answers", () => {
    it("should merge interview answers into goals", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const answers: Record<string, string> = {
        project_name: "MyApp",
        primary_goal: "Build a REST API for user management",
        secondary_goals: "Add authentication, Add rate limiting",
      };

      const brief = buildBrief({ scan, answers });

      expect(brief.project.name).toBe("MyApp");
      expect(brief.goals.primary).toBe(
        "Build a REST API for user management",
      );
      expect(brief.goals.secondary).toContain("Add authentication");
      expect(brief.goals.secondary).toContain("Add rate limiting");
    });

    it("should merge interview answers into constraints", () => {
      const scan = makeScanResult();

      const answers: Record<string, string> = {
        budget: "low",
        timeline: "2 weeks",
        team_size: "3",
      };

      const brief = buildBrief({ scan, answers });

      expect(brief.constraints.budget).toBe("low");
      expect(brief.constraints.timeline).toBe("2 weeks");
      expect(brief.constraints.team_size).toBe("3");
    });

    it("should let interview project_name override inferred name", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const answers: Record<string, string> = {
        project_name: "SuperApp",
      };

      const brief = buildBrief({ scan, answers });

      expect(brief.project.name).toBe("SuperApp");
    });
  });

  describe("buildBrief from interview only (no scan)", () => {
    it("should build brief with no codebase context", () => {
      const answers: Record<string, string> = {
        project_name: "New Startup",
        primary_goal: "Create a pitch deck for investors",
      };

      const brief = buildBrief({ answers });

      expect(brief.context.codebase).toBeUndefined();
      expect(brief.project.name).toBe("New Startup");
      expect(brief.goals.primary).toBe(
        "Create a pitch deck for investors",
      );
    });

    it("should default to stage 'early' when no scan is available", () => {
      const answers: Record<string, string> = {
        project_name: "Greenfield",
      };

      const brief = buildBrief({ answers });

      expect(brief.project.stage).toBe("early");
    });

    it("should infer project type 'business' when no code is present", () => {
      const answers: Record<string, string> = {
        project_name: "Business Plan",
        primary_goal: "Write a business plan",
      };

      const brief = buildBrief({ answers });

      expect(brief.project.type).toBe("business");
    });
  });

  describe("domain population", () => {
    it("should always include 'core' in domains", () => {
      const brief = buildBrief({});

      expect(brief.domains).toContain("core");
    });

    it("should include 'software' domain when scan has source files", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.domains).toContain("core");
      expect(brief.domains).toContain("software");
    });

    it("should include 'business' domain when documents directory found", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "docs/plan.md",
              language: "markdown",
              loc: 50,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { markdown: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 50,
          directory_structure: ["docs"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.domains).toContain("business");
    });

    it("should include both software and business domains for hybrid projects", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/app.ts",
              language: "typescript",
              loc: 200,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
            {
              file_path: "docs/prd.md",
              language: "markdown",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1, markdown: 1 },
          frameworks_detected: [],
          total_files: 2,
          total_loc: 300,
          directory_structure: ["src", "docs"],
        },
      });

      const brief = buildBrief({ scan });

      expect(brief.domains).toContain("core");
      expect(brief.domains).toContain("software");
      expect(brief.domains).toContain("business");
    });
  });

  describe("research and integrations", () => {
    it("should attach research findings to context", () => {
      const research: ResearchFindings = {
        market_size: "$10B",
        competitors: ["CompA", "CompB"],
        industry_trends: ["AI", "automation"],
      };

      const brief = buildBrief({ research });

      expect(brief.context.research).toBeDefined();
      expect(brief.context.research!.market_size).toBe("$10B");
      expect(brief.context.research!.competitors).toEqual([
        "CompA",
        "CompB",
      ]);
    });

    it("should attach integrations to context", () => {
      const integrations: IntegrationRef[] = [
        { type: "jira", ref: "PROJ-123" },
        { type: "github", ref: "org/repo" },
      ];

      const brief = buildBrief({ integrations });

      expect(brief.context.integrations).toBeDefined();
      expect(brief.context.integrations).toHaveLength(2);
      expect(brief.context.integrations![0].type).toBe("jira");
    });
  });

  describe("graceful handling of missing/empty inputs", () => {
    it("should return a valid brief with no inputs at all", () => {
      const brief = buildBrief({});

      expect(brief.project.name).toBeTruthy();
      expect(brief.project.type).toBeTruthy();
      expect(brief.project.stage).toBeDefined();
      expect(brief.goals.primary).toBeDefined();
      expect(brief.goals.secondary).toEqual([]);
      expect(brief.domains).toContain("core");
      expect(brief.constraints).toEqual({});
      expect(brief.context).toBeDefined();
    });

    it("should handle empty answers gracefully", () => {
      const brief = buildBrief({ answers: {} });

      expect(brief.project.name).toBeTruthy();
      expect(brief.goals.primary).toBeDefined();
    });

    it("should handle scan with empty file list gracefully", () => {
      const scan = makeScanResult();

      const brief = buildBrief({ scan });

      // With an empty scan, codebase should still be populated but empty
      expect(brief.project.name).toBeTruthy();
      expect(brief.project.stage).toBeDefined();
    });

    it("should return sorted domains with no duplicates", () => {
      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["src"],
        },
      });

      const brief = buildBrief({ scan });

      const sorted = [...brief.domains].sort();
      expect(brief.domains).toEqual(sorted);
      // No duplicates
      const unique = [...new Set(brief.domains)];
      expect(brief.domains).toEqual(unique);
    });
  });
});
