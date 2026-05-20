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

let content = "";

beforeAll(async () => {
  content = await readFile(CLAUDE_MD_PATH, "utf-8");
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
});
