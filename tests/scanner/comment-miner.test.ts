import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mineComments } from "../../src/scanner/comment-miner.js";
import type { CommentNote } from "../../src/scanner/comment-miner.js";

describe("comment-miner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-comment-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("mineComments", () => {
    it("finds TODO comments with file path and line number", async () => {
      await writeFile(
        join(tempDir, "app.ts"),
        [
          "const x = 1;",
          "// TODO: refactor this to use a factory pattern",
          "function doSomething() {}",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].text).toContain("refactor this to use a factory pattern");
      expect(result.todos[0].file).toBe("app.ts");
      expect(result.todos[0].line).toBe(2);
      expect(result.todos[0].type).toBe("TODO");
    });

    it("finds FIXME comments", async () => {
      await writeFile(
        join(tempDir, "utils.ts"),
        [
          "// FIXME: this crashes on null input",
          "export function parse(val: unknown) {",
          "  return val as string;",
          "}",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].text).toContain("crashes on null input");
      expect(result.todos[0].file).toBe("utils.ts");
      expect(result.todos[0].line).toBe(1);
      expect(result.todos[0].type).toBe("FIXME");
    });

    it("finds HACK comments and classifies them as todos", async () => {
      await writeFile(
        join(tempDir, "workaround.ts"),
        [
          "function foo() {",
          "  // HACK: temporary workaround for upstream bug",
          "  return 42;",
          "}",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].text).toContain("temporary workaround for upstream bug");
      expect(result.todos[0].type).toBe("HACK");
    });

    it("finds multiple TODO/FIXME/HACK comments across multiple files", async () => {
      await writeFile(
        join(tempDir, "a.ts"),
        "// TODO: first thing\n// FIXME: second thing\n"
      );
      await writeFile(
        join(tempDir, "b.py"),
        "# TODO: python todo\n"
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(3);
    });

    it("finds architecture decision comments (ADR patterns — Decision:)", async () => {
      await writeFile(
        join(tempDir, "service.ts"),
        [
          "// Decision: use Redis for session storage",
          "// Rationale: Redis provides sub-millisecond latency for hot paths",
          "import { createClient } from 'redis';",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.decisions).toHaveLength(2);

      const decisionTexts = result.decisions.map((d) => d.text);
      expect(decisionTexts.some((t) => t.includes("use Redis for session storage"))).toBe(true);
      expect(decisionTexts.some((t) => t.includes("Redis provides sub-millisecond latency"))).toBe(true);
    });

    it("classifies Decision: comments as decisions with correct type", async () => {
      await writeFile(
        join(tempDir, "arch.ts"),
        "// Decision: adopt event sourcing\n"
      );

      const result = await mineComments(tempDir);

      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].type).toBe("DECISION");
      expect(result.decisions[0].file).toBe("arch.ts");
      expect(result.decisions[0].line).toBe(1);
    });

    it("classifies Rationale: comments as decisions", async () => {
      await writeFile(
        join(tempDir, "design.ts"),
        "// Rationale: simplifies the deployment pipeline\n"
      );

      const result = await mineComments(tempDir);

      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].type).toBe("RATIONALE");
    });

    it("finds NOTE comments", async () => {
      await writeFile(
        join(tempDir, "loader.ts"),
        [
          "// NOTE: this function is called on every request",
          "export function loadConfig() {}",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].text).toContain("called on every request");
      expect(result.notes[0].type).toBe("NOTE");
      expect(result.notes[0].file).toBe("loader.ts");
      expect(result.notes[0].line).toBe(1);
    });

    it("skips node_modules directory", async () => {
      await mkdir(join(tempDir, "node_modules", "some-pkg"), { recursive: true });
      await writeFile(
        join(tempDir, "node_modules", "some-pkg", "index.ts"),
        "// TODO: this should be ignored\n"
      );
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(0);
    });

    it("skips .git directory", async () => {
      await mkdir(join(tempDir, ".git", "hooks"), { recursive: true });
      await writeFile(
        join(tempDir, ".git", "hooks", "pre-commit"),
        "# TODO: should not appear\n"
      );
      await writeFile(join(tempDir, "main.ts"), "const y = 2;\n");

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(0);
    });

    it("skips dist directory", async () => {
      await mkdir(join(tempDir, "dist"), { recursive: true });
      await writeFile(
        join(tempDir, "dist", "bundle.js"),
        "// TODO: should not appear\n"
      );
      await writeFile(join(tempDir, "src.ts"), "const z = 3;\n");

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(0);
    });

    it("returns the correct shape { todos, decisions, notes }", async () => {
      const result = await mineComments(tempDir);

      expect(result).toHaveProperty("todos");
      expect(result).toHaveProperty("decisions");
      expect(result).toHaveProperty("notes");
      expect(Array.isArray(result.todos)).toBe(true);
      expect(Array.isArray(result.decisions)).toBe(true);
      expect(Array.isArray(result.notes)).toBe(true);
    });

    it("returns an empty result for a directory with no comments", async () => {
      await writeFile(join(tempDir, "clean.ts"), "export const value = 42;\n");

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(0);
      expect(result.decisions).toHaveLength(0);
      expect(result.notes).toHaveLength(0);
    });

    it("returns an empty result for an empty directory", async () => {
      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(0);
      expect(result.decisions).toHaveLength(0);
      expect(result.notes).toHaveLength(0);
    });

    it("works with Python hash-style comments", async () => {
      await writeFile(
        join(tempDir, "script.py"),
        [
          "# TODO: add error handling",
          "def process():",
          "    pass",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].text).toContain("add error handling");
      expect(result.todos[0].file).toBe("script.py");
      expect(result.todos[0].line).toBe(1);
    });

    it("each CommentNote has text, file, line, and type fields", async () => {
      await writeFile(
        join(tempDir, "check.ts"),
        "// TODO: verify fields\n"
      );

      const result = await mineComments(tempDir);
      const note: CommentNote = result.todos[0];

      expect(typeof note.text).toBe("string");
      expect(typeof note.file).toBe("string");
      expect(typeof note.line).toBe("number");
      expect(typeof note.type).toBe("string");
    });

    it("records correct line numbers for comments deeper in the file", async () => {
      await writeFile(
        join(tempDir, "deep.ts"),
        [
          "const a = 1;",
          "const b = 2;",
          "const c = 3;",
          "// TODO: fix line 4 logic",
          "const d = 4;",
        ].join("\n")
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].line).toBe(4);
    });

    it("handles inline TODO comments (code on same line)", async () => {
      await writeFile(
        join(tempDir, "inline.ts"),
        "const val = compute(); // TODO: replace with lookup table\n"
      );

      const result = await mineComments(tempDir);

      expect(result.todos).toHaveLength(1);
      expect(result.todos[0].text).toContain("replace with lookup table");
    });
  });
});
