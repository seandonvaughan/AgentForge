/**
 * Tests for synthesis.ts — Phase B of the agent-driven forge pipeline.
 *
 * Uses a mocked AgentRuntime to avoid real Opus calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  synthesizeTeam,
  SynthesisCapacityError,
  SynthesisParseError,
  type TeamPlan,
  type TeamPlanAgent,
  type SynthesizeTeamOptions,
} from "../synthesis.js";
import type { AgentRuntime } from "../../../../agent-runtime/agent-runtime.js";
import type { RunResult } from "../../../../agent-runtime/types.js";
import type {
  SubsystemsReport,
  DependenciesReport,
  ConventionsReport,
  DomainReport,
  HistoryReport,
} from "../recon/schemas.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SUBSYSTEMS: SubsystemsReport = {
  subsystems: [
    {
      name: "server",
      path: "packages/server/src",
      description: "Fastify HTTP server",
      public_surface: ["packages/server/src/server.ts"],
      owner_hint: "backend-team",
    },
    {
      name: "dashboard",
      path: "packages/dashboard/src",
      description: "SvelteKit frontend",
      public_surface: ["packages/dashboard/src/routes/+layout.svelte"],
      owner_hint: "frontend-team",
    },
  ],
};

const MOCK_DEPENDENCIES: DependenciesReport = {
  package_manager: "pnpm",
  prod_deps: [
    { name: "fastify", version: "^4.0.0", category: "framework", in_use_proven: true },
    { name: "zod", version: "^3.0.0", category: "validation", in_use_proven: true },
  ],
  dev_deps: [
    { name: "vitest", version: "^1.0.0", category: "test", in_use_proven: true },
  ],
  framework_signals: [
    { name: "fastify", evidence_files: ["packages/server/src/server.ts"], confidence: 0.95 },
    { name: "sveltekit", evidence_files: ["packages/dashboard/svelte.config.js"], confidence: 0.9 },
  ],
};

const MOCK_CONVENTIONS: ConventionsReport = {
  formatter: "prettier",
  linter: "eslint",
  linter_rules: ["@typescript-eslint/recommended"],
  test_runner: "vitest",
  test_pattern: ["**/__tests__/*.test.ts"],
  file_layout: ["packages/<name>/src", "packages/<name>/src/__tests__"],
  import_style: "esm",
  error_handling_pattern: "throw new Error()",
};

const MOCK_DOMAIN: DomainReport = {
  product_name: "TestProject",
  one_liner: "A test project for synthesis testing",
  user_personas: ["developer", "ops-engineer"],
  core_primitives: ["agent", "cycle", "forge"],
  domain_vocabulary: ["forge", "recon", "synthesis", "roster"],
  non_goals: ["consumer mobile app"],
};

const MOCK_HISTORY: HistoryReport = {
  recurring_bug_patterns: [
    { pattern: "concurrent write conflicts in audit.db", count: 3, last_seen: "2026-05-01" },
  ],
  gate_rejection_themes: ["missing test coverage", "type errors in new routes"],
  cost_outliers: ["synthesis-phase exceeded budget twice"],
  high_value_subsystems: ["packages/server/src"],
};

const MOCK_CORPUS = [
  { path: "packages/server/src/server.ts", content: "// fastify server entry" },
  { path: "packages/dashboard/src/routes/+layout.svelte", content: "<!-- svelte layout -->" },
];

const MOCK_RECON = {
  subsystems: MOCK_SUBSYSTEMS,
  dependencies: MOCK_DEPENDENCIES,
  conventions: MOCK_CONVENTIONS,
  domain: MOCK_DOMAIN,
  history: MOCK_HISTORY,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary project root for file-system assertions. */
