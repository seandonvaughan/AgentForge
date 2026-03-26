/**
 * Tests for the team-writer merge logic (P0-4).
 *
 * Verifies that `mergeManifests` correctly combines a newly-scanned
 * TeamManifest with an existing one so that manually-added agents,
 * delegation_graph entries, model_routing slots, and custom metadata
 * (team_size, version) are never lost.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { mergeManifests, writeTeam } from "../../src/builder/team-writer.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type { FullScanResult } from "../../src/scanner/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    name: "test-team",
    forged_at: "2026-03-26T10:00:00.000Z",
    forged_by: "agentforge",
    project_hash: "abc123",
    agents: {
      strategic: [],
      implementation: [],
      quality: [],
      utility: [],
    },
    model_routing: { opus: [], sonnet: [], haiku: [] },
    delegation_graph: {},
    ...overrides,
  };
}

function makeAgentTemplate(name: string, model: "opus" | "sonnet" | "haiku" = "sonnet"): AgentTemplate {
  return {
    name,
    model,
    version: "1.0",
    description: `${name} agent`,
    system_prompt: `You are the ${name} agent.`,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: "architect",
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 30, auto_include: [], project_specific: [] },
  };
}

function makeMinimalScanResult(): FullScanResult {
  return {
    files: {
      files: [],
      languages: {},
      frameworks_detected: [],
      total_files: 0,
      total_loc: 0,
      directory_structure: [],
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
    },
    ci: {
      ci_provider: "none",
      config_files: [],
      pipelines: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// mergeManifests — unit tests
// ---------------------------------------------------------------------------

describe("mergeManifests — agent preservation", () => {
  it("keeps all scanned agents when there is no overlap with existing", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo", "architect"],
        implementation: ["coder"],
        quality: ["linter"],
        utility: ["researcher"],
      },
    });

    const existing = makeManifest({
      agents: {
        strategic: [],
        implementation: [],
        quality: [],
        utility: [],
      },
    });

    const merged = mergeManifests(scanned, existing);
    expect(merged.agents.strategic).toContain("ceo");
    expect(merged.agents.strategic).toContain("architect");
    expect(merged.agents.implementation).toContain("coder");
  });

  it("preserves manually-added agents not in the new scan", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: ["coder"],
        quality: [],
        utility: [],
      },
    });

    const existing = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: ["coder"],
        quality: ["linter"],
        ui: ["ui-ux-designer", "frontend-dev", "dashboard-architect"],
        utility: ["researcher", "file-reader"],
      },
    });

    const merged = mergeManifests(scanned, existing);

    // Scanned agents still present
    expect(merged.agents.strategic).toContain("ceo");
    expect(merged.agents.implementation).toContain("coder");

    // Manual agents preserved
    expect(merged.agents.quality).toContain("linter");
    expect(merged.agents.ui).toBeDefined();
    expect(merged.agents.ui).toContain("ui-ux-designer");
    expect(merged.agents.ui).toContain("frontend-dev");
    expect(merged.agents.ui).toContain("dashboard-architect");
    expect(merged.agents.utility).toContain("researcher");
    expect(merged.agents.utility).toContain("file-reader");
  });

  it("does not duplicate agents that appear in both scanned and existing", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo", "architect"],
        implementation: ["coder"],
        quality: ["linter"],
        utility: [],
      },
    });

    const existing = makeManifest({
      agents: {
        strategic: ["ceo", "architect"],
        implementation: ["coder"],
        quality: ["linter"],
        utility: [],
      },
    });

    const merged = mergeManifests(scanned, existing);

    // No duplicates
    expect(merged.agents.strategic.filter((a) => a === "ceo")).toHaveLength(1);
    expect(merged.agents.strategic.filter((a) => a === "architect")).toHaveLength(1);
    expect(merged.agents.implementation.filter((a) => a === "coder")).toHaveLength(1);
    expect(merged.agents.quality.filter((a) => a === "linter")).toHaveLength(1);
  });

  it("never removes an agent that exists in the existing manifest", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: [],
        quality: [],
        utility: [],
      },
    });

    const existing = makeManifest({
      agents: {
        strategic: ["ceo", "genesis"],
        implementation: ["cto", "coo", "cfo", "meta-architect"],
        quality: ["team-reviewer", "dba", "debugger"],
        utility: ["researcher", "documentation-writer"],
      },
    });

    const merged = mergeManifests(scanned, existing);

    const allMergedAgents = [
      ...merged.agents.strategic,
      ...merged.agents.implementation,
      ...merged.agents.quality,
      ...merged.agents.utility,
    ];

    const allExistingAgents = [
      ...existing.agents.strategic,
      ...existing.agents.implementation,
      ...existing.agents.quality,
      ...existing.agents.utility,
    ];

    for (const agent of allExistingAgents) {
      expect(allMergedAgents).toContain(agent);
    }
  });
});

describe("mergeManifests — model_routing preservation", () => {
  it("preserves model routing for manually-added agents", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: [],
        quality: [],
        utility: [],
      },
      model_routing: { opus: ["ceo"], sonnet: [], haiku: [] },
    });

    const existing = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: ["coder"],
        quality: ["linter"],
        utility: ["researcher", "file-reader"],
      },
      model_routing: {
        opus: ["ceo"],
        sonnet: ["coder"],
        haiku: ["linter", "researcher", "file-reader"],
      },
    });

    const merged = mergeManifests(scanned, existing);

    expect(merged.model_routing.opus).toContain("ceo");
    expect(merged.model_routing.sonnet).toContain("coder");
    expect(merged.model_routing.haiku).toContain("linter");
    expect(merged.model_routing.haiku).toContain("researcher");
    expect(merged.model_routing.haiku).toContain("file-reader");
  });

  it("does not add routing entries for agents not in the merged agent list", () => {
    const scanned = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: [],
        quality: [],
        utility: [],
      },
      model_routing: { opus: ["ceo"], sonnet: [], haiku: [] },
    });

    const existing = makeManifest({
      agents: {
        strategic: ["ceo"],
        implementation: [],
        quality: [],
        utility: [],
      },
      model_routing: {
        opus: ["ceo", "ghost-agent"],
        sonnet: [],
        haiku: [],
      },
    });

    const merged = mergeManifests(scanned, existing);

    // ghost-agent is not in the merged agents list so must not appear in routing
    const allRouted = [
      ...merged.model_routing.opus,
      ...merged.model_routing.sonnet,
      ...merged.model_routing.haiku,
    ];
    expect(allRouted).not.toContain("ghost-agent");
  });
});

describe("mergeManifests — delegation_graph preservation", () => {
  it("preserves delegation graph entries not in the new scan", () => {
    const scanned = makeManifest({
      delegation_graph: {
        ceo: ["cto"],
      },
    });

    const existing = makeManifest({
      delegation_graph: {
        ceo: ["cto", "coo", "genesis"],
        cto: ["architect", "sprint-planner"],
        "dashboard-architect": ["frontend-dev", "data-viz-specialist"],
      },
    });

    const merged = mergeManifests(scanned, existing);

    // Scanned entry wins for 'ceo' (already in scanned)
    expect(merged.delegation_graph["ceo"]).toEqual(["cto"]);

    // Existing-only entries are preserved
    expect(merged.delegation_graph["cto"]).toEqual(["architect", "sprint-planner"]);
    expect(merged.delegation_graph["dashboard-architect"]).toEqual([
      "frontend-dev",
      "data-viz-specialist",
    ]);
  });
});

describe("mergeManifests — metadata preservation", () => {
  it("always uses forged_at and project_hash from the new scan", () => {
    const scanned = makeManifest({
      forged_at: "2026-03-26T12:00:00.000Z",
      project_hash: "new-hash-xyz",
    });

    const existing = makeManifest({
      forged_at: "2025-01-01T00:00:00.000Z",
      project_hash: "old-hash-abc",
    });

    const merged = mergeManifests(scanned, existing);

    expect(merged.forged_at).toBe("2026-03-26T12:00:00.000Z");
    expect(merged.project_hash).toBe("new-hash-xyz");
  });

  it("carries forward custom metadata fields (team_size, version) from existing", () => {
    const scanned = makeManifest({});

    // Simulate what the existing team.yaml looks like with custom fields
    const existing = {
      ...makeManifest({}),
      team_size: 37,
      version: "4.4",
    } as TeamManifest & { team_size: number; version: string };

    const merged = mergeManifests(scanned, existing as unknown as TeamManifest);

    const mergedRecord = merged as Record<string, unknown>;
    expect(mergedRecord["team_size"]).toBe(37);
    expect(mergedRecord["version"]).toBe("4.4");
  });

  it("does not duplicate custom metadata if scanned already has the field", () => {
    const scanned = {
      ...makeManifest({}),
      version: "4.4",
    } as TeamManifest & { version: string };

    const existing = {
      ...makeManifest({}),
      version: "4.3",
      team_size: 37,
    } as TeamManifest & { version: string; team_size: number };

    const merged = mergeManifests(
      scanned as unknown as TeamManifest,
      existing as unknown as TeamManifest,
    );

    // 'version' is in scanned, so scanned value wins (existing is NOT in extraMeta)
    const mergedRecord = merged as Record<string, unknown>;
    expect(mergedRecord["version"]).toBe("4.4");
    // 'team_size' only in existing, so it is carried forward
    expect(mergedRecord["team_size"]).toBe(37);
  });
});

// ---------------------------------------------------------------------------
// writeTeam integration — reads existing team.yaml and merges
// ---------------------------------------------------------------------------

describe("writeTeam — merges with existing team.yaml on disk", () => {
  it("preserves manually-added agents after a re-forge", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "agentforge-merge-test-"));
    dirsToClean.push(projectDir);

    const agentforgeDir = join(projectDir, ".agentforge");
    await mkdir(agentforgeDir, { recursive: true });

    // Write an existing team.yaml with manual agents
    const existingManifest = makeManifest({
      name: "AgentForge-team",
      agents: {
        strategic: ["ceo", "genesis", "architect", "rd-lead"],
        implementation: [
          "cto", "coo", "cfo", "meta-architect", "project-manager",
          "skill-designer", "coder", "sprint-planner", "devops-engineer",
        ],
        quality: ["team-reviewer", "dba", "debugger", "linter", "qa-automation-engineer"],
        ui: ["ui-ux-designer", "frontend-dev", "dashboard-architect"],
        utility: ["researcher", "documentation-writer", "file-reader"],
      },
      model_routing: {
        opus: ["ceo", "genesis", "architect", "cto", "meta-architect", "rd-lead"],
        sonnet: [
          "coo", "cfo", "project-manager", "skill-designer", "coder",
          "sprint-planner", "devops-engineer", "team-reviewer", "dba",
          "debugger", "qa-automation-engineer", "documentation-writer",
          "ui-ux-designer", "frontend-dev", "dashboard-architect",
        ],
        haiku: ["linter", "researcher", "file-reader"],
      },
      delegation_graph: {
        ceo: ["cto", "coo", "cfo", "genesis"],
        "dashboard-architect": ["frontend-dev", "data-viz-specialist"],
      },
      team_size: 37,
      version: "4.4",
    } as unknown as Partial<TeamManifest>);

    await writeFile(
      join(agentforgeDir, "team.yaml"),
      yaml.dump(existingManifest, { lineWidth: 120, noRefs: true }),
      "utf-8",
    );

    // Simulate a new forge that only discovered 3 agents
    const scannedManifest = makeManifest({
      name: "test-project-team",
      forged_at: "2026-03-26T17:00:00.000Z",
      project_hash: "new-hash",
      agents: {
        strategic: ["architect"],
        implementation: ["coder"],
        quality: ["linter"],
        utility: [],
      },
      model_routing: {
        opus: ["architect"],
        sonnet: ["coder"],
        haiku: ["linter"],
      },
      delegation_graph: {
        architect: ["coder"],
      },
    });

    const agentTemplates = new Map<string, AgentTemplate>([
      ["architect", makeAgentTemplate("architect", "opus")],
      ["coder", makeAgentTemplate("coder", "sonnet")],
      ["linter", makeAgentTemplate("linter", "haiku")],
    ]);

    await writeTeam(projectDir, scannedManifest, agentTemplates, makeMinimalScanResult());

    // Read back the written team.yaml
    const { readFile } = await import("node:fs/promises");
    const writtenContent = await readFile(join(agentforgeDir, "team.yaml"), "utf-8");
    const written = yaml.load(writtenContent) as Record<string, unknown>;

    // All manually-added agents must be present
    const writtenManifest = written as unknown as TeamManifest & {
      ui?: string[];
      team_size?: number;
      version?: string;
    };

    // Scanned agents present
    expect(writtenManifest.agents.strategic).toContain("architect");
    expect(writtenManifest.agents.implementation).toContain("coder");
    expect(writtenManifest.agents.quality).toContain("linter");

    // Manual agents preserved
    expect(writtenManifest.agents.strategic).toContain("ceo");
    expect(writtenManifest.agents.strategic).toContain("genesis");
    expect(writtenManifest.agents.strategic).toContain("rd-lead");
    expect(writtenManifest.agents.implementation).toContain("cto");
    expect(writtenManifest.agents.quality).toContain("team-reviewer");
    expect(writtenManifest.agents.quality).toContain("dba");

    // Custom ui category preserved
    const anyCategory = written as Record<string, unknown>;
    const agentsMap = anyCategory["agents"] as Record<string, string[]>;
    expect(agentsMap["ui"]).toBeDefined();
    expect(agentsMap["ui"]).toContain("ui-ux-designer");
    expect(agentsMap["ui"]).toContain("frontend-dev");
    expect(agentsMap["ui"]).toContain("dashboard-architect");

    // Model routing preserved for manual agents
    const routing = writtenManifest.model_routing as { opus: string[]; sonnet: string[]; haiku: string[] };
    expect(routing.opus).toContain("ceo");
    expect(routing.opus).toContain("genesis");
    // cto is listed in existing.model_routing.opus per the real team.yaml
    expect(routing.opus).toContain("cto");
    expect(routing.haiku).toContain("researcher");

    // Delegation graph entry for dashboard-architect preserved
    const delegation = written["delegation_graph"] as Record<string, string[]>;
    expect(delegation["dashboard-architect"]).toBeDefined();
    expect(delegation["dashboard-architect"]).toContain("frontend-dev");

    // forged_at updated to new scan timestamp
    expect(written["forged_at"]).toBe("2026-03-26T17:00:00.000Z");
  });

  it("works correctly for a fresh forge with no existing team.yaml", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "agentforge-fresh-test-"));
    dirsToClean.push(projectDir);

    const scannedManifest = makeManifest({
      agents: {
        strategic: ["architect"],
        implementation: ["coder"],
        quality: [],
        utility: [],
      },
      model_routing: { opus: ["architect"], sonnet: ["coder"], haiku: [] },
      delegation_graph: { architect: ["coder"] },
    });

    const agentTemplates = new Map<string, AgentTemplate>([
      ["architect", makeAgentTemplate("architect", "opus")],
      ["coder", makeAgentTemplate("coder", "sonnet")],
    ]);

    // No existing .agentforge directory — writeTeam should create it cleanly
    await writeTeam(projectDir, scannedManifest, agentTemplates, makeMinimalScanResult());

    const { readFile } = await import("node:fs/promises");
    const writtenContent = await readFile(
      join(projectDir, ".agentforge", "team.yaml"),
      "utf-8",
    );
    const written = yaml.load(writtenContent) as TeamManifest;

    expect(written.agents.strategic).toContain("architect");
    expect(written.agents.implementation).toContain("coder");
  });
});
