/**
 * Tests for the reforge mutator gate (T2.2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import { applyLearnings, type MutatorReport, type ProposedLearning } from "../mutator.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_A = "architect";
const AGENT_B = "coder";
const AGENT_C = "reviewer";

function makeProposal(
  overrides: Partial<ProposedLearning> & { agentId: string; lesson: string; score: number },
): ProposedLearning {
  return {
    sourceId: "src-001",
    severity: "MAJOR",
    rationale: "role-tag",
    sourceCreatedAt: "2026-05-17T10:00:00.000Z",
    ...overrides,
  };
}

const AGENT_A_YAML = `
name: Architect
model: opus
description: Lead architect agent
system_prompt: >
  You are the architect.
skills:
  - system_design
  - api_design
triggers:
  keywords:
    - architecture
learnings:
  - "[MAJOR] Always write integration tests before merging."
  - "[CRITICAL] Never expose internal ports in docker-compose."
`.trim();

const AGENT_B_YAML = `
name: Coder
model: sonnet
description: Implementation agent
system_prompt: >
  You are the coder.
skills:
  - typescript
  - react
learnings: []
`.trim();

/** Agent C has no learnings key at all */
const AGENT_C_YAML = `
name: Reviewer
model: haiku
description: Code reviewer
system_prompt: >
  You are the reviewer.
skills:
  - code_review
`.trim();

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let agentsDir: string;
let forgeDir: string;

async function setup(): Promise<void> {
  tmpRoot = join(tmpdir(), `mutator-test-${randomBytes(6).toString("hex")}`);
  agentsDir = join(tmpRoot, ".agentforge", "agents");
  forgeDir = join(tmpRoot, ".agentforge", "forge");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(forgeDir, { recursive: true });

  // Write agent YAML fixtures
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(agentsDir, `${AGENT_A}.yaml`), AGENT_A_YAML, "utf8");
  await writeFile(join(agentsDir, `${AGENT_B}.yaml`), AGENT_B_YAML, "utf8");
  await writeFile(join(agentsDir, `${AGENT_C}.yaml`), AGENT_C_YAML, "utf8");
}

async function teardown(): Promise<void> {
  await rm(tmpRoot, { recursive: true, force: true });
}

async function writeProposed(byAgent: Record<string, ProposedLearning[]>): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(forgeDir, "learnings-proposed.json"), JSON.stringify(byAgent), "utf8");
}

