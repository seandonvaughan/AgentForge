import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../../src/genesis/discovery.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory and return its path.
 * Tests are responsible for cleaning up via the returned cleanup function.
 */
async function makeTmpDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "agentforge-discovery-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discover", () => {
  describe("empty directory", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns state 'empty' for a directory with no relevant files", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("empty");
    });

    it("returns an empty signals array for an empty directory", async () => {
      const result = await discover(dir);
      expect(result.signals).not.toContain("codebase_present");
      expect(result.signals).not.toContain("documents_present");
    });
  });

  describe("directory with source files (.ts)", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "index.ts"), "export const x = 1;");
      await writeFile(join(dir, "src", "utils.ts"), "export const y = 2;");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns state 'codebase' when only .ts files are present", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("codebase");
    });

    it("includes 'codebase_present' signal", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("codebase_present");
    });

    it("does not include 'documents_present' signal", async () => {
      const result = await discover(dir);
      expect(result.signals).not.toContain("documents_present");
    });
  });

  describe("directory with Python source files", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await writeFile(join(dir, "main.py"), "print('hello')");
      await writeFile(join(dir, "utils.py"), "def helper(): pass");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns state 'codebase' for .py files", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("codebase");
    });

    it("includes 'codebase_present' signal for .py files", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("codebase_present");
    });
  });

  describe("directory with .md documents only", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "docs", "business-plan.md"), "# Business Plan\n\nContent here.");
      await writeFile(join(dir, "docs", "strategy.md"), "# Strategy\n\nMore content.");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns state 'documents' when only .md files are present", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("documents");
    });

    it("includes 'documents_present' signal", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("documents_present");
    });

    it("does not include 'codebase_present' signal", async () => {
      const result = await discover(dir);
      expect(result.signals).not.toContain("codebase_present");
    });
  });

  describe("directory with both source files and documents", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "src", "app.ts"), "export const app = {};");
      await writeFile(join(dir, "docs", "prd.md"), "# PRD\n\nProduct requirements.");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns state 'full' when both source and doc files are present", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("full");
    });

    it("includes both 'codebase_present' and 'documents_present' signals", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("codebase_present");
      expect(result.signals).toContain("documents_present");
    });
  });

  describe("git repository detection", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      // Create a minimal .git directory to simulate a git repo
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, "src", "index.ts"), "export {};").catch(() => {
        // May fail if src doesn't exist yet; create it first
      });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "index.ts"), "export {};");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("includes 'git_repo' signal when .git directory is present", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("git_repo");
    });
  });

  describe("skips node_modules and .git during scan", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      // Put source files only inside node_modules (should be ignored)
      await mkdir(join(dir, "node_modules", "some-pkg"), { recursive: true });
      await writeFile(
        join(dir, "node_modules", "some-pkg", "index.ts"),
        "export const x = 1;",
      );
    });

    afterAll(async () => {
      await cleanup();
    });

    it("does not classify as 'codebase' when source files are only in node_modules", async () => {
      const result = await discover(dir);
      // node_modules should be skipped, so nothing should be detected
      expect(result.state).toBe("empty");
    });
  });

  describe("DiscoveryResult shape", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
    });

    afterAll(async () => {
      await cleanup();
    });

    it("always returns an object with state and signals fields", async () => {
      const result = await discover(dir);
      expect(result).toHaveProperty("state");
      expect(result).toHaveProperty("signals");
      expect(Array.isArray(result.signals)).toBe(true);
    });

    it("state is one of the four valid values", async () => {
      const result = await discover(dir);
      expect(["empty", "codebase", "documents", "full"]).toContain(result.state);
    });
  });

  describe("JavaScript source files", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await writeFile(join(dir, "index.js"), "module.exports = {};");
    });

    afterAll(async () => {
      await cleanup();
    });

    it("detects .js files as codebase", async () => {
      const result = await discover(dir);
      expect(result.state).toBe("codebase");
      expect(result.signals).toContain("codebase_present");
    });
  });

  describe("text documents", () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await makeTmpDir());
      await writeFile(join(dir, "requirements.txt"), "Python requirements file");
      // .txt should be classified as docs, not code
    });

    afterAll(async () => {
      await cleanup();
    });

    it("detects .txt files as documents", async () => {
      const result = await discover(dir);
      expect(result.signals).toContain("documents_present");
      expect(result.signals).not.toContain("codebase_present");
    });
  });
});
