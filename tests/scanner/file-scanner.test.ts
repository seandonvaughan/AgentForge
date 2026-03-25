import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanFiles, detectFrameworks } from "../../src/scanner/file-scanner.js";
import type { FileAnalysis } from "../../src/scanner/file-scanner.js";

describe("file-scanner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("scanFiles", () => {
    it("should scan a directory with TypeScript files", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await writeFile(
        join(tempDir, "src", "index.ts"),
        'import { foo } from "./foo.js";\nexport const bar = 1;\n'
      );
      await writeFile(
        join(tempDir, "src", "foo.ts"),
        "export function foo() { return 42; }\n"
      );

      const result = await scanFiles(tempDir);

      expect(result.total_files).toBe(2);
      expect(result.languages["TypeScript"]).toBe(2);
      expect(result.files).toHaveLength(2);
      expect(result.total_loc).toBeGreaterThan(0);
    });

    it("should detect multiple languages", async () => {
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");
      await writeFile(join(tempDir, "script.py"), "x = 1\n");
      await writeFile(join(tempDir, "main.go"), 'package main\n\nfunc main() {}\n');

      const result = await scanFiles(tempDir);

      expect(result.total_files).toBe(3);
      expect(result.languages["TypeScript"]).toBe(1);
      expect(result.languages["Python"]).toBe(1);
      expect(result.languages["Go"]).toBe(1);
    });

    it("should skip node_modules and .git directories", async () => {
      await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
      await writeFile(
        join(tempDir, "node_modules", "pkg", "index.js"),
        "module.exports = {};\n"
      );
      await mkdir(join(tempDir, ".git", "objects"), { recursive: true });
      await writeFile(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(tempDir, "app.ts"), "const a = 1;\n");

      const result = await scanFiles(tempDir);

      expect(result.total_files).toBe(1);
      expect(result.files[0].file_path).toBe("app.ts");
    });

    it("should handle an empty directory", async () => {
      const result = await scanFiles(tempDir);

      expect(result.total_files).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.total_loc).toBe(0);
      expect(result.frameworks_detected).toEqual([]);
    });

    it("should report top-level directory structure", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await mkdir(join(tempDir, "tests"), { recursive: true });
      await mkdir(join(tempDir, "lib"), { recursive: true });

      const result = await scanFiles(tempDir);

      expect(result.directory_structure).toContain("src");
      expect(result.directory_structure).toContain("tests");
      expect(result.directory_structure).toContain("lib");
    });

    it("should extract imports from TypeScript files", async () => {
      await writeFile(
        join(tempDir, "app.ts"),
        'import React from "react";\nimport { useState } from "react";\nconst x = require("express");\n'
      );

      const result = await scanFiles(tempDir);

      expect(result.files[0].imports).toContain("react");
      expect(result.files[0].imports).toContain("express");
    });

    it("should extract exports from TypeScript files", async () => {
      await writeFile(
        join(tempDir, "lib.ts"),
        "export const FOO = 1;\nexport function bar() {}\nexport default class Baz {}\n"
      );

      const result = await scanFiles(tempDir);

      expect(result.files[0].exports).toContain("FOO");
      expect(result.files[0].exports).toContain("bar");
      expect(result.files[0].exports).toContain("Baz");
    });

    it("should skip files with unknown extensions", async () => {
      await writeFile(join(tempDir, "data.bin"), "binary data");
      await writeFile(join(tempDir, "image.png"), "fake png");
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");

      const result = await scanFiles(tempDir);

      expect(result.total_files).toBe(1);
    });

    it("should detect common coding patterns", async () => {
      await writeFile(
        join(tempDir, "patterns.ts"),
        "async function load() {\n  const { x, y } = await fetch();\n  const z = x?.value ?? 'default';\n}\n"
      );

      const result = await scanFiles(tempDir);
      const patterns = result.files[0].patterns;

      expect(patterns).toContain("async/await");
      expect(patterns).toContain("destructuring");
      expect(patterns).toContain("optional chaining");
      expect(patterns).toContain("nullish coalescing");
    });
  });

  describe("detectFrameworks", () => {
    it("should detect React from imports", () => {
      const files: FileAnalysis[] = [
        {
          file_path: "src/App.tsx",
          language: "TypeScript",
          loc: 10,
          imports: ["react", "react-dom"],
          exports: ["App"],
          framework_indicators: ["React"],
          patterns: [],
        },
      ];

      const frameworks = detectFrameworks(files);
      expect(frameworks).toContain("React");
    });

    it("should detect Express from imports", () => {
      const files: FileAnalysis[] = [
        {
          file_path: "src/server.ts",
          language: "TypeScript",
          loc: 20,
          imports: ["express"],
          exports: ["app"],
          framework_indicators: ["Express"],
          patterns: [],
        },
      ];

      const frameworks = detectFrameworks(files);
      expect(frameworks).toContain("Express");
    });

    it("should detect frameworks from file patterns", () => {
      const files: FileAnalysis[] = [
        {
          file_path: "next.config.js",
          language: "JavaScript",
          loc: 5,
          imports: [],
          exports: [],
          framework_indicators: [],
          patterns: [],
        },
      ];

      const frameworks = detectFrameworks(files);
      expect(frameworks).toContain("Next.js");
    });

    it("should sort frameworks by frequency", () => {
      const files: FileAnalysis[] = [
        {
          file_path: "a.tsx",
          language: "TypeScript",
          loc: 5,
          imports: ["react"],
          exports: [],
          framework_indicators: ["React"],
          patterns: [],
        },
        {
          file_path: "b.tsx",
          language: "TypeScript",
          loc: 5,
          imports: ["react"],
          exports: [],
          framework_indicators: ["React"],
          patterns: [],
        },
        {
          file_path: "c.ts",
          language: "TypeScript",
          loc: 5,
          imports: ["express"],
          exports: [],
          framework_indicators: ["Express"],
          patterns: [],
        },
      ];

      const frameworks = detectFrameworks(files);
      expect(frameworks[0]).toBe("React");
    });

    it("should return empty array for no frameworks", () => {
      const files: FileAnalysis[] = [
        {
          file_path: "utils.ts",
          language: "TypeScript",
          loc: 5,
          imports: [],
          exports: [],
          framework_indicators: [],
          patterns: [],
        },
      ];

      const frameworks = detectFrameworks(files);
      expect(frameworks).toEqual([]);
    });
  });

  describe("language detection", () => {
    it("should detect TypeScript from .ts extension", async () => {
      await writeFile(join(tempDir, "file.ts"), "const x = 1;\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("TypeScript");
    });

    it("should detect Python from .py extension", async () => {
      await writeFile(join(tempDir, "file.py"), "x = 1\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("Python");
    });

    it("should detect Rust from .rs extension", async () => {
      await writeFile(join(tempDir, "main.rs"), "fn main() {}\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("Rust");
    });

    it("should detect Go from .go extension", async () => {
      await writeFile(join(tempDir, "main.go"), "package main\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("Go");
    });

    it("should detect JavaScript from .js extension", async () => {
      await writeFile(join(tempDir, "app.js"), "const x = 1;\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("JavaScript");
    });

    it("should detect Ruby from .rb extension", async () => {
      await writeFile(join(tempDir, "app.rb"), "puts 'hello'\n");
      const result = await scanFiles(tempDir);
      expect(result.files[0].language).toBe("Ruby");
    });
  });

  describe("framework detection from imports", () => {
    it("should detect Vue from .vue file", async () => {
      await writeFile(
        join(tempDir, "App.vue"),
        '<template><div>Hello</div></template>\n<script>\nimport { ref } from "vue";\n</script>\n'
      );

      const result = await scanFiles(tempDir);

      expect(result.frameworks_detected).toContain("Vue");
    });

    it("should detect Django from Python imports", async () => {
      await writeFile(
        join(tempDir, "views.py"),
        "from django.http import HttpResponse\n\ndef index(request):\n    return HttpResponse('Hello')\n"
      );

      const result = await scanFiles(tempDir);

      expect(result.frameworks_detected).toContain("Django");
    });
  });
});
