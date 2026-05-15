/**
 * fresh-context tests — verify runtime memory injection behaviour at agent
 * invocation: role-affinity filtering, recency window, missing-memory degrade,
 * and the end-to-end injectFreshContext helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildFreshContextBlock,
  injectFreshContext,
  injectFreshContextFromRoot,
} from "../../packages/core/src/agent-runtime/fresh-context.js";

interface SeedEntry {
  value: string;
  type?: string;
  tags?: string[];
  ageDays?: number;
}

async function seedMemory(projectRoot: string, entries: SeedEntry[]) {
  const memDir = join(projectRoot, ".agentforge", "memory");
  await mkdir(memDir, { recursive: true });
  const byType = new Map<string, string[]>();
  for (const e of entries) {
    const type = e.type ?? "review-finding";
    const ageDays = e.ageDays ?? 1;
    const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    const line = JSON.stringify({
      id: `id-${Math.random().toString(36).slice(2, 8)}`,
      type,
      value: e.value,
      createdAt,
      source: "test",
      tags: e.tags ?? [],
    });
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(line);
  }
  for (const [type, lines] of byType) {
    await writeFile(join(memDir, `${type}.jsonl`), lines.join("\n") + "\n");
  }
}

describe("fresh-context", () => {
  let tempRoot: string;
  let agentforgeDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentforge-fresh-"));
    agentforgeDir = join(tempRoot, ".agentforge");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // buildFreshContextBlock
  // -------------------------------------------------------------------------

  describe("buildFreshContextBlock", () => {
    it("returns empty string when no memory dir exists", () => {
      expect(buildFreshContextBlock("coder", agentforgeDir)).toBe("");
    });

    it("returns empty string when no entries match the agent's role tags", async () => {
      await seedMemory(tempRoot, [
        { value: "dashboard fix", tags: ["dashboard"], ageDays: 1 },
      ]);
      // 'coder' doesn't have 'dashboard' in its runtime affinity list
      const block = buildFreshContextBlock("coder", agentforgeDir);
      expect(block).toBe("");
    });

    it("includes role-matched recent entries as bullets", async () => {
      await seedMemory(tempRoot, [
        {
          value: "[CRITICAL] gate verdict mis-tagged",
          tags: ["gate", "verdict", "critical"],
          type: "gate-verdict",
          ageDays: 1,
        },
        {
          value: "[MAJOR] another finding",
          tags: ["review", "finding", "major"],
          type: "review-finding",
          ageDays: 2,
        },
      ]);
      const block = buildFreshContextBlock("team-reviewer", agentforgeDir);
      expect(block).toContain("## Fresh Context");
      expect(block).toContain("mis-tagged");
      expect(block).toContain("another finding");
    });

    it("excludes entries older than the recency window", async () => {
      await seedMemory(tempRoot, [
        {
          value: "ancient critical",
          tags: ["review", "finding", "critical"],
          ageDays: 365,
        },
      ]);
      const block = buildFreshContextBlock("team-reviewer", agentforgeDir, {
        windowDays: 30,
      });
      expect(block).toBe("");
    });

    it("caps the bullet count at maxEntries", async () => {
      const seeds = Array.from({ length: 10 }, (_, i) => ({
        value: `[CRITICAL] entry ${i}`,
        tags: ["review", "finding", "critical"],
        ageDays: 1 + i * 0.1,
      }));
      await seedMemory(tempRoot, seeds);
      const block = buildFreshContextBlock("team-reviewer", agentforgeDir, {
        maxEntries: 3,
      });
      const bulletCount = (block.match(/^- /gm) ?? []).length;
      expect(bulletCount).toBe(3);
    });

    it("ranks CRITICAL above MAJOR within the same recency", async () => {
      await seedMemory(tempRoot, [
        { value: "[MAJOR] medium", tags: ["review", "major"], ageDays: 1 },
        { value: "[CRITICAL] big", tags: ["review", "critical"], ageDays: 1 },
      ]);
      const block = buildFreshContextBlock("team-reviewer", agentforgeDir, {
        maxEntries: 2,
      });
      const lines = block.split("\n").filter((l) => l.startsWith("- "));
      expect(lines[0]).toContain("[CRITICAL]");
      expect(lines[1]).toContain("[MAJOR]");
    });
  });

  // -------------------------------------------------------------------------
  // injectFreshContext / injectFreshContextFromRoot
  // -------------------------------------------------------------------------

  describe("injectFreshContext", () => {
    it("returns the prompt unchanged when no memory exists", () => {
      const original = "You are X.";
      expect(injectFreshContext(original, "coder", agentforgeDir)).toBe(original);
    });

    it("appends the fresh-context block when entries match", async () => {
      await seedMemory(tempRoot, [
        {
          value: "[CRITICAL] gotcha",
          tags: ["review", "finding", "critical"],
          ageDays: 1,
        },
      ]);
      const out = injectFreshContext("You are reviewer.", "team-reviewer", agentforgeDir);
      expect(out).toMatch(/^You are reviewer\./);
      expect(out).toContain("## Fresh Context");
      expect(out).toContain("gotcha");
    });

    it("injectFreshContextFromRoot resolves .agentforge/ via projectRoot", async () => {
      await seedMemory(tempRoot, [
        {
          value: "[CRITICAL] gotcha",
          tags: ["review", "finding", "critical"],
          ageDays: 1,
        },
      ]);
      const out = injectFreshContextFromRoot(
        "You are reviewer.",
        "team-reviewer",
        tempRoot
      );
      expect(out).toContain("gotcha");
    });
  });
});
