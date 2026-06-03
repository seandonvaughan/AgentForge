import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSourceCorpus } from "../source-corpus.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-source-corpus-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeFixture(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("buildSourceCorpus", () => {
  it("prioritizes load-bearing files, caps each subsystem, and truncates large files", async () => {
    writeFixture("packages/server/package.json", JSON.stringify({ name: "server" }));
    writeFixture("packages/server/src/large.ts", "x".repeat(600));
    for (let i = 1; i <= 5; i++) {
      writeFixture(`packages/server/src/file-${i}.ts`, `export const value${i} = ${i};\n`);
    }

    const result = await buildSourceCorpus({
      projectRoot,
      maxChars: 100_000,
      maxFileChars: 500,
    });

    const serverFiles = result.files.filter((f) => f.path.startsWith("packages/server/"));
    expect(serverFiles).toHaveLength(4);
    expect(serverFiles[0]?.path).toBe("packages/server/package.json");
    expect(result.skipped).toBeGreaterThanOrEqual(2);

    const largeFile = result.files.find((f) => f.path === "packages/server/src/large.ts");
    expect(largeFile).toBeDefined();
    expect(largeFile?.truncated).toBe(true);
    expect(largeFile?.content).toContain("... [truncated");
    expect(result.totalChars).toBeLessThanOrEqual(100_000);
  });

  it("keeps the selected corpus within the total character budget", async () => {
    writeFixture("packages/api/package.json", JSON.stringify({ name: "api" }));
    writeFixture("packages/api/src/one.ts", "a".repeat(300));
    writeFixture("packages/api/src/two.ts", "b".repeat(300));

    const result = await buildSourceCorpus({
      projectRoot,
      maxChars: 350,
      maxFileChars: 500,
    });

    expect(result.totalChars).toBeLessThanOrEqual(350);
    expect(result.skipped).toBeGreaterThan(0);
  });
});