async function readAgentYaml(agentId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(agentsDir, `${agentId}.yaml`), "utf8");
  return yaml.load(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyLearnings mutator", () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await teardown();
  });

  // -------------------------------------------------------------------------
  // T1: New lessons are added
  // -------------------------------------------------------------------------
  it("adds new lessons to an agent with existing learnings", async () => {
    const proposals: ProposedLearning[] = [
      makeProposal({
        agentId: AGENT_A,
        lesson: "Always validate YAML before writing to disk.",
        score: 0.9,
      }),
    ];
    await writeProposed({ [AGENT_A]: proposals });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const entry = report.perAgent.find((p) => p.agentId === AGENT_A)!;
    expect(entry.added).toContain("Always validate YAML before writing to disk.");
    expect(entry.added.length).toBe(1);
    expect(entry.before).toBe(2); // had 2 existing
    expect(entry.after).toBe(3);
  });

  // -------------------------------------------------------------------------
  // T2: New lessons written to YAML file
  // -------------------------------------------------------------------------
  it("writes added lessons back to the agent YAML file", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "Always run tests first before pushing.",
          score: 0.85,
        }),
      ],
    });

    await applyLearnings({ projectRoot: tmpRoot });

    const data = await readAgentYaml(AGENT_B);
    const learnings = data["learnings"] as string[];
    expect(learnings).toContain("Always run tests first before pushing.");
  });

  // -------------------------------------------------------------------------
  // T3: Exact duplicates are skipped
  // -------------------------------------------------------------------------
  it("drops proposals that are exact duplicates of existing lessons", async () => {
    await writeProposed({
      [AGENT_A]: [
        makeProposal({
          agentId: AGENT_A,
          lesson: "[MAJOR] Always write integration tests before merging.",
          score: 0.9,
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const entry = report.perAgent.find((p) => p.agentId === AGENT_A)!;
    expect(entry.deduped).toBe(1);
    expect(entry.added).toHaveLength(0);
    expect(entry.before).toBe(2);
    expect(entry.after).toBe(2);
  });

  // -------------------------------------------------------------------------
  // T4: Near-duplicate (punctuation/case difference) is deduped
  // -------------------------------------------------------------------------
  it("deduplicates near-identical lessons (case + punctuation differences)", async () => {
    // First, add a clean lesson without any severity prefix
    const { writeFile } = await import("node:fs/promises");
    const freshYaml = `
name: Architect
model: opus
system_prompt: You are the architect.
learnings:
  - "Always validate YAML schemas before writing to disk."
`.trim();
    await writeFile(join(agentsDir, `${AGENT_A}.yaml`), freshYaml, "utf8");

    // Propose an all-caps + extra punctuation variant of the same lesson
    await writeProposed({
      [AGENT_A]: [
        makeProposal({
          agentId: AGENT_A,
          lesson: "ALWAYS VALIDATE YAML SCHEMAS BEFORE WRITING TO DISK!!!",
          score: 0.7,
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });
    const entry = report.perAgent.find((p) => p.agentId === AGENT_A)!;
    expect(entry.deduped).toBe(1);
    expect(entry.added).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T5: Contradicting lessons — lower-scored one is dropped
  // -------------------------------------------------------------------------
  it("drops the lower-scored entry when two proposals contradict each other", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "always run tests first",
          score: 0.9,
          sourceCreatedAt: "2026-05-17T08:00:00.000Z",
        }),
        makeProposal({
          agentId: AGENT_B,
          lesson: "never run tests first",
          score: 0.3,
          sourceCreatedAt: "2026-05-17T09:00:00.000Z",
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const entry = report.perAgent.find((p) => p.agentId === AGENT_B)!;
    expect(entry.contradicted).toBe(1);
    // Only the high-score one survives
    expect(entry.added).toContain("always run tests first");
    expect(entry.added).not.toContain("never run tests first");
  });

  // -------------------------------------------------------------------------
  // T6: Cap at 12 lessons
  // -------------------------------------------------------------------------
  it("caps the total lesson count at 12 and reports how many were dropped", async () => {
    // Agent A has 2 existing. Feed 15 new ones.
    const proposals: ProposedLearning[] = Array.from({ length: 15 }, (_, i) =>
      makeProposal({
        agentId: AGENT_A,
        lesson: `Unique lesson number ${i + 1} to fill the cap`,
        score: 0.5 + i * 0.01,
        sourceCreatedAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    await writeProposed({ [AGENT_A]: proposals });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const entry = report.perAgent.find((p) => p.agentId === AGENT_A)!;
    expect(entry.after).toBe(12);
    // 2 existing + 15 new = 17 total; 17 - 12 = 5 capped
    expect(entry.capped).toBe(5);
  });

  // -------------------------------------------------------------------------
  // T7: dryRun=true does not write any file changes
  // -------------------------------------------------------------------------
  it("dryRun=true returns the full report without writing file changes", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "always use strict TypeScript settings",
          score: 0.8,
        }),
      ],
    });

    // Read the original YAML content
    const before = await readFile(join(agentsDir, `${AGENT_B}.yaml`), "utf8");

    const report = await applyLearnings({ projectRoot: tmpRoot, dryRun: true });

    // File should be unchanged
    const after = await readFile(join(agentsDir, `${AGENT_B}.yaml`), "utf8");
    expect(after).toBe(before);

    // Report should still show the addition
    const entry = report.perAgent.find((p) => p.agentId === AGENT_B)!;
    expect(entry.added).toContain("always use strict TypeScript settings");
    expect(report.dryRun).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T8: dryRun=true does not write mutator-report.json
  // -------------------------------------------------------------------------
  it("dryRun=true does not write mutator-report.json", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "always use strict TypeScript settings",
          score: 0.8,
        }),
      ],
    });

    await applyLearnings({ projectRoot: tmpRoot, dryRun: true });

    await expect(readFile(join(forgeDir, "mutator-report.json"), "utf8")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // T9: mutator-report.json is written on normal (non-dry) run
  // -------------------------------------------------------------------------
  it("writes mutator-report.json to .agentforge/forge/ on a normal run", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "always check types before committing",
          score: 0.75,
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const json = await readFile(join(forgeDir, "mutator-report.json"), "utf8");
    const written: MutatorReport = JSON.parse(json);
    expect(written.dryRun).toBe(false);
    expect(written.perAgent[0]?.agentId).toBe(AGENT_B);
    expect(written.generatedAt).toBe(report.generatedAt);
  });

  // -------------------------------------------------------------------------
  // T10: YAML round-trip preserves all other fields
  // -------------------------------------------------------------------------
  it("preserves system_prompt, skills, and triggers after mutating learnings", async () => {
    await writeProposed({
      [AGENT_A]: [
        makeProposal({
          agentId: AGENT_A,
          lesson: "Always document API changes in CHANGELOG.md.",
          score: 0.8,
        }),
      ],
    });

    await applyLearnings({ projectRoot: tmpRoot });

    const data = await readAgentYaml(AGENT_A);
    expect(data["name"]).toBe("Architect");
    expect(data["model"]).toBe("opus");
    expect(data["system_prompt"]).toContain("You are the architect");
    const skills = data["skills"] as string[];
    expect(skills).toContain("system_design");
    expect(skills).toContain("api_design");
    const triggers = data["triggers"] as { keywords: string[] };
    expect(triggers.keywords).toContain("architecture");
  });

  // -------------------------------------------------------------------------
  // T11: Agent with missing learnings key is handled gracefully
  // -------------------------------------------------------------------------
  it("handles agents that have no learnings key in YAML (adds new ones)", async () => {
    await writeProposed({
      [AGENT_C]: [
        makeProposal({
          agentId: AGENT_C,
          lesson: "Always leave inline comments on complex logic.",
          score: 0.7,
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });

    const entry = report.perAgent.find((p) => p.agentId === AGENT_C)!;
    expect(entry.before).toBe(0);
    expect(entry.after).toBe(1);
    expect(entry.added).toHaveLength(1);

    const data = await readAgentYaml(AGENT_C);
    const learnings = data["learnings"] as string[];
    expect(learnings).toContain("Always leave inline comments on complex logic.");
  });

  // -------------------------------------------------------------------------
  // T12: Within-batch duplicates are deduped
  // -------------------------------------------------------------------------
  it("deduplicates proposals that are duplicates of each other within the same batch", async () => {
    await writeProposed({
      [AGENT_B]: [
        makeProposal({
          agentId: AGENT_B,
          lesson: "always lint before committing code to the repo",
          score: 0.9,
          sourceCreatedAt: "2026-05-17T08:00:00.000Z",
        }),
        makeProposal({
          agentId: AGENT_B,
          // Same normalised content
          lesson: "ALWAYS lint before committing code to the repo!!!",
          score: 0.7,
          sourceCreatedAt: "2026-05-17T09:00:00.000Z",
        }),
      ],
    });

    const report = await applyLearnings({ projectRoot: tmpRoot });
    const entry = report.perAgent.find((p) => p.agentId === AGENT_B)!;

    // One deduped, one added
    expect(entry.deduped).toBe(1);
    expect(entry.added).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // T13: Missing learnings-proposed.json throws descriptive error
  // -------------------------------------------------------------------------
  it("throws a descriptive error when learnings-proposed.json is missing", async () => {
    // Do NOT write a proposed.json
    await expect(applyLearnings({ projectRoot: tmpRoot })).rejects.toThrow(
      "learnings-proposed.json not found",
    );
  });
});
