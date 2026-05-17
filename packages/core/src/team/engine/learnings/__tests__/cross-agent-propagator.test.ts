/**
 * Tests for propagateLearnings (cross-agent-propagator.ts).
 *
 * Fixture agents and their Jaccard similarities vs agent-a:
 *
 *   agent-a: [react, typescript, vitest, testing]          (source)
 *   agent-b: [react, typescript, vitest, playwright]       → 3/5 = 0.60  → BELOW 0.7
 *   agent-c: [react, typescript, vitest, testing, eslint]  → 4/5 = 0.80  → ABOVE 0.7
 *   agent-d: [react, typescript, vitest, testing]          → 4/4 = 1.00  → ABOVE 0.7 (identical)
 *   agent-e: [postgres, sql, migrations]                   → 0/7 = 0.00  → BELOW 0.7
 *
 * So only agent-c and agent-d should receive propagated learnings.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { propagateLearnings } from "../cross-agent-propagator.js";
import type { PropagationResult } from "../cross-agent-propagator.js";
import type { ProposedLearning } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-propagator-"));

  const agentsDir = join(projectRoot, ".agentforge", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Write agent YAML files using capability_tags
  const agents = [
    { id: "agent-a", capability_tags: ["react", "typescript", "vitest", "testing"] },
    { id: "agent-b", capability_tags: ["react", "typescript", "vitest", "playwright"] },
    { id: "agent-c", capability_tags: ["react", "typescript", "vitest", "testing", "eslint"] },
    { id: "agent-d", capability_tags: ["react", "typescript", "vitest", "testing"] },
    { id: "agent-e", capability_tags: ["postgres", "sql", "migrations"] },
  ];

  for (const agent of agents) {
    const yaml = [
      `name: ${agent.id}`,
      `id: ${agent.id}`,
      `model: sonnet`,
      `system_prompt: "You are ${agent.id}."`,
      `capability_tags:`,
      ...agent.capability_tags.map((t) => `  - ${t}`),
    ].join("\n");
    writeFileSync(join(agentsDir, `${agent.id}.yaml`), yaml);
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeLearning(
  override: Partial<ProposedLearning> & { agentId: string; lesson: string },
): ProposedLearning {
  return {
    score: 0.9,
    sourceId: "src-001",
    severity: "CRITICAL",
    rationale: "role-tag",
    sourceCreatedAt: "2026-05-17T00:00:00.000Z",
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("propagateLearnings — CRITICAL lesson propagation", () => {
  it("propagates a CRITICAL lesson to agent-c and agent-d (similarity ≥ 0.7)", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Always run vitest --coverage before merging.",
        }),
      ],
    };

    const result: PropagationResult = await propagateLearnings({
      projectRoot,
      proposed,
      threshold: 0.7,
    });

    expect(result.proposed["agent-c"]).toBeDefined();
    expect(result.proposed["agent-d"]).toBeDefined();
  });

  it("does NOT propagate to agent-b (similarity 3/5 = 0.60, below 0.7)", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Always run vitest --coverage before merging.",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    // agent-b should not have received any cross-agent learning
    const bLearnings = result.proposed["agent-b"] ?? [];
    const crossLearnings = bLearnings.filter((l) => l.rationale === "cross-agent");
    expect(crossLearnings).toHaveLength(0);
  });

  it("does NOT propagate to agent-e (similarity 0, fully disjoint tags)", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Always run vitest --coverage before merging.",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const eLearnings = result.proposed["agent-e"] ?? [];
    const crossLearnings = eLearnings.filter((l) => l.rationale === "cross-agent");
    expect(crossLearnings).toHaveLength(0);
  });
});

describe("propagateLearnings — severity filtering", () => {
  it("does NOT propagate MINOR lessons", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Prefer named exports for consistency.",
          severity: "MINOR",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const cLearnings = result.proposed["agent-c"] ?? [];
    expect(cLearnings.filter((l) => l.rationale === "cross-agent")).toHaveLength(0);
  });

  it("does NOT propagate INFO lessons", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "TypeScript strict mode is recommended.",
          severity: "INFO",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const dLearnings = result.proposed["agent-d"] ?? [];
    expect(dLearnings.filter((l) => l.rationale === "cross-agent")).toHaveLength(0);
  });

  it("propagates MAJOR lessons (alongside CRITICAL)", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Avoid importing from barrel files in test fixtures.",
          severity: "MAJOR",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const cLearnings = result.proposed["agent-c"] ?? [];
    expect(cLearnings.filter((l) => l.rationale === "cross-agent").length).toBeGreaterThan(0);
  });
});

describe("propagateLearnings — cross-agent prefix", () => {
  it("prefixes propagated lessons with '[cross-agent from <sourceId>] '", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Use react-testing-library over enzyme.",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const cCrossLearnings = (result.proposed["agent-c"] ?? []).filter(
      (l) => l.rationale === "cross-agent",
    );
    expect(cCrossLearnings).toHaveLength(1);
    expect(cCrossLearnings[0]!.lesson).toBe(
      "[cross-agent from agent-a] Use react-testing-library over enzyme.",
    );
  });

  it("sets rationale to 'cross-agent' on all propagated learnings", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({ agentId: "agent-a", lesson: "Always mock fs in unit tests." }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    for (const learnings of Object.values(result.proposed)) {
      for (const l of learnings) {
        if (l.lesson.startsWith("[cross-agent")) {
          expect(l.rationale).toBe("cross-agent");
        }
      }
    }
  });
});

describe("propagateLearnings — duplicate detection", () => {
  it("suppresses propagation when target already has the lesson at a higher score", async () => {
    const prefixedLesson = "[cross-agent from agent-a] Pin all test-runner versions in CI.";

    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({
          agentId: "agent-a",
          lesson: "Pin all test-runner versions in CI.",
          score: 0.9,
        }),
      ],
      // agent-d already has this lesson prefixed at a higher score
      "agent-d": [
        makeLearning({
          agentId: "agent-d",
          lesson: prefixedLesson,
          // score will exceed discountedScore = 0.9 * 1.0 * 0.7 = 0.63
          score: 0.99,
          rationale: "cross-agent",
        }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    // Should be exactly 1 — the pre-existing high-score entry; not a second copy
    const dCrossLearnings = (result.proposed["agent-d"] ?? []).filter(
      (l) => l.lesson === prefixedLesson,
    );
    expect(dCrossLearnings).toHaveLength(1);
    expect(result.propagationStats.duplicatesSuppressed).toBeGreaterThan(0);
  });
});

describe("propagateLearnings — stats", () => {
  it("reports correct pairsConsidered and crossAgentLearningsAdded", async () => {
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({ agentId: "agent-a", lesson: "Always prefer async readFile." }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    // agent-a has two related agents above 0.7: agent-c and agent-d
    expect(result.propagationStats.pairsConsidered).toBe(2);
    // 1 CRITICAL lesson × 2 related agents = 2 propagated
    expect(result.propagationStats.crossAgentLearningsAdded).toBe(2);
    expect(result.propagationStats.duplicatesSuppressed).toBe(0);
  });

  it("preserves original learnings unchanged in the merged output", async () => {
    const originalLesson = "Never import from dist/ in source files.";
    const proposed: Record<string, ProposedLearning[]> = {
      "agent-a": [
        makeLearning({ agentId: "agent-a", lesson: originalLesson }),
      ],
    };

    const result = await propagateLearnings({ projectRoot, proposed, threshold: 0.7 });

    const aOriginal = result.proposed["agent-a"] ?? [];
    expect(aOriginal.some((l) => l.lesson === originalLesson)).toBe(true);
  });
});