async function makeTmpRoot(): Promise<string> {
  const dir = join(tmpdir(), `synthesis-test-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Build a valid TeamPlan JSON with a given agent count. */
function buildTeamPlanJson(agentCount: number, includePmm = true): string {
  const agents: TeamPlanAgent[] = [];

  if (includePmm) {
    agents.push({
      id: "pr-merge-manager",
      tier: "sonnet",
      category: "utility",
      owns_subsystems: [],
      capability_tags: ["git", "merge"],
      system_prompt:
        "You are the PR merge manager. Primary files: `packages/server/src/server.ts`, `.github/workflows/ci.yml`.",
      auto_include_files: [".github/workflows/ci.yml"],
      learnings_seed: [],
    });
  }

  // Add an architect
  agents.push({
    id: "architect",
    tier: "opus",
    category: "strategic",
    owns_subsystems: ["packages/server/src"],
    capability_tags: ["fastify", "architecture"],
    system_prompt:
      "You are the architect. Primary files: `packages/server/src/server.ts`, `packages/dashboard/src/routes/+layout.svelte`.",
    auto_include_files: ["packages/server/src/server.ts"],
    learnings_seed: ["watch for concurrent write conflicts in audit.db"],
  });

  // Fill up to agentCount with implementation agents
  const needed = agentCount - agents.length;
  for (let i = 0; i < needed; i++) {
    agents.push({
      id: `engineer-${String(i).padStart(2, "0")}`,
      tier: "sonnet",
      category: "implementation",
      owns_subsystems: ["packages/server/src"],
      capability_tags: [`fastify-route-${i}`, "typescript"],
      system_prompt: `You are engineer-${i}. Primary files: \`packages/server/src/server.ts\`, \`packages/dashboard/src/routes/+layout.svelte\`.`,
      auto_include_files: ["packages/server/src/server.ts"],
      learnings_seed: [],
    });
  }

  const plan: TeamPlan = {
    team_name: "test-team",
    agents,
  };

  return `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

/** Create a mock AgentRuntime that returns the given response string. */
function mockRuntime(response: string): AgentRuntime {
  return {
    run: vi.fn().mockResolvedValue({
      sessionId: "mock-session",
      response,
      model: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.05,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
    } satisfies RunResult),
  } as unknown as AgentRuntime;
}

/** Create a mock AgentRuntime that returns a failure. */
function mockFailedRuntime(): AgentRuntime {
  return {
    run: vi.fn().mockResolvedValue({
      sessionId: "mock-session",
      response: "",
      model: "claude-opus-4-7",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "failed",
      error: "Opus timed out",
    } satisfies RunResult),
  } as unknown as AgentRuntime;
}

function buildOpts(
  runtime: AgentRuntime,
  projectRoot: string,
  overrides?: Partial<SynthesizeTeamOptions>,
): SynthesizeTeamOptions {
  return {
    reconResults: MOCK_RECON,
    sourceCorpus: MOCK_CORPUS,
    projectRoot,
    runtime,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeTeam", () => {
  describe("synthesis prompt loading", () => {
    it("loads synthesis-prompt.md from disk and passes it as systemPrompt", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(13));

      await synthesizeTeam(buildOpts(runtime, projectRoot));

      // The runtime.run was called (prompt was loaded successfully, no throw)
      expect(runtime.run).toHaveBeenCalledOnce();
    });

    it("synthesis-prompt.md contains key instructions", async () => {
      const promptPath = new URL("../synthesis-prompt.md", import.meta.url);
      const content = await readFile(fileURLToPath(promptPath), "utf-8");

      expect(content).toContain("pr-merge-manager");
      expect(content).toContain("12–30");
      expect(content).toContain("owns_subsystems");
      expect(content).toContain("capability_tags");
      expect(content).toContain("auto_include_files");
    });
  });

  describe("user message construction", () => {
    it("includes recon JSON in user message", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(13));

      await synthesizeTeam(buildOpts(runtime, projectRoot));

      const callArg = ((runtime.run as ReturnType<typeof vi.fn>).mock.calls[0] as [{ task: string }])[0];
      expect(callArg.task).toContain("packages/server/src");
      expect(callArg.task).toContain("fastify");
      expect(callArg.task).toContain("TestProject");
    });

    it("includes source corpus with ### file: headers", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(13));

      await synthesizeTeam(buildOpts(runtime, projectRoot));

      const callArg = ((runtime.run as ReturnType<typeof vi.fn>).mock.calls[0] as [{ task: string }])[0];
      expect(callArg.task).toContain("### file: packages/server/src/server.ts");
      expect(callArg.task).toContain("### file: packages/dashboard/src/routes/+layout.svelte");
    });
  });

  describe("output parsing", () => {
    it("parses a valid Opus response and returns a TeamPlan", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(13));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      expect(plan.team_name).toBe("test-team");
      expect(plan.agents.length).toBeGreaterThanOrEqual(13);
    });

    it("throws SynthesisParseError when response has no fenced JSON block", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime("Here is my response with no JSON block at all.");

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow(SynthesisParseError);
    });

    it("throws SynthesisParseError when fenced block contains invalid JSON", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime("```json\n{ this is not valid json }\n```");

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow(SynthesisParseError);
    });

    it("throws SynthesisParseError when JSON does not match TeamPlan schema", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime('```json\n{"team_name": "x"}\n```');

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow(SynthesisParseError);
    });

    it("throws when runtime run fails", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockFailedRuntime();

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow("Synthesis runtime call failed");
    });
  });

  describe("pr-merge-manager injection", () => {
    it("passes plan through unchanged when pr-merge-manager is already present", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(13, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      const pmmAgents = plan.agents.filter((a) => a.id === "pr-merge-manager");
      expect(pmmAgents).toHaveLength(1);
    });

    it("injects baseline pr-merge-manager when synthesis omits it", async () => {
      const projectRoot = await makeTmpRoot();
      // 13 agents, no pmm
      const runtime = mockRuntime(buildTeamPlanJson(13, false));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      const pmm = plan.agents.find((a) => a.id === "pr-merge-manager");
      expect(pmm).toBeDefined();
      expect(pmm?.tier).toBe("sonnet");
      expect(pmm?.capability_tags).toContain("merge");
    });

    it("injected pr-merge-manager has correct capability_tags", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, false));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      const pmm = plan.agents.find((a) => a.id === "pr-merge-manager");
      expect(pmm?.capability_tags).toEqual(
        expect.arrayContaining(["git", "merge", "rebase", "pr-queue", "conflict-resolution"]),
      );
    });
  });

  describe("roster size cap", () => {
    it("accepts exactly 12 agents (minimum)", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));
      expect(plan.agents.length).toBe(12);
    });

    it("accepts exactly 30 agents (maximum)", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(30, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));
      // may be 30 or 31 if pmm was missing and injected, but test has pmm
      expect(plan.agents.length).toBe(30);
    });

    it("accepts 25 agents", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(25, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));
      expect(plan.agents.length).toBe(25);
    });

    it("rejects 11 agents with SynthesisCapacityError", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(11, true));

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow(SynthesisCapacityError);
    });

    it("rejects 31 agents with SynthesisCapacityError", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(31, true));

      await expect(
        synthesizeTeam(buildOpts(runtime, projectRoot)),
      ).rejects.toThrow(SynthesisCapacityError);
    });

    it("SynthesisCapacityError contains correct rosterSize, min, max", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(5, true));

      const err = await synthesizeTeam(buildOpts(runtime, projectRoot)).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(SynthesisCapacityError);
      expect((err as SynthesisCapacityError).rosterSize).toBe(5);
      expect((err as SynthesisCapacityError).min).toBe(12);
      expect((err as SynthesisCapacityError).max).toBe(30);
    });
  });

  describe("emitted file structure", () => {
    it("creates .agentforge/agents/<id>.yaml per agent", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      for (const agent of plan.agents) {
        const filePath = join(projectRoot, ".agentforge", "agents", `${agent.id}.yaml`);
        const content = await readFile(filePath, "utf-8");
        expect(content).toBeTruthy();

        const parsed = yaml.load(content) as Record<string, unknown>;
        expect(parsed.name).toBe(agent.id);
        expect(parsed.model).toBe(agent.tier);
      }
    });

    it("creates .claude/agents/<id>.md per agent", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      for (const agent of plan.agents) {
        const filePath = join(projectRoot, ".claude", "agents", `${agent.id}.md`);
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("---");
        expect(content).toContain(`name: ${agent.id}`);
        expect(content).toContain(`model: ${agent.tier}`);
        expect(content).toContain("tools: Read,Edit,Write,Bash,Grep,Glob");
      }
    });

    it("creates .agentforge/team.yaml with correct structure", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      await synthesizeTeam(buildOpts(runtime, projectRoot));

      const teamYamlPath = join(projectRoot, ".agentforge", "team.yaml");
      const content = await readFile(teamYamlPath, "utf-8");
      const parsed = yaml.load(content) as Record<string, unknown>;

      expect(parsed.name).toBe("test-team");
      expect(parsed.forged_at).toBeDefined();
      expect(parsed.forged_by).toBe("agentforge-synthesis");
      expect(parsed.agents).toBeDefined();
      expect(parsed.model_routing).toBeDefined();
      expect(parsed.delegation_graph).toBeDefined();
    });

    it("creates .agentforge/forge/team-plan.json", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      const planPath = join(projectRoot, ".agentforge", "forge", "team-plan.json");
      const content = await readFile(planPath, "utf-8");
      const parsed = JSON.parse(content) as TeamPlan;

      expect(parsed.team_name).toBe(plan.team_name);
      expect(parsed.agents).toHaveLength(plan.agents.length);
    });

    it("team.yaml model_routing groups agents by tier", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      const plan = await synthesizeTeam(buildOpts(runtime, projectRoot));

      const teamYamlPath = join(projectRoot, ".agentforge", "team.yaml");
      const content = await readFile(teamYamlPath, "utf-8");
      const parsed = yaml.load(content) as {
        model_routing: Record<string, string[]>;
      };

      const opusAgents = plan.agents.filter((a) => a.tier === "opus");
      const sonnetAgents = plan.agents.filter((a) => a.tier === "sonnet");

      expect(parsed.model_routing.opus).toHaveLength(opusAgents.length);
      expect(parsed.model_routing.sonnet).toHaveLength(sonnetAgents.length);
    });

    it("all output files exist after synthesis", async () => {
      const projectRoot = await makeTmpRoot();
      const runtime = mockRuntime(buildTeamPlanJson(12, true));

      await synthesizeTeam(buildOpts(runtime, projectRoot));

      const expectedPaths = [
        join(projectRoot, ".agentforge", "team.yaml"),
        join(projectRoot, ".agentforge", "forge", "team-plan.json"),
      ];

      for (const p of expectedPaths) {
        const s = await stat(p);
        expect(s.isFile()).toBe(true);
      }
    });
  });
});
