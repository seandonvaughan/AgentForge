/**
 * Unit 4 — Ungameable acceptance tests for the Phase 1 durable-slot gate.
 *
 * Fixture: two lessons A and B with IDENTICAL severity, createdAt, and role
 * tags (so the baseline scorer treats them equally).
 *
 * Scenario 1: A has ≥3 approved/verifyPassed appearances, B has ≥3 rejected.
 *   → After curateLearnings: A is in durable slice (index < DURABLE_SLOTS=8)
 *     AND ranked above B.
 *
 * Scenario 2 (baseline cross-check): same memory fixture with NO attribution
 *   file → A and B keep baseline tie-ordering (neither must dominate the other
 *   due to outcome data).
 *
 * Scenario 3 (cold-start regression): no attribution file → the output order
 *   of non-attribution proposals must match the pre-Phase-1 baseline (sorted
 *   by score descending only).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { curateLearnings } from "../curator.js";
import { appendLessonAttributions } from "../../../../memory/lesson-attribution.js";
import { computeLessonId } from "../lesson-id.js";

// ---------------------------------------------------------------------------
// Shared lesson texts (identical scores when no attribution exists)
// ---------------------------------------------------------------------------

// Both lessons are MAJOR-tagged and use the same recent createdAt so they
// receive the exact same baseline score.  The only differentiator is the
// attribution data written in Scenario 1.
const LESSON_A_TEXT =
  "Use execFile instead of exec to avoid shell injection vulnerabilities.";
const LESSON_B_TEXT =
  "Always validate inputs at the API boundary before passing to downstream services.";

const LESSON_A_ID = computeLessonId(LESSON_A_TEXT);
const LESSON_B_ID = computeLessonId(LESSON_B_TEXT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-flip-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeAgentYaml(agentId: string, tags: string[]): void {
  const dir = join(projectRoot, ".agentforge", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agentId}.yaml`),
    `name: ${agentId}\ncapability_tags:\n${tags.map((t) => `  - ${t}`).join("\n")}\n`,
    "utf8",
  );
}

/** Write a memory JSONL file containing both lesson A and B entries.
 *  They are assigned the same severity tag and the same recent createdAt,
 *  ensuring identical baseline scores. */
function writeMemoryWithBothLessons(): void {
  const memDir = join(projectRoot, ".agentforge", "memory");
  mkdirSync(memDir, { recursive: true });

  const now = new Date().toISOString();
  const entries = [
    {
      id: "entry-A",
      type: "review-finding",
      value: `[MAJOR] ${LESSON_A_TEXT}`,
      tags: ["executor", "major"],
      createdAt: now,
    },
    {
      id: "entry-B",
      type: "review-finding",
      value: `[MAJOR] ${LESSON_B_TEXT}`,
      tags: ["executor", "major"],
      createdAt: now,
    },
  ];

  writeFileSync(
    join(memDir, "review-finding.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n"),
    "utf8",
  );
}

/** Append attribution rows so lesson A has ≥3 approved+verifyPassed entries
 *  and lesson B has ≥3 rejected entries, across distinct (cycle, item) pairs. */
function writeAttribution(): void {
  // Lesson A: 4 approved/verifyPassed cycles
  const passRows = [
    { cycleId: "c1", itemId: "i1", gateVerdict: "approved" as const, verifyPassed: true },
    { cycleId: "c2", itemId: "i1", gateVerdict: "approved" as const, verifyPassed: true },
    { cycleId: "c3", itemId: "i1", gateVerdict: "approved" as const, verifyPassed: true },
    { cycleId: "c4", itemId: "i1", gateVerdict: "approved" as const, verifyPassed: true },
  ].map((r) => ({
    ...r,
    agentId: "executor",
    lessonId: LESSON_A_ID,
    lessonText: LESSON_A_TEXT,
    scope: "cycle" as const,
  }));

  // Lesson B: 4 rejected cycles
  const failRows = [
    { cycleId: "c1", itemId: "i1", gateVerdict: "rejected" as const },
    { cycleId: "c2", itemId: "i1", gateVerdict: "rejected" as const },
    { cycleId: "c3", itemId: "i1", gateVerdict: "rejected" as const },
    { cycleId: "c4", itemId: "i1", gateVerdict: "rejected" as const },
  ].map((r) => ({
    ...r,
    agentId: "executor",
    lessonId: LESSON_B_ID,
    lessonText: LESSON_B_TEXT,
    scope: "cycle" as const,
  }));

  appendLessonAttributions(projectRoot, [...passRows, ...failRows]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DURABLE_SLOTS = 8;

describe("curator Phase 1 — durable-slot flip", () => {
  it("Scenario 1: A (approved) ranks above B (rejected) when attribution exists", async () => {
    writeAgentYaml("executor", ["executor"]);
    writeMemoryWithBothLessons();
    writeAttribution();

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["executor"],
    });

    const proposals = result.byAgent["executor"] ?? [];

    // Find lesson A and B by matching lesson text substrings
    const idxA = proposals.findIndex((p) =>
      p.lesson.toLowerCase().includes("execfile"),
    );
    const idxB = proposals.findIndex((p) =>
      p.lesson.toLowerCase().includes("validate inputs"),
    );

    expect(idxA).toBeGreaterThanOrEqual(0); // A must appear
    expect(idxB).toBeGreaterThanOrEqual(0); // B must appear

    // A must be in the durable slot range
    expect(idxA).toBeLessThan(DURABLE_SLOTS);

    // A must rank above B
    expect(idxA).toBeLessThan(idxB);
  });

  it("Scenario 1: A has outcomeConfidence > 0.6 and attributedAppearances >= 3", async () => {
    writeAgentYaml("executor", ["executor"]);
    writeMemoryWithBothLessons();
    writeAttribution();

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["executor"],
    });

    const proposals = result.byAgent["executor"] ?? [];
    const proposalA = proposals.find((p) =>
      p.lesson.toLowerCase().includes("execfile"),
    );

    expect(proposalA).toBeDefined();
    expect(proposalA!.outcomeConfidence).toBeGreaterThan(0.6);
    expect(proposalA!.attributedAppearances).toBeGreaterThanOrEqual(3);
  });

  it("Scenario 2 (baseline cross-check): without attribution file, A and B have no outcome fields", async () => {
    writeAgentYaml("executor", ["executor"]);
    writeMemoryWithBothLessons();
    // No attribution written

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["executor"],
    });

    const proposals = result.byAgent["executor"] ?? [];

    const proposalA = proposals.find((p) =>
      p.lesson.toLowerCase().includes("execfile"),
    );
    const proposalB = proposals.find((p) =>
      p.lesson.toLowerCase().includes("validate inputs"),
    );

    expect(proposalA).toBeDefined();
    expect(proposalB).toBeDefined();

    // Without attribution, no outcome fields should be set
    expect(proposalA!.outcomeConfidence).toBeUndefined();
    expect(proposalA!.attributedAppearances).toBeUndefined();
    expect(proposalB!.outcomeConfidence).toBeUndefined();
    expect(proposalB!.attributedAppearances).toBeUndefined();
  });

  it("Scenario 2: without attribution, A is not artificially promoted above B (tie-order only by score)", async () => {
    writeAgentYaml("executor", ["executor"]);
    writeMemoryWithBothLessons();
    // No attribution written

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["executor"],
    });

    const proposals = result.byAgent["executor"] ?? [];

    const idxA = proposals.findIndex((p) =>
      p.lesson.toLowerCase().includes("execfile"),
    );
    const idxB = proposals.findIndex((p) =>
      p.lesson.toLowerCase().includes("validate inputs"),
    );

    // Both must appear
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);

    // Their scores should be effectively equal (same severity, same recency, same role tag).
    // toBeCloseTo(x, 5) checks |a - b| < 0.5e-5, sufficient for same-input scores.
    const scoreA = proposals[idxA]!.score;
    const scoreB = proposals[idxB]!.score;
    expect(scoreA).toBeCloseTo(scoreB, 5);
    // The flip (idxA < idxB) should NOT happen because no attribution pushed A up.
    // We don't assert a specific order — just that neither is in the durable range
    // based on outcome data.
    // Neither should have outcome confidence set
    expect(proposals[idxA]!.outcomeConfidence).toBeUndefined();
    expect(proposals[idxB]!.outcomeConfidence).toBeUndefined();
  });

  it("Scenario 3 (cold-start regression): no attribution → proposals are sorted by score descending", async () => {
    writeAgentYaml("executor", ["executor"]);

    // Write 4 entries with distinct severities to create a meaningful ordering
    const memDir = join(projectRoot, ".agentforge", "memory");
    mkdirSync(memDir, { recursive: true });
    const now = new Date().toISOString();
    const entries = [
      {
        id: "e1",
        type: "review-finding",
        value: "[MINOR] Use String.includes for simple substring checks.",
        tags: ["executor", "minor"],
        createdAt: now,
      },
      {
        id: "e2",
        type: "review-finding",
        value: "[CRITICAL] Missing auth middleware on admin routes must be added immediately.",
        tags: ["executor", "critical"],
        createdAt: now,
      },
      {
        id: "e3",
        type: "review-finding",
        value: "[MAJOR] Always validate request schemas before processing pipeline stages.",
        tags: ["executor", "major"],
        createdAt: now,
      },
    ];
    writeFileSync(
      join(memDir, "review-finding.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n"),
      "utf8",
    );

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["executor"],
    });

    const proposals = result.byAgent["executor"] ?? [];
    expect(proposals.length).toBeGreaterThan(0);

    // Cold-start: no attribution → durable is empty → output is fallback-only → sorted by score desc
    for (let i = 1; i < proposals.length; i++) {
      expect(proposals[i - 1]!.score).toBeGreaterThanOrEqual(proposals[i]!.score);
    }

    // Verify no outcome fields are present
    for (const p of proposals) {
      expect(p.outcomeConfidence).toBeUndefined();
      expect(p.attributedAppearances).toBeUndefined();
    }

    // CRITICAL should be first (highest baseline score = recency × 1.0 × roleBoost)
    expect(proposals[0]!.severity).toBe("CRITICAL");
  });
});
