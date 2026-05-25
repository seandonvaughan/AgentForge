import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNTIME_TYPES_PATH = join(REPO_ROOT, "packages", "core", "src", "runtime", "types.ts");
const RUNTIME_MODES_DOC_PATH = join(REPO_ROOT, "docs", "runtime-modes.md");

let runtimeModes: string[] = [];
let docsContent = "";

beforeAll(async () => {
  const [runtimeTypes, runtimeModesDoc] = await Promise.all([
    readFile(RUNTIME_TYPES_PATH, "utf-8"),
    readFile(RUNTIME_MODES_DOC_PATH, "utf-8"),
  ]);

  docsContent = runtimeModesDoc;
  const runtimeModeType = runtimeTypes.match(/export type RuntimeMode =([\s\S]*?);/);
  expect(runtimeModeType).not.toBeNull();

  runtimeModes = runtimeModeType
    ? Array.from(runtimeModeType[1].matchAll(/^\s*\|\s+'([^']+)'/gm), (match) => match[1])
    : [];
  expect(runtimeModes.length).toBeGreaterThan(0);
});

describe("docs/runtime-modes.md", () => {
  it("keeps the resolveMode() sample union aligned with RuntimeMode", () => {
    const match = docsContent.match(/const mode = resolveMode\(\);\s*\/\/\s*([^\r\n]+)/);
    expect(match).not.toBeNull();

    const documentedUnion = match?.[1]?.trim() ?? "";
    const expectedUnion = runtimeModes.map((mode) => `'${mode}'`).join(" | ");

    expect(documentedUnion).toBe(expectedUnion);
  });
});