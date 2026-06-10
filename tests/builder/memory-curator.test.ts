/**
 * memory-curator tests — verify memory loading, agent-role affinity scoring,
 * and the bullet-block formatting that feeds the {baked_learnings} placeholder
 * in agent templates.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadMemoryEntries,
  curateLearnings,
  formatLearningsBlock,
  type MemoryEntry,
} from "../../packages/core/src/team/engine/builder/memory-curator.js";
import type { AgentTemplate } from "../../packages/core/src/team/engine/types/agent.js";

function makeAgent(name: string, extras: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    name,
    model: "sonnet",
    version: "1.0",
    description: "test agent",
    system_prompt: "",
    skills: extras.skills ?? [],
    triggers: {
      file_patterns: extras.triggers?.file_patterns ?? [],
      keywords: extras.triggers?.keywords ?? [],
    },
    collaboration: {
      reports_to: "ceo",
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 10, auto_include: [], project_specific: [] },
    ...extras,
  };
}

function makeEntry(
  partial: Partial<MemoryEntry> & { value: string }
): MemoryEntry {
  return {
    id: partial.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    type: partial.type ?? "review-finding",
    createdAt: partial.createdAt ?? new Date().toISOString(),
    source: partial.source ?? "test",
    tags: partial.tags ?? [],
    ...partial,
  };
}

describe("memory-curator", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentforge-memcurator-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // loadMemoryEntries
  // -------------------------------------------------------------------------

  describe("loadMemoryEntries", () => {
    it("returns empty array when memory dir does not exist", () => {
      expect(loadMemoryEntries(tempRoot)).toEqual([]);
    });

    it("reads every *.jsonl in the memory dir", async () => {
      const memDir = join(tempRoot, ".agentforge", "memory");
      await mkdir(memDir, { recursive: true });
      await writeFile(
        join(memDir, "review-finding.jsonl"),
        JSON.stringify(makeEntry({ value: "first" })) +
          "\n" +
          JSON.stringify(makeEntry({ value: "second" })) +
          "\n"
      );
      await writeFile(
        join(memDir, "gate-verdict.jsonl"),
        JSON.stringify(makeEntry({ value: "verdict", type: "gate-verdict" })) + "\n"
      );

      const entries = loadMemoryEntries(tempRoot);
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.value).sort()).toEqual(["first", "second", "verdict"]);
    });

    it("skips lines that fail to parse but keeps valid neighbours", async () => {
      const memDir = join(tempRoot, ".agentforge", "memory");
      await mkdir(memDir, { recursive: true });
      await writeFile(
        join(memDir, "partial.jsonl"),
        `${JSON.stringify(makeEntry({ value: "good" }))}\nthis-is-not-json\n${JSON.stringify(
          makeEntry({ value: "alsogood" })
        )}\n`
      );

      const entries = loadMemoryEntries(tempRoot);
      expect(entries.length).toBe(2);
    });

    it("ignores non-jsonl files in the memory dir", async () => {
      const memDir = join(tempRoot, ".agentforge", "memory");
      await mkdir(memDir, { recursive: true });
      await writeFile(join(memDir, "notes.md"), "# notes");
      await writeFile(
        join(memDir, "valid.jsonl"),
        JSON.stringify(makeEntry({ value: "v" })) + "\n"
      );

      const entries = loadMemoryEntries(tempRoot);
      expect(entries.length).toBe(1);
    });

    it("loads per-agent files under memory/agents/ and stamps agentId", async () => {
      const memDir = join(tempRoot, ".agentforge", "memory");
      const agentsDir = join(memDir, "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(memDir, "review-finding.jsonl"),
        JSON.stringify(makeEntry({ value: "shared lesson" })) + "\n"
      );
      await writeFile(
        join(agentsDir, "coder.jsonl"),
        JSON.stringify(makeEntry({ value: "coder lesson" })) + "\n"
      );
      await writeFile(
        join(agentsDir, "linter.jsonl"),
        JSON.stringify(makeEntry({ value: "linter lesson" })) + "\n"
      );

      const entries = loadMemoryEntries(tempRoot);
      expect(entries.length).toBe(3);

      const coderEntry = entries.find((e) => e.value === "coder lesson");
      expect(coderEntry?.agentId).toBe("coder");
      const linterEntry = entries.find((e) => e.value === "linter lesson");
      expect(linterEntry?.agentId).toBe("linter");
      const sharedEntry = entries.find((e) => e.value === "shared lesson");
      expect(sharedEntry?.agentId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // curateLearnings — relevance scoring
  // -------------------------------------------------------------------------

  describe("curateLearnings", () => {
    it("returns empty array when no entries provided", () => {
      const agent = makeAgent("CTO");
      expect(curateLearnings(agent, [])).toEqual([]);
    });

    it("filters out entries with no tag/severity/type score", () => {
      const agent = makeAgent("CTO");
      const entries = [
        makeEntry({ value: "neutral note", tags: ["unrelated"], type: "misc" }),
      ];
      expect(curateLearnings(agent, entries)).toEqual([]);
    });

    it("prefers entries with role-affinity tags", () => {
      const reviewer = makeAgent("team-reviewer");
      const entries = [
        makeEntry({
          value: "review lesson",
          tags: ["review", "finding", "critical"],
          createdAt: new Date().toISOString(),
        }),
        makeEntry({
          value: "unrelated",
          tags: ["dashboard"],
          createdAt: new Date().toISOString(),
        }),
      ];
      const lessons = curateLearnings(reviewer, entries, { maxLessons: 5 });
      expect(lessons[0]).toContain("review lesson");
    });

    it("boosts CRITICAL above MAJOR above neutral", () => {
      const agent = makeAgent("Coder");
      const entries = [
        makeEntry({
          value: "[MAJOR] medium issue",
          tags: ["fix"],
        }),
        makeEntry({
          value: "[CRITICAL] big issue",
          tags: ["fix"],
        }),
      ];
      const lessons = curateLearnings(agent, entries);
      expect(lessons[0]).toContain("CRITICAL");
      expect(lessons[1]).toContain("MAJOR");
    });

    it("decays old entries below recent ones with equal tag affinity", () => {
      const reviewer = makeAgent("team-reviewer");
      const now = Date.now();
      const ancient = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
      const fresh = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
      const entries = [
        makeEntry({
          value: "old review",
          tags: ["review", "finding"],
          createdAt: ancient,
        }),
        makeEntry({
          value: "new review",
          tags: ["review", "finding"],
          createdAt: fresh,
        }),
      ];
      const lessons = curateLearnings(reviewer, entries, { maxLessons: 2 });
      // Fresh first when scoring ties on tags but breaks on recency
      expect(lessons[0]).toContain("new review");
    });

    it("truncates long entries to maxLessonChars with ellipsis", () => {
      const agent = makeAgent("Coder");
      const long = "[CRITICAL] " + "x".repeat(500);
      const lessons = curateLearnings(
        agent,
        [makeEntry({ value: long, tags: ["fix"] })],
        { maxLessons: 1, maxLessonChars: 50 }
      );
      expect(lessons[0]?.length).toBeLessThanOrEqual(50);
      expect(lessons[0]?.endsWith("…")).toBe(true);
    });

    it("caps output at maxLessons", () => {
      const agent = makeAgent("Coder");
      const entries = Array.from({ length: 20 }, (_, i) =>
        makeEntry({
          value: `[MAJOR] entry ${i}`,
          tags: ["fix"],
        })
      );
      const lessons = curateLearnings(agent, entries, { maxLessons: 4 });
      expect(lessons.length).toBe(4);
    });

    it("defaults to the documented 8-lesson cap", () => {
      const agent = makeAgent("Coder");
      const entries = Array.from({ length: 20 }, (_, i) =>
        makeEntry({
          value: `[MAJOR] default cap entry ${i}`,
          tags: ["fix"],
        })
      );

      const lessons = curateLearnings(agent, entries);
      expect(lessons.length).toBe(8);
    });

    it("weights an agent's OWN per-agent entries above shared-pool affinity matches", () => {
      const coder = makeAgent("Coder");
      const entries = [
        makeEntry({
          value: "shared affinity lesson",
          tags: ["fix", "critical"],
        }),
        makeEntry({
          value: "coder's own lesson",
          tags: ["unrelated"],
          agentId: "coder",
        }),
      ];

      const lessons = curateLearnings(coder, entries, { maxLessons: 2 });
      expect(lessons[0]).toContain("coder's own lesson");
    });

    it("never leaks another agent's private entries", () => {
      const coder = makeAgent("Coder");
      const entries = [
        makeEntry({
          value: "linter private lesson",
          tags: ["fix", "critical"],
          agentId: "linter",
        }),
      ];

      expect(curateLearnings(coder, entries)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // formatLearningsBlock
  // -------------------------------------------------------------------------

  describe("formatLearningsBlock", () => {
    it("renders a friendly placeholder when no lessons exist", () => {
      const out = formatLearningsBlock([]);
      expect(out).toContain("no prior learnings");
    });

    it("renders bullets one per line for non-empty input", () => {
      const out = formatLearningsBlock(["one", "two", "three"]);
      expect(out).toBe("- one\n- two\n- three");
    });
  });
});
