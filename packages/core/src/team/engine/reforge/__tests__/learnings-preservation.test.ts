/**
 * v25 — reforge preserves per-agent learnings.
 *
 * applyDiff re-runs the full forge, which rewrites every agent YAML. The
 * learnings each agent accumulated across cycles must survive that rewrite:
 * read before, merge with the freshly curated set after, dedupe by value,
 * cap at 8.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

import { readAgentLearnings, restoreAgentLearnings } from "../index.js";

let agentsDir: string;
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agentforge-reforge-learn-"));
  agentsDir = join(tempRoot, ".agentforge", "agents");
  await mkdir(agentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeAgent(
  id: string,
  learnings: string[] | undefined,
): Promise<void> {
  const doc: Record<string, unknown> = {
    name: id,
    model: "sonnet",
    version: "1.0",
    description: `${id} agent`,
    system_prompt: `You are ${id}.`,
    ...(learnings ? { learnings } : {}),
  };
  await writeFile(join(agentsDir, `${id}.yaml`), yaml.dump(doc));
}

async function readLearningsOf(id: string): Promise<string[] | undefined> {
  const parsed = yaml.load(
    await readFile(join(agentsDir, `${id}.yaml`), "utf-8"),
  ) as { learnings?: string[] };
  return parsed.learnings;
}

describe("readAgentLearnings", () => {
  it("returns the learnings of every agent YAML keyed by agent id", async () => {
    await writeAgent("coder", ["lesson a", "lesson b"]);
    await writeAgent("linter", ["lint lesson"]);
    await writeAgent("file-reader", undefined);

    const preserved = await readAgentLearnings(agentsDir);

    expect(preserved.get("coder")).toEqual(["lesson a", "lesson b"]);
    expect(preserved.get("linter")).toEqual(["lint lesson"]);
    expect(preserved.has("file-reader")).toBe(false);
  });

  it("returns an empty map when the agents dir does not exist", async () => {
    const preserved = await readAgentLearnings(join(tempRoot, "nope"));
    expect(preserved.size).toBe(0);
  });
});

describe("restoreAgentLearnings", () => {
  it("merges preserved learnings with fresh ones, preserved first", async () => {
    // Simulated post-forge state: fresh learnings only
    await writeAgent("coder", ["fresh lesson"]);

    const preserved = new Map([["coder", ["old lesson one", "old lesson two"]]]);
    await restoreAgentLearnings(agentsDir, preserved);

    expect(await readLearningsOf("coder")).toEqual([
      "old lesson one",
      "old lesson two",
      "fresh lesson",
    ]);
  });

  it("dedupes by exact value", async () => {
    await writeAgent("coder", ["shared lesson", "fresh lesson"]);

    const preserved = new Map([["coder", ["shared lesson", "old lesson"]]]);
    await restoreAgentLearnings(agentsDir, preserved);

    expect(await readLearningsOf("coder")).toEqual([
      "shared lesson",
      "old lesson",
      "fresh lesson",
    ]);
  });

  it("caps the merged list at 8", async () => {
    const fresh = Array.from({ length: 6 }, (_, i) => `fresh ${i}`);
    await writeAgent("coder", fresh);

    const old = Array.from({ length: 6 }, (_, i) => `old ${i}`);
    const preserved = new Map([["coder", old]]);
    await restoreAgentLearnings(agentsDir, preserved);

    const merged = await readLearningsOf("coder");
    expect(merged).toHaveLength(8);
    // Preserved-first ordering: all 6 old lessons survive, then 2 fresh
    expect(merged?.slice(0, 6)).toEqual(old);
    expect(merged?.slice(6)).toEqual(["fresh 0", "fresh 1"]);
  });

  it("skips agents removed by the reforge without throwing", async () => {
    const preserved = new Map([["ghost-agent", ["lost lesson"]]]);
    await expect(
      restoreAgentLearnings(agentsDir, preserved),
    ).resolves.toBeUndefined();
  });

  it("round-trips: read before rewrite, restore after", async () => {
    await writeAgent("coder", ["cycle-1 lesson"]);

    const preserved = await readAgentLearnings(agentsDir);

    // Simulate a forge rewrite that drops learnings entirely
    await writeAgent("coder", undefined);
    await restoreAgentLearnings(agentsDir, preserved);

    expect(await readLearningsOf("coder")).toEqual(["cycle-1 lesson"]);
  });
});
