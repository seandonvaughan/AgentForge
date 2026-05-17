/**
 * Tests for the memory-reader module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMemoryEntries } from "../memory-reader.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-reader-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeMemoryFile(type: string, lines: string[]): void {
  const dir = join(projectRoot, ".agentforge", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${type}.jsonl`), lines.join("\n"), "utf8");
}

function makeEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `entry-${Math.random().toString(36).slice(2)}`,
    type: "gate-verdict",
    value: "Always validate schemas before processing.",
    createdAt: new Date().toISOString(),
    tags: ["review"],
    ...overrides,
  });
}

describe("readMemoryEntries", () => {
  it("returns empty array when the memory directory does not exist", async () => {
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries).toEqual([]);
  });

  it("returns empty array when the file does not exist", async () => {
    mkdirSync(join(projectRoot, ".agentforge", "memory"), { recursive: true });
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries).toEqual([]);
  });

  it("parses a valid JSONL file and returns entries", async () => {
    writeMemoryFile("gate-verdict", [
      makeEntry({ id: "e1", createdAt: "2026-05-17T10:00:00Z" }),
      makeEntry({ id: "e2", createdAt: "2026-05-16T10:00:00Z" }),
    ]);
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toContain("e1");
  });

  it("skips malformed (invalid JSON) lines and returns the rest", async () => {
    writeMemoryFile("gate-verdict", [
      makeEntry({ id: "good1" }),
      "{not valid json",
      makeEntry({ id: "good2" }),
    ]);
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).not.toContain(undefined);
  });

  it("skips entries missing required fields (id or value)", async () => {
    writeMemoryFile("gate-verdict", [
      JSON.stringify({ type: "gate-verdict", value: "ok" }), // missing id
      makeEntry({ id: "valid" }),
    ]);
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("valid");
  });

  it("returns entries sorted most-recent-first", async () => {
    writeMemoryFile("gate-verdict", [
      makeEntry({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
      makeEntry({ id: "new", createdAt: "2026-05-17T00:00:00Z" }),
      makeEntry({ id: "mid", createdAt: "2026-03-01T00:00:00Z" }),
    ]);
    const entries = await readMemoryEntries(projectRoot, "gate-verdict");
    expect(entries[0]!.id).toBe("new");
    expect(entries[2]!.id).toBe("old");
  });

  it("handles an empty file gracefully", async () => {
    writeMemoryFile("review-finding", [""]);
    const entries = await readMemoryEntries(projectRoot, "review-finding");
    expect(entries).toEqual([]);
  });
});
