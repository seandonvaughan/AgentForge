import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { makeAtomicTempPath, writeFileAtomic } from "../atomic-write.js";

describe("core writeFileAtomic", () => {
  it("creates the temporary path beside the destination", () => {
    const target = join("C:", "workspace", ".agentforge", "team.yaml");
    const tempPath = makeAtomicTempPath(target);

    expect(dirname(tempPath)).toBe(dirname(target));
    expect(basename(tempPath)).toContain("team.yaml");
  });

  it("writes the final file without leaving sibling temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentforge-atomic-core-"));
    try {
      const dir = join(root, ".agentforge");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "team.yaml");

      await writeFileAtomic(target, "name: AgentForge\n");

      await expect(readFile(target, "utf-8")).resolves.toBe("name: AgentForge\n");
      const siblings = await readdir(dir);
      expect(siblings.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
