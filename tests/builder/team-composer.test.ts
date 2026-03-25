import { describe, it, expect } from "vitest";
import { composeTeam, composeTeamFromDomains } from "../../src/builder/team-composer.js";
import type { FullScanResult } from "../../src/scanner/index.js";
import type { DomainPack, DomainId } from "../../src/types/domain.js";

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

// ---------------------------------------------------------------------------
// Domain-aware composition helpers
// ---------------------------------------------------------------------------

/** Create a minimal DomainPack for testing. */
function makeDomainPack(overrides: Partial<DomainPack> & { name: DomainId }): DomainPack {
  return {
    version: "1.0",
    description: `${overrides.name} domain`,
    scanner: { type: "codebase", activates_when: [], scanners: [] },
    agents: { strategic: [], implementation: [], quality: [], utility: [] },
    default_collaboration: "flat",
    signals: [],
    ...overrides,
  };
}

describe("composeTeamFromDomains", () => {
  describe("core domain handling", () => {
    it("should always include core agents even when only core domain is active", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["core", corePack]]);

      const result = composeTeamFromDomains(scan, ["core"], domainPacks);

      expect(result.agents).toContain("architect");
      expect(result.agents).toContain("coder");
      expect(result.agents).toContain("researcher");
      expect(result.agents).toContain("file-reader");
      expect(result.agents).toContain("linter");
    });
  });

  describe("multi-domain merging", () => {
    it("should merge agents from all active domain packs", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: [],
          implementation: [],
          quality: ["security-auditor", "test-engineer"],
          utility: ["devops-engineer"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["software", softwarePack],
      ]);

      const result = composeTeamFromDomains(scan, ["core", "software"], domainPacks);

      // Core agents
      expect(result.agents).toContain("architect");
      expect(result.agents).toContain("coder");
      // Software-specific agents
      expect(result.agents).toContain("security-auditor");
      expect(result.agents).toContain("test-engineer");
      expect(result.agents).toContain("devops-engineer");
    });

    it("should merge agents from three active domains", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: [],
          implementation: [],
          quality: ["test-engineer"],
          utility: [],
        },
      });
      const marketingPack = makeDomainPack({
        name: "marketing",
        agents: {
          strategic: ["cmo"],
          implementation: ["content-writer"],
          quality: [],
          utility: ["seo-analyst"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["software", softwarePack],
        ["marketing", marketingPack],
      ]);

      const result = composeTeamFromDomains(
        scan,
        ["core", "software", "marketing"],
        domainPacks,
      );

      expect(result.agents).toContain("architect");
      expect(result.agents).toContain("coder");
      expect(result.agents).toContain("test-engineer");
      expect(result.agents).toContain("cmo");
      expect(result.agents).toContain("content-writer");
      expect(result.agents).toContain("seo-analyst");
    });
  });

  describe("deduplication", () => {
    it("should deduplicate agents shared across domains", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],       // duplicate with core
          implementation: ["coder"],      // duplicate with core
          quality: ["test-engineer"],
          utility: ["researcher"],        // duplicate with core
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["software", softwarePack],
      ]);

      const result = composeTeamFromDomains(scan, ["core", "software"], domainPacks);

      // Count occurrences — each should appear exactly once
      const architectCount = result.agents.filter((a) => a === "architect").length;
      const coderCount = result.agents.filter((a) => a === "coder").length;
      const researcherCount = result.agents.filter((a) => a === "researcher").length;

      expect(architectCount).toBe(1);
      expect(coderCount).toBe(1);
      expect(researcherCount).toBe(1);
      // Non-duplicate should still appear
      expect(result.agents).toContain("test-engineer");
    });
  });

  describe("inactive domains are ignored", () => {
    it("should not include agents from domains that are not in activeDomains", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const marketingPack = makeDomainPack({
        name: "marketing",
        agents: {
          strategic: ["cmo"],
          implementation: ["content-writer"],
          quality: [],
          utility: [],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["marketing", marketingPack],
      ]);

      // Only core is active — marketing should not contribute agents
      const result = composeTeamFromDomains(scan, ["core"], domainPacks);

      expect(result.agents).toContain("architect");
      expect(result.agents).not.toContain("cmo");
      expect(result.agents).not.toContain("content-writer");
    });
  });

  describe("model assignments", () => {
    it("should assign model tiers for all merged agents", () => {
      const scan = makeScanResult({});
      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: [],
          implementation: [],
          quality: ["security-auditor"],
          utility: ["devops-engineer"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["software", softwarePack],
      ]);

      const result = composeTeamFromDomains(scan, ["core", "software"], domainPacks);

      // Every agent should have a model assignment
      for (const agent of result.agents) {
        expect(result.model_assignments[agent]).toBeDefined();
      }
    });
  });

  describe("conditional logic still applies", () => {
    it("should still apply custom agent generation for software domain scans", () => {
      const apiFiles = Array.from({ length: 6 }, (_, i) => ({
        file_path: `src/controllers/controller-${i}.ts`,
        language: "TypeScript" as const,
        loc: 100,
        imports: [],
        exports: [],
        framework_indicators: [],
        patterns: [],
      }));
      const scan = makeScanResult({ files: { files: apiFiles } });

      const corePack = makeDomainPack({
        name: "core",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["linter"],
          utility: ["researcher", "file-reader"],
        },
      });
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: [],
          implementation: [],
          quality: [],
          utility: [],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["core", corePack],
        ["software", softwarePack],
      ]);

      const result = composeTeamFromDomains(scan, ["core", "software"], domainPacks);

      const apiSpec = result.custom_agents.find((a) => a.name === "api-specialist");
      expect(apiSpec).toBeDefined();
    });
  });

  describe("backward compatibility", () => {
    it("composeTeam should produce same results as before (wrapper behavior)", () => {
      const scan = makeScanResult({
        dependencies: {
          test_frameworks: ["vitest"],
        },
        ci: { ci_provider: "github-actions" },
      });

      const result = composeTeam(scan);

      // Core agents
      expect(result.agents).toContain("architect");
      expect(result.agents).toContain("coder");
      // Conditional agents still work
      expect(result.agents).toContain("test-engineer");
      expect(result.agents).toContain("devops-engineer");
    });
  });
});
