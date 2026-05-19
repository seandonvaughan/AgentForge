import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

import { applyDiff } from "../../packages/core/src/team/engine/reforge/index.js";
import type { TeamDiff } from "../../packages/core/src/team/engine/reforge/index.js";
import type { TeamManifest } from "../../packages/core/src/team/engine/types/team.js";

function makeManifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    name: "canary-team",
    forged_at: "2026-05-19T00:00:00.000Z",
    forged_by: "agentforge",
    project_hash: "hash-123",
    agents: {
      strategic: ["architect"],
      implementation: ["coder"],
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: ["architect"],
      sonnet: ["coder"],
      haiku: [],
    },
    delegation_graph: {
      architect: ["coder"],
    },
    ...overrides,
  };
}

function makeDiff(): TeamDiff {
  return {
    agents_added: ["coder"],
    agents_removed: [],
    agents_modified: [],
    model_changes: [],
    skill_updates: [],
    summary: "refresh team",
  };
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "agentforge-canary-"));
  await mkdir(join(projectRoot, ".agentforge", "analysis"), { recursive: true });
  await mkdir(join(projectRoot, ".agentforge", "config"), { recursive: true });
  await mkdir(join(projectRoot, ".agentforge", "agents"), { recursive: true });

  await writeFile(
    join(projectRoot, ".agentforge", "team.yaml"),
    yaml.dump(
      makeManifest({
        name: "legacy-team",
        project_hash: "old-hash",
        agents: {
          strategic: ["architect"],
          implementation: ["legacy-coder"],
          quality: [],
          utility: [],
        },
        model_routing: {
          opus: ["architect"],
          sonnet: ["legacy-coder"],
          haiku: [],
        },
        delegation_graph: {
          architect: ["legacy-coder"],
        },
      }),
      { lineWidth: 120, noRefs: true },
    ),
    "utf-8",
  );
  await writeFile(join(projectRoot, ".agentforge", "forge.log"), "old forge log\n", "utf-8");
  await writeFile(
    join(projectRoot, ".agentforge", "analysis", "project-scan.json"),
    JSON.stringify({ version: 1 }, null, 2),
    "utf-8",
  );
  await writeFile(join(projectRoot, ".agentforge", "config", "models.yaml"), "old models\n", "utf-8");
  await writeFile(join(projectRoot, ".agentforge", "agents", "legacy-coder.yaml"), "legacy agent\n", "utf-8");
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("applyDiff canary rollout", () => {
  it("restores the previous .agentforge state when canary validation fails", async () => {
    const stagedForge = async (root: string): Promise<TeamManifest> => {
      await writeFile(join(root, ".agentforge", "team.yaml"), yaml.dump(makeManifest()), "utf-8");
      await writeFile(join(root, ".agentforge", "forge.log"), "new forge log\n", "utf-8");
      await writeFile(
        join(root, ".agentforge", "analysis", "project-scan.json"),
        JSON.stringify({ version: 2 }, null, 2),
        "utf-8",
      );
      await writeFile(join(root, ".agentforge", "config", "models.yaml"), "new models\n", "utf-8");
      await writeFile(join(root, ".agentforge", "agents", "coder.yaml"), "new agent\n", "utf-8");
      return makeManifest();
    };

    await expect(
      applyDiff(projectRoot, makeDiff(), {
        canary: true,
        validate: async () => false,
        forgeTeam: stagedForge,
      }),
    ).rejects.toThrow(/Canary validation failed/);

    const restoredTeam = yaml.load(
      await readFile(join(projectRoot, ".agentforge", "team.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(restoredTeam.name).toBe("legacy-team");
    expect(await readFile(join(projectRoot, ".agentforge", "forge.log"), "utf-8")).toBe("old forge log\n");
    expect(JSON.parse(await readFile(join(projectRoot, ".agentforge", "analysis", "project-scan.json"), "utf-8"))).toEqual({ version: 1 });
    expect(await readFile(join(projectRoot, ".agentforge", "config", "models.yaml"), "utf-8")).toBe("old models\n");
    await expect(readFile(join(projectRoot, ".agentforge", "agents", "coder.yaml"), "utf-8")).rejects.toThrow();

    const rollout = JSON.parse(
      await readFile(join(projectRoot, ".agentforge", "forge", "canary-rollout.json"), "utf-8"),
    ) as { status: string; reason?: string };
    expect(rollout.status).toBe("rolled_back");
    expect(rollout.reason).toMatch(/Canary validation failed/);
  });

  it("promotes the new .agentforge state when canary validation passes", async () => {
    const stagedForge = async (root: string): Promise<TeamManifest> => {
      await writeFile(join(root, ".agentforge", "team.yaml"), yaml.dump(makeManifest()), "utf-8");
      await writeFile(join(root, ".agentforge", "forge.log"), "new forge log\n", "utf-8");
      return makeManifest();
    };

    await applyDiff(projectRoot, makeDiff(), {
      canary: true,
      trafficPercent: 25,
      rollbackThreshold: 0.1,
      validate: async (manifest) => manifest.name === "canary-team",
      forgeTeam: stagedForge,
    });

    const team = yaml.load(
      await readFile(join(projectRoot, ".agentforge", "team.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(team.name).toBe("canary-team");
    expect(await readFile(join(projectRoot, ".agentforge", "forge.log"), "utf-8")).toBe("new forge log\n");

    const rollout = JSON.parse(
      await readFile(join(projectRoot, ".agentforge", "forge", "canary-rollout.json"), "utf-8"),
    ) as { status: string; trafficPercent: number; rollbackThreshold: number };
    expect(rollout.status).toBe("promoted");
    expect(rollout.trafficPercent).toBe(25);
    expect(rollout.rollbackThreshold).toBe(0.1);
  });
});
