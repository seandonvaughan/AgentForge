import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeIngester, type CodeSymbol, type KnowledgeIndex } from "../../src/memory/knowledge-ingester.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempProject(): Promise<string> {
  const root = join(tmpdir(), `agentforge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

async function writeTs(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(root, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KnowledgeIngester", () => {
  let root: string;
  let ingester: KnowledgeIngester;

  beforeEach(async () => {
    root = await makeTempProject();
    ingester = new KnowledgeIngester(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("ingest — symbol discovery", () => {
    it("finds exported classes in src/", async () => {
      await writeTs(root, "src/agents/agent.ts", `
export class AgentRunner {
  run() {}
}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "AgentRunner");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("class");
    });

    it("finds exported interfaces", async () => {
      await writeTs(root, "src/types.ts", `
export interface AgentConfig {
  name: string;
}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "AgentConfig");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("interface");
    });

    it("finds exported functions", async () => {
      await writeTs(root, "src/utils.ts", `
export function createAgent(name: string) {
  return { name };
}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "createAgent");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("function");
    });

    it("finds exported type aliases", async () => {
      await writeTs(root, "src/types.ts", `
export type AgentId = string;
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "AgentId");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("type");
    });

    it("finds exported consts", async () => {
      await writeTs(root, "src/constants.ts", `
export const DEFAULT_TIER = 1;
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "DEFAULT_TIER");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("const");
    });

    it("records correct line numbers (1-indexed)", async () => {
      await writeTs(root, "src/agent.ts", `
// blank line 1
// blank line 2
export class MyAgent {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "MyAgent");
      expect(sym).toBeDefined();
      expect(sym!.line).toBe(4);
    });

    it("records exportedFrom as path relative to project root without .ts extension", async () => {
      await writeTs(root, "src/flywheel/engine.ts", `
export class Engine {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "Engine");
      expect(sym).toBeDefined();
      expect(sym!.exportedFrom).toBe("src/flywheel/engine");
    });

    it("walks nested subdirectories", async () => {
      await writeTs(root, "src/a/b/c/deep.ts", `
export class DeepClass {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "DeepClass");
      expect(sym).toBeDefined();
    });

    it("handles files with no exports — returns empty symbols for that file", async () => {
      await writeTs(root, "src/noop.ts", `
// This file has no exports
const x = 1;
`);
      const index = await ingester.ingest();
      const fromNoop = index.symbols.filter((s) => s.exportedFrom === "src/noop");
      expect(fromNoop).toHaveLength(0);
    });

    it("handles an empty src directory gracefully", async () => {
      const index = await ingester.ingest();
      expect(index.symbols).toHaveLength(0);
      expect(index.projectRoot).toBe(root);
      expect(index.generatedAt).toBeTruthy();
    });

    it("handles multiple exports in one file", async () => {
      await writeTs(root, "src/multi.ts", `
export class Alpha {}
export interface Beta {}
export function gamma() {}
`);
      const index = await ingester.ingest();
      const names = index.symbols.map((s) => s.name);
      expect(names).toContain("Alpha");
      expect(names).toContain("Beta");
      expect(names).toContain("gamma");
    });
  });

  describe("ingest — JSDoc extraction", () => {
    it("extracts JSDoc description from a single-line comment block", async () => {
      await writeTs(root, "src/agent.ts", `
/** Runs agent tasks in sequence. */
export class SequentialRunner {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "SequentialRunner");
      expect(sym?.description).toContain("Runs agent tasks in sequence");
    });

    it("extracts multi-line JSDoc and joins lines", async () => {
      await writeTs(root, "src/agent.ts", `
/**
 * Orchestrates multiple agents.
 * Uses parallel dispatch.
 */
export class Orchestrator {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "Orchestrator");
      expect(sym?.description).toContain("Orchestrates multiple agents");
      expect(sym?.description).toContain("Uses parallel dispatch");
    });

    it("leaves description undefined when no JSDoc comment precedes export", async () => {
      await writeTs(root, "src/agent.ts", `
// Regular comment — not JSDoc
export class PlainAgent {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "PlainAgent");
      expect(sym?.description).toBeUndefined();
    });

    it("extracts JSDoc even with blank lines between comment and export", async () => {
      await writeTs(root, "src/agent.ts", `
/** Has a blank line below. */

export class SpacedAgent {}
`);
      const index = await ingester.ingest();
      const sym = index.symbols.find((s) => s.name === "SpacedAgent");
      expect(sym?.description).toContain("Has a blank line below");
    });
  });

  describe("save and load", () => {
    it("save writes a JSON file and load reads it back", async () => {
      await writeTs(root, "src/thing.ts", `
/** A thing. */
export class Thing {}
`);
      const index = await ingester.ingest();
      const outputPath = join(root, ".agentforge", "knowledge", "codebase-index.json");
      await ingester.save(index, outputPath);

      const loaded = await KnowledgeIngester.load(outputPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.projectRoot).toBe(root);
      expect(loaded!.symbols).toHaveLength(index.symbols.length);
    });

    it("load/save round-trip preserves all symbol fields", async () => {
      await writeTs(root, "src/thing.ts", `
/** Describes Thing. */
export class Thing {}
`);
      const index = await ingester.ingest();
      const outputPath = join(root, ".agentforge", "knowledge", "codebase-index.json");
      await ingester.save(index, outputPath);

      const loaded = await KnowledgeIngester.load(outputPath);
      const original = index.symbols[0];
      const restored = loaded!.symbols[0];

      expect(restored.name).toBe(original.name);
      expect(restored.kind).toBe(original.kind);
      expect(restored.filePath).toBe(original.filePath);
      expect(restored.exportedFrom).toBe(original.exportedFrom);
      expect(restored.description).toBe(original.description);
      expect(restored.line).toBe(original.line);
    });

    it("load returns null when file does not exist", async () => {
      const result = await KnowledgeIngester.load(join(root, "does-not-exist.json"));
      expect(result).toBeNull();
    });

    it("save creates parent directories if they do not exist", async () => {
      await writeTs(root, "src/x.ts", `export const X = 1;`);
      const index = await ingester.ingest();
      const outputPath = join(root, "deep", "nested", "dir", "index.json");
      await expect(ingester.save(index, outputPath)).resolves.not.toThrow();
      const loaded = await KnowledgeIngester.load(outputPath);
      expect(loaded).not.toBeNull();
    });
  });

  describe("real codebase smoke test", () => {
    it("ingests AgentForge src/ and finds known exports", async () => {
      const realIngester = new KnowledgeIngester("/Users/seandonvaughan/Projects/AgentForge");
      const index = await realIngester.ingest();
      expect(index.symbols.length).toBeGreaterThan(10);
      const names = index.symbols.map((s) => s.name);
      // MetaLearningEngine is a well-known export
      expect(names).toContain("MetaLearningEngine");
      // KnowledgeIngester itself should be found
      expect(names).toContain("KnowledgeIngester");
    });
  });
});
