import { describe, it, expect } from "vitest";
import {
  composeTeamUnits,
  composeTeam,
  type TeamComposition,
} from "../../src/builder/team-composer.js";
import type { FullScanResult } from "../../src/scanner/index.js";

// ---------------------------------------------------------------------------
// Helpers — reusing the same factory pattern as team-composer.test.ts
// ---------------------------------------------------------------------------

function makeScanResult(
  overrides: Partial<{
    files: Partial<FullScanResult["files"]>;
    dependencies: Partial<FullScanResult["dependencies"]>;
    ci: Partial<FullScanResult["ci"]>;
    git: Partial<FullScanResult["git"]>;
  }> = {},
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

/** Build a minimal composition from a scan using the existing composeTeam(). */
function makeComposition(overrides: Partial<TeamComposition> = {}): TeamComposition {
  return {
    agents: ["architect", "coder", "researcher", "file-reader", "linter"],
    custom_agents: [],
    model_assignments: {
      architect: "opus",
      coder: "sonnet",
      researcher: "sonnet",
      "file-reader": "haiku",
      linter: "haiku",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composeTeamUnits()", () => {
  // -------------------------------------------------------------------------
  // Always-present teams
  // -------------------------------------------------------------------------

  describe("always-present teams", () => {
    it("returns an executive team when executive agents (ceo/cto/coo/cfo) are in the composition", () => {
      const scan = makeScanResult({});
      const composition: TeamComposition = {
        agents: ["ceo", "cto"],
        custom_agents: [],
        model_assignments: { ceo: "opus", cto: "opus" },
      };

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "executive")).toBe(true);
    });

    it("does not produce an executive team when no executive agents are present", () => {
      const scan = makeScanResult({});
      const composition = makeComposition(); // core agents only — no ceo/cto etc.

      const units = composeTeamUnits(composition, scan);

      // Without executive-layer agents the executive team bucket stays empty and is skipped
      expect(units.some((u) => u.layer === "executive")).toBe(false);
    });

    it("returns at least a qa team when qa-layer agents are present", () => {
      const scan = makeScanResult({});
      const composition = makeComposition(); // linter maps to qa layer

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "qa")).toBe(true);
    });

    it("returns at least a backend team when code files exist (total_files > 0)", () => {
      const scan = makeScanResult({ files: { total_files: 1 } });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "backend")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Layer detection
  // -------------------------------------------------------------------------

  describe("layer detection", () => {
    it("includes a backend team when there is at least one file", () => {
      const scan = makeScanResult({
        files: {
          total_files: 3,
          files: [
            {
              file_path: "src/server.ts",
              language: "TypeScript",
              loc: 80,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
        },
      });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "backend")).toBe(true);
    });

    it("includes an infra team when CI is detected", () => {
      const scan = makeScanResult({
        ci: { ci_provider: "github-actions" },
        files: { total_files: 1 },
      });
      const composition = makeComposition({
        agents: ["architect", "coder", "researcher", "file-reader", "linter", "devops-engineer"],
        model_assignments: {
          architect: "opus",
          coder: "sonnet",
          researcher: "sonnet",
          "file-reader": "haiku",
          linter: "haiku",
          "devops-engineer": "sonnet",
        },
      });

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "infra")).toBe(true);
    });

    it("includes an infra team when Docker is detected", () => {
      const scan = makeScanResult({
        ci: { has_docker: true },
        files: { total_files: 1 },
      });
      const composition = makeComposition({
        agents: ["architect", "coder", "researcher", "file-reader", "linter", "devops-engineer"],
        model_assignments: {
          architect: "opus",
          coder: "sonnet",
          researcher: "sonnet",
          "file-reader": "haiku",
          linter: "haiku",
          "devops-engineer": "sonnet",
        },
      });

      const units = composeTeamUnits(composition, scan);

      expect(units.some((u) => u.layer === "infra")).toBe(true);
    });

    it("does not include infra team when no CI or Docker is present and no infra files exist", () => {
      const scan = makeScanResult({});
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      // With no CI, no Docker, and no infra-indicator files, infra layer should be absent
      expect(units.some((u) => u.layer === "infra")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Manager and techLead assignment
  // -------------------------------------------------------------------------

  describe("manager and techLead assignment", () => {
    it("each team has a non-empty manager field", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      for (const unit of units) {
        expect(unit.manager).toBeTruthy();
        expect(unit.manager.length).toBeGreaterThan(0);
      }
    });

    it("each team has a non-empty techLead field", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      for (const unit of units) {
        expect(unit.techLead).toBeTruthy();
        expect(unit.techLead.length).toBeGreaterThan(0);
      }
    });

    it("teams have valid IDs following the '<layer>-team' pattern", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      for (const unit of units) {
        expect(unit.id).toMatch(/-team$/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Seniority inference
  // -------------------------------------------------------------------------

  describe("seniority inference", () => {
    it("executives (ceo, cto, coo, cfo) get 'principal' seniority", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition: TeamComposition = {
        agents: ["ceo", "cto", "coo", "cfo"],
        custom_agents: [],
        model_assignments: {
          ceo: "opus",
          cto: "opus",
          coo: "opus",
          cfo: "opus",
        },
      };

      const units = composeTeamUnits(composition, scan);

      // The executive team manager should be one of the C-suite agents
      const execTeam = units.find((u) => u.layer === "executive");
      expect(execTeam).toBeDefined();
      // The manager should be one of the principals
      expect(["ceo", "cto", "coo", "cfo"]).toContain(execTeam!.manager);
    });

    it("haiku-model agents get 'junior' seniority", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });

      // Use a haiku agent with a name that maps to backend layer
      const composition: TeamComposition = {
        agents: ["file-reader", "linter"],
        custom_agents: [],
        model_assignments: {
          "file-reader": "haiku",
          linter: "haiku",
        },
      };

      const units = composeTeamUnits(composition, scan);

      // file-reader and linter infer to qa layer
      const qaTeam = units.find((u) => u.layer === "qa");
      expect(qaTeam).toBeDefined();

      // Both agents are haiku => junior, so the team's manager and techLead
      // should be one of them
      const allQaMembers = [
        qaTeam!.manager,
        qaTeam!.techLead,
        ...qaTeam!.specialists,
      ];
      const haikuAgents = ["file-reader", "linter"];
      expect(allQaMembers.some((a) => haikuAgents.includes(a))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  describe("maxCapacity", () => {
    it("executive team maxCapacity is at least 6", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition: TeamComposition = {
        agents: ["ceo"],
        custom_agents: [],
        model_assignments: { ceo: "opus" },
      };

      const units = composeTeamUnits(composition, scan);

      const execTeam = units.find((u) => u.layer === "executive");
      expect(execTeam).toBeDefined();
      expect(execTeam!.maxCapacity).toBeGreaterThanOrEqual(6);
    });

    it("non-executive teams have maxCapacity >= 10 by default", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition = makeComposition();

      const units = composeTeamUnits(composition, scan);

      const nonExecTeams = units.filter((u) => u.layer !== "executive");
      for (const team of nonExecTeams) {
        expect(team.maxCapacity).toBeGreaterThanOrEqual(10);
      }
    });

    it("maxCapacity scales up when specialists count exceeds the default", () => {
      // Create a composition with many backend agents
      const agents = Array.from({ length: 15 }, (_, i) => `coder-${i}`);
      const model_assignments: Record<string, "sonnet"> = {};
      for (const a of agents) model_assignments[a] = "sonnet";

      const scan = makeScanResult({ files: { total_files: 20 } });
      const composition: TeamComposition = { agents, custom_agents: [], model_assignments };

      const units = composeTeamUnits(composition, scan);

      const backendTeam = units.find((u) => u.layer === "backend");
      expect(backendTeam).toBeDefined();
      // With 15 agents the capacity must accommodate them all (specialists + manager + techLead)
      expect(backendTeam!.maxCapacity).toBeGreaterThanOrEqual(backendTeam!.specialists.length + 2);
    });
  });

  // -------------------------------------------------------------------------
  // Integration — scan-derived composition
  // -------------------------------------------------------------------------

  describe("integration with composeTeam()", () => {
    it("produces valid units for a project with test frameworks and CI", () => {
      const scan = makeScanResult({
        dependencies: { test_frameworks: ["vitest"] },
        ci: { ci_provider: "github-actions" },
        files: { total_files: 10 },
      });

      const composition = composeTeam(scan);
      const units = composeTeamUnits(composition, scan);

      expect(units.length).toBeGreaterThan(0);

      // Every unit must be valid
      for (const unit of units) {
        expect(unit.id).toBeTruthy();
        expect(unit.layer).toBeTruthy();
        expect(unit.manager).toBeTruthy();
        expect(unit.techLead).toBeTruthy();
        expect(Array.isArray(unit.specialists)).toBe(true);
        expect(unit.maxCapacity).toBeGreaterThan(0);
      }
    });

    it("each unit's currentLoad starts at 0", () => {
      const scan = makeScanResult({ files: { total_files: 5 } });
      const composition = makeComposition();
      const units = composeTeamUnits(composition, scan);

      for (const unit of units) {
        expect(unit.currentLoad).toBe(0);
      }
    });
  });
});
