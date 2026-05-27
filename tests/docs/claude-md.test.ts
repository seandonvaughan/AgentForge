/**
 * tests/docs/claude-md.test.ts
 *
 * Validates that CLAUDE.md exists, is non-empty, contains all required
 * sections, documents each of the 7 cumulative lessons, and does NOT
 * reference stale agent role names from pre-v22 teams.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLAUDE_MD_PATH = join(REPO_ROOT, "CLAUDE.md");
const README_MD_PATH = join(REPO_ROOT, "README.md");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const RUNTIME_TYPES_PATH = join(REPO_ROOT, "packages", "core", "src", "runtime", "types.ts");

let content = "";
let readmeContent = "";
let packageVersion = "";
let nodeEngine = "";
let runtimeModes: string[] = [];

const AUTO_PROVIDER_ORDER = [
  "Anthropic SDK",
  "Claude Code compatibility",
  "Codex CLI",
  "OpenAI SDK",
];

function expectProviderOrder(text: string) {
  let previousIndex = -1;

  for (const provider of AUTO_PROVIDER_ORDER) {
    const index = text.indexOf(provider);
    expect(index, `${provider} should be documented`).toBeGreaterThanOrEqual(0);
    expect(index, `${provider} should appear in fallback order`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

beforeAll(async () => {
  const [claudeMd, readmeMd, packageJson, runtimeTypes] = await Promise.all([
    readFile(CLAUDE_MD_PATH, "utf-8"),
    readFile(README_MD_PATH, "utf-8"),
    readFile(PACKAGE_JSON_PATH, "utf-8"),
    readFile(RUNTIME_TYPES_PATH, "utf-8"),
  ]);

  content = claudeMd;
  readmeContent = readmeMd;
  const packageManifest = JSON.parse(packageJson) as {
    version: string;
    engines: { node: string };
  };
  packageVersion = packageManifest.version;
  nodeEngine = packageManifest.engines.node;
  const runtimeModeType = runtimeTypes.match(/export type RuntimeMode =([\s\S]*?);/);
  runtimeModes = runtimeModeType
    ? Array.from(runtimeModeType[1].matchAll(/^\s*\|\s+'([^']+)'/gm), (match) => match[1])
    : [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLAUDE.md", () => {
  // ── 1. File existence and non-emptiness ────────────────────────────────────

  it("exists at the repo root", () => {
    expect(existsSync(CLAUDE_MD_PATH)).toBe(true);
  });

  it("is non-empty (at least 1000 characters)", async () => {
    const info = await stat(CLAUDE_MD_PATH);
    expect(info.size).toBeGreaterThan(1000);
  });

  // ── 2. Required sections ───────────────────────────────────────────────────

  it("contains a '## Current team' section", () => {
    expect(content).toMatch(/^## Current team/m);
  });

  it("contains a '## Forge pipeline' section", () => {
    expect(content).toMatch(/^## Forge pipeline/m);
  });

  it("contains a '## Running a forge' section", () => {
    expect(content).toMatch(/^## Running a forge/m);
  });

  it("contains a '## Running a cycle' section", () => {
    expect(content).toMatch(/^## Running a cycle/m);
  });

  it("contains a '## Memory and learning loop' section", () => {
    expect(content).toMatch(/^## Memory and learning loop/m);
  });

  it("contains a '## Concurrent agents' section", () => {
    expect(content).toMatch(/^## Concurrent agents/m);
  });

  it("contains a '## Lessons' section", () => {
    expect(content).toMatch(/^## Lessons/m);
  });

  // ── 3. Key features mentioned ──────────────────────────────────────────────

  it("documents the agentforge demo --project command", () => {
    expect(content).toMatch(/agentforge demo --project/);
  });

  it("documents AGENTFORGE_FORGE_STRATEGY env var", () => {
    expect(content).toMatch(/AGENTFORGE_FORGE_STRATEGY/);
  });

  it("documents AGENTFORGE_RUNTIME env var", () => {
    expect(content).toMatch(/AGENTFORGE_RUNTIME/);
  });

  it("documents the --legacy flag", () => {
    expect(content).toMatch(/--legacy/);
  });

  it("documents MAX_PARALLEL_AGENTS", () => {
    expect(content).toMatch(/MAX_PARALLEL_AGENTS/);
  });

  it("documents the 4-phase forge pipeline (Recon, Synthesis, Validation, Routing)", () => {
    expect(content).toMatch(/[Rr]econ/);
    expect(content).toMatch(/[Ss]ynthesis/);
    expect(content).toMatch(/[Vv]alidat/);
    expect(content).toMatch(/[Rr]outing/);
  });

  it("mentions the 4-bucket team structure (strategic/implementation/quality/utility)", () => {
    expect(content).toMatch(/[Ss]trategic/);
    expect(content).toMatch(/[Ii]mplementation/);
    expect(content).toMatch(/[Qq]uality/);
    expect(content).toMatch(/[Uu]tility/);
  });

  // ── 4. Seven cumulative lessons ────────────────────────────────────────────

  it("lesson 1: feature-dev is read-only / use general-purpose subagent", () => {
    expect(content).toMatch(/feature-dev/i);
  });

  it("lesson 2: share types stub in parallel dispatch", () => {
    // Should mention shared types or types stub in context of parallel agents
    expect(content).toMatch(/shared.{0,30}types|types stub/i);
  });

  it("lesson 3: js-yaml.dump for YAML serialization", () => {
    expect(content).toMatch(/js-yaml/);
    expect(content).toMatch(/dump\(\)/);
  });

  it("lesson 4: execFile not exec", () => {
    expect(content).toMatch(/execFile/);
  });

  it("lesson 5: no +-prefixed test files in SvelteKit src/routes/", () => {
    expect(content).toMatch(/src\/routes/);
  });

  it("lesson 6: String.includes for user-controlled input matching (ReDoS)", () => {
    expect(content).toMatch(/String\.includes\(\)|ReDoS/);
  });

  it("lesson 7: do not assert existsSync on gitignored paths", () => {
    expect(content).toMatch(/existsSync|gitignored/);
  });

  // ── 5. No stale role references ────────────────────────────────────────────

  it("does not reference stale 'vp-research' agent role", () => {
    expect(content).not.toMatch(/vp-research/);
  });

  it("does not reference stale 'engineering-manager' agent role", () => {
    expect(content).not.toMatch(/engineering-manager/);
  });

  it("does not reference stale 'ml-engineer' agent role", () => {
    expect(content).not.toMatch(/ml-engineer/);
  });

  it("does not reference stale 'lead-architect' agent role", () => {
    expect(content).not.toMatch(/lead-architect/);
  });

  it("documents the current MCP package path", () => {
    expect(content).toContain("packages/mcp-server");
    expect(content).not.toContain("packages/mcp/");
  });

  it("uses Corepack-managed pnpm in development commands", () => {
    expect(content).not.toMatch(/^pnpm\s/m);
    expect(content).not.toMatch(/^npx\s/m);
  });

  it("documents the current Node engine", () => {
    expect(content).toContain(`Node.js \`${nodeEngine}\``);
  });
});

describe("README.md", () => {
  it("documents the current package version", () => {
    expect(readmeContent).toContain(`version \`${packageVersion}\``);
  });

  it("documents the current MCP package path", () => {
    expect(readmeContent).toContain("packages/mcp-server");
    expect(readmeContent).not.toContain("packages/mcp`");
    expect(readmeContent).not.toContain("packages/mcp/");
  });

  it("documents each runtime mode from the package runtime contract", () => {
    for (const mode of runtimeModes) {
      expect(readmeContent).toContain(mode);
      expect(content).toContain(mode);
    }
  });

  it("documents the README auto-mode provider fallback order", () => {
    expectProviderOrder(readmeContent);
  });

  it("documents the CLAUDE.md auto-mode provider fallback order", () => {
    const autoRuntimeRowMatch = content.match(/^\|\s*`auto`\s*\|([^\n]+)\|/m);
    expect(autoRuntimeRowMatch).not.toBeNull();

    const autoRuntimeRow = autoRuntimeRowMatch?.[1] ?? "";
    expectProviderOrder(autoRuntimeRow);
  });

  it("uses Corepack-managed pnpm in development commands", () => {
    expect(readmeContent).not.toMatch(/^pnpm\s/m);
    expect(readmeContent).not.toMatch(/^npx\s/m);
  });

  it("documents the current Node engine", () => {
    expect(readmeContent).toContain(`Node.js \`${nodeEngine}\``);
  });
});
