/**
 * Tests for the deterministic team plan validator (Phase C).
 *
 * Each test gets an isolated tmp directory. Team-plan fixtures mix valid
 * and hallucinated paths to exercise every check type.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateTeam } from "../validator.js";
import type { ValidationReport } from "../validator.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-validator-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeTeamPlan(plan: unknown): string {
  const forgeDir = join(projectRoot, ".agentforge", "forge");
  mkdirSync(forgeDir, { recursive: true });
  const planPath = join(forgeDir, "team-plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  return planPath;
}

function createRealFile(rel: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "// placeholder");
}

function createRealDir(rel: string): void {
  mkdirSync(join(projectRoot, rel), { recursive: true });
}

describe("check (a) — auto_include_files", () => {
  it("flags a path that does not exist", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "route-engineer",
          auto_include_files: ["packages/server/src/server.ts"],
          owns_subsystems: [],
          system_prompt: "You are the route-engineer agent.",
          description: "Route engineer for the API layer.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    expect(report.valid).toBe(false);
    const finding = report.findings.find(
      (f) => f.check === "auto_include_files",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("ERROR");
    expect(finding!.agentId).toBe("route-engineer");
  });

  it("passes when all auto_include_files exist", async () => {
    createRealFile("packages/server/src/server.ts");
    writeTeamPlan({
      agents: [
        {
          id: "route-engineer",
          auto_include_files: ["packages/server/src/server.ts"],
          owns_subsystems: [],
          system_prompt: "You are the route-engineer agent.",
          description: "Route engineer.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    const autoIncludeErrors = report.findings.filter(
      (f) => f.check === "auto_include_files",
    );
    expect(autoIncludeErrors).toHaveLength(0);
  });
});

describe("check (b) — owns_subsystems", () => {
  it("flags a subsystem path that does not exist", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "db-specialist",
          auto_include_files: [],
          owns_subsystems: ["packages/db/src/nonexistent"],
          system_prompt: "You are the db-specialist agent.",
          description: "Database specialist.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    expect(report.valid).toBe(false);
    const finding = report.findings.find((f) => f.check === "owns_subsystems");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("ERROR");
    expect(finding!.agentId).toBe("db-specialist");
  });

  it("passes when all owns_subsystems dirs exist", async () => {
    createRealDir("packages/db/src");
    writeTeamPlan({
      agents: [
        {
          id: "db-specialist",
          auto_include_files: [],
          owns_subsystems: ["packages/db/src"],
          system_prompt: "You are the db-specialist agent.",
          description: "Database specialist.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    const subsystemErrors = report.findings.filter(
      (f) => f.check === "owns_subsystems",
    );
    expect(subsystemErrors).toHaveLength(0);
  });
});

describe("check (c) — system_prompt path references", () => {
  it("warns on a prompt that references a non-existent file path", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "frontend-dev",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt:
            "See packages/dashboard/src/routes/+layout.svelte for the shell.",
          description: "Frontend developer.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    const finding = report.findings.find(
      (f) => f.check === "system_prompt_paths",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARN");
    expect(finding!.agentId).toBe("frontend-dev");
  });

  it("does not warn on a prompt that references a real file", async () => {
    createRealFile("packages/dashboard/src/routes/+layout.svelte");
    writeTeamPlan({
      agents: [
        {
          id: "frontend-dev",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt:
            "See packages/dashboard/src/routes/+layout.svelte for the shell.",
          description: "Frontend developer.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    const promptPathWarnings = report.findings.filter(
      (f) => f.check === "system_prompt_paths",
    );
    expect(promptPathWarnings).toHaveLength(0);
  });
});

describe("check (d) — domain contradiction", () => {
  it("warns when description mentions a tech absent from domain report", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "api-specialist",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: "You are the api-specialist agent.",
          description: "Django REST framework specialist for the API layer.",
        },
      ],
      domain_report: {
        keywords: ["typescript", "svelte", "fastify"],
        tech_stack: ["typescript", "node"],
      },
    });

    const report = await validateTeam({ projectRoot });
    const finding = report.findings.find(
      (f) => f.check === "domain_contradiction",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("WARN");
    expect(finding!.message).toMatch(/django/i);
  });

  it("does not warn when tech in description matches domain report", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "api-specialist",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: "You are the api-specialist agent.",
          description: "TypeScript Fastify route specialist.",
        },
      ],
      domain_report: {
        keywords: ["typescript", "fastify"],
        tech_stack: ["typescript", "node"],
      },
    });

    const report = await validateTeam({ projectRoot });
    const domainFindings = report.findings.filter(
      (f) => f.check === "domain_contradiction",
    );
    expect(domainFindings).toHaveLength(0);
  });
});

describe("check (e) — duplicate system_prompt", () => {
  it("errors when two agents have identical system prompts", async () => {
    const sharedPrompt = "You are the Coder agent. Write production code.";
    writeTeamPlan({
      agents: [
        {
          id: "coder",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: sharedPrompt,
          description: "Primary coder.",
        },
        {
          id: "api-specialist",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: sharedPrompt,
          description: "API specialist.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    expect(report.valid).toBe(false);
    const finding = report.findings.find((f) => f.check === "duplicate_prompt");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("ERROR");
    expect(finding!.agentId).toBe("api-specialist");
  });

  it("does not flag agents with unique prompts", async () => {
    writeTeamPlan({
      agents: [
        {
          id: "coder",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: "You are the coder. You write TypeScript Fastify routes.",
          description: "Primary coder.",
        },
        {
          id: "qa-engineer",
          auto_include_files: [],
          owns_subsystems: [],
          system_prompt: "You are the QA engineer. You write vitest tests.",
          description: "QA engineer.",
        },
      ],
    });

    const report = await validateTeam({ projectRoot });
    const dupFindings = report.findings.filter(
      (f) => f.check === "duplicate_prompt",
    );
    expect(dupFindings).toHaveLength(0);
  });
});

describe("clean plan", () => {
  it("returns valid=true when a plan has no errors or warnings", async () => {
    createRealFile("packages/server/src/server.ts");
    createRealDir("packages/server/src/routes");

    writeTeamPlan({
      agents: [
        {
          id: "route-engineer",
          auto_include_files: ["packages/server/src/server.ts"],
          owns_subsystems: ["packages/server/src/routes"],
          system_prompt:
            "You are the route-engineer. You own the Fastify v5 route layer.",
          description: "Fastify route engineer.",
        },
      ],
      domain_report: {
        keywords: ["typescript", "fastify", "node"],
        tech_stack: ["typescript"],
      },
    });

    const report: ValidationReport = await validateTeam({ projectRoot });
    expect(report.valid).toBe(true);
    expect(report.agentsChecked).toBe(1);
    expect(report.findings).toHaveLength(0);
  });

  it("writes validation-report.json under .agentforge/forge/", async () => {
    const { existsSync } = await import("node:fs");
    writeTeamPlan({ agents: [] });

    await validateTeam({ projectRoot });

    const reportPath = join(
      projectRoot,
      ".agentforge",
      "forge",
      "validation-report.json",
    );
    expect(existsSync(reportPath)).toBe(true);
  });

  it("returns valid=false when team-plan.json does not exist", async () => {
    const report = await validateTeam({
      projectRoot,
      teamPlanPath: join(projectRoot, "nonexistent-plan.json"),
    });
    expect(report.valid).toBe(false);
    expect(report.findings[0]!.agentId).toBe("__meta__");
  });
});
