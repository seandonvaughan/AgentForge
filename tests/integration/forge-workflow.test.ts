/**
 * Integration tests for the AgentForge forge workflow.
 *
 * Tests cover the end-to-end pipeline from project discovery through team
 * composition, domain activation, and manifest/file output.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { forgeTeam } from "../../src/builder/index.js";
import { discover } from "../../src/genesis/discovery.js";
import { loadAllDomains } from "../../src/domains/domain-loader.js";
import { activateDomains } from "../../src/domains/domain-activator.js";
import type { TeamManifest } from "../../src/types/team.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory prefixed for easy identification. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentforge-integration-"));
}

/** Check whether a path exists (resolves true/false, never throws). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Test 1 — Full forge workflow against a mock TypeScript project
// ---------------------------------------------------------------------------

describe("forge workflow — TypeScript project", () => {
  it("returns a valid TeamManifest and writes .agentforge/ to disk", async () => {
    // --- arrange ---
    const projectDir = await makeTmpDir();
    dirsToClean.push(projectDir);

    // package.json
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "my-ts-project",
          version: "1.0.0",
          dependencies: { typescript: "^5.0.0" },
          devDependencies: { vitest: "^3.0.0" },
        },
        null,
        2,
      ),
      "utf-8",
    );

    // tsconfig.json
    await writeFile(
      join(projectDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            outDir: "dist",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    // src/index.ts
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(
      join(projectDir, "src", "index.ts"),
      `export function hello(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
      "utf-8",
    );

    // --- act ---
    const manifest: TeamManifest = await forgeTeam(projectDir);

    // --- assert: manifest shape ---
    expect(manifest).toBeDefined();
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.forged_at).toBe("string");
    expect(typeof manifest.forged_by).toBe("string");
    expect(typeof manifest.project_hash).toBe("string");

    // agents field has the four required category arrays
    expect(manifest.agents).toBeDefined();
    expect(Array.isArray(manifest.agents.strategic)).toBe(true);
    expect(Array.isArray(manifest.agents.implementation)).toBe(true);
    expect(Array.isArray(manifest.agents.quality)).toBe(true);
    expect(Array.isArray(manifest.agents.utility)).toBe(true);

    // at least one agent must have been composed
    const totalAgents =
      manifest.agents.strategic.length +
      manifest.agents.implementation.length +
      manifest.agents.quality.length +
      manifest.agents.utility.length;
    expect(totalAgents).toBeGreaterThan(0);

    // --- assert: .agentforge/ directory exists ---
    const agentforgeDir = join(projectDir, ".agentforge");
    expect(await pathExists(agentforgeDir)).toBe(true);

    // --- assert: team.yaml exists and is valid YAML ---
    const teamYamlPath = join(agentforgeDir, "team.yaml");
    expect(await pathExists(teamYamlPath)).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const teamYamlContent = await readFile(teamYamlPath, "utf-8");
    expect(() => yaml.load(teamYamlContent)).not.toThrow();

    const parsedManifest = yaml.load(teamYamlContent) as Record<string, unknown>;
    expect(parsedManifest).toHaveProperty("name");
    expect(parsedManifest).toHaveProperty("agents");
    expect(parsedManifest).toHaveProperty("forged_at");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Domain activation: docs-only project activates core, not software
// ---------------------------------------------------------------------------

describe("domain activation — documents-only project", () => {
  it("discover() returns 'documents' state and activateDomains activates core but not software", async () => {
    // --- arrange ---
    const projectDir = await makeTmpDir();
    dirsToClean.push(projectDir);

    // Only a markdown business plan — no source code
    await writeFile(
      join(projectDir, "business-plan.md"),
      "# Business Plan\n\n## Vision\nBecome the market leader.\n",
      "utf-8",
    );

    // --- act: discover ---
    const discoveryResult = await discover(projectDir);

    // --- assert: discovery state ---
    expect(discoveryResult.state).toBe("documents");
    expect(discoveryResult.signals).toContain("documents_present");
    expect(discoveryResult.signals).not.toContain("codebase_present");

    // --- act: load real domain packs from templates/domains/ and activate ---
    // Resolve path to templates/domains/ relative to this file's location.
    // This file lives at tests/integration/, so go up two levels.
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const thisFile = fileURLToPath(import.meta.url);
    const domainsDir = resolve(dirname(thisFile), "..", "..", "templates", "domains");

    const domainPacks = await loadAllDomains(domainsDir);
    expect(domainPacks.size).toBeGreaterThan(0);
    expect(domainPacks.has("core")).toBe(true);
    expect(domainPacks.has("software")).toBe(true);

    // We need a scan result to pass to activateDomains.
    // Simulate what the file scanner would see for a docs-only project:
    // one .md file, no .ts/.py/.js files, no package.json.
    const { runFullScan } = await import("../../src/scanner/index.js");
    const scanResult = await runFullScan(projectDir);

    const activeDomainIds = activateDomains(scanResult, domainPacks);

    // --- assert: 'core' is always activated ---
    expect(activeDomainIds).toContain("core");

    // --- assert: 'software' is NOT activated (no source files) ---
    expect(activeDomainIds).not.toContain("software");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Multi-domain project: package.json + business-plan.md → 'full'
// ---------------------------------------------------------------------------

describe("multi-domain project — code + documents", () => {
  it("discover() returns 'full' when both package.json and a .md doc are present", async () => {
    // --- arrange ---
    const projectDir = await makeTmpDir();
    dirsToClean.push(projectDir);

    // TypeScript source file so the project has codebase signal
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(
      join(projectDir, "src", "main.ts"),
      "export const version = '1.0.0';\n",
      "utf-8",
    );

    // package.json so the dependency scanner also has something to work with
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "full-project", version: "0.1.0" }, null, 2),
      "utf-8",
    );

    // Markdown document (non-README) to trigger the docs signal
    await writeFile(
      join(projectDir, "business-plan.md"),
      "# Business Plan\n\nStrategic overview.\n",
      "utf-8",
    );

    // --- act ---
    const discoveryResult = await discover(projectDir);

    // --- assert ---
    expect(discoveryResult.state).toBe("full");
    expect(discoveryResult.signals).toContain("codebase_present");
    expect(discoveryResult.signals).toContain("documents_present");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Empty project: discover() returns 'empty'
// ---------------------------------------------------------------------------

describe("empty project", () => {
  it("discover() returns state 'empty' for a bare directory with no files", async () => {
    // --- arrange ---
    const projectDir = await makeTmpDir();
    dirsToClean.push(projectDir);

    // --- act ---
    const discoveryResult = await discover(projectDir);

    // --- assert ---
    expect(discoveryResult.state).toBe("empty");
    expect(discoveryResult.signals).not.toContain("codebase_present");
    expect(discoveryResult.signals).not.toContain("documents_present");
  });
});
