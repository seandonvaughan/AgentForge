/**
 * Tests for tagSimilarity and findRelatedAgents (tag-similarity.ts).
 */

import { describe, it, expect } from "vitest";
import { tagSimilarity, findRelatedAgents } from "../tag-similarity.js";

// ---------------------------------------------------------------------------
// tagSimilarity
// ---------------------------------------------------------------------------

describe("tagSimilarity", () => {
  it("returns 0 when both arrays are empty (NaN-guarded)", () => {
    expect(tagSimilarity([], [])).toBe(0);
  });

  it("returns 0 when one array is empty", () => {
    expect(tagSimilarity(["react", "typescript"], [])).toBe(0);
    expect(tagSimilarity([], ["react", "typescript"])).toBe(0);
  });

  it("returns 1.0 for identical tag sets", () => {
    const tags = ["react", "typescript", "vitest"];
    expect(tagSimilarity(tags, tags)).toBe(1.0);
  });

  it("returns 0 for fully disjoint tag sets", () => {
    expect(tagSimilarity(["react", "frontend"], ["postgres", "sql"])).toBe(0);
  });

  it("returns 0.5 for 50% overlap (within floating-point tolerance)", () => {
    // A = {react, typescript, frontend, vitest}
    // B = {react, typescript, postgres, sql}
    // intersection = {react, typescript} = 2
    // union = {react, typescript, frontend, vitest, postgres, sql} = 6
    // Jaccard = 2/6 ≈ 0.3333
    //
    // For exact 0.5: A = {a, b, c}, B = {b, c, d}  → 2/4 = 0.5
    const a = ["a", "b", "c"];
    const b = ["b", "c", "d"];
    expect(tagSimilarity(a, b)).toBeCloseTo(0.5, 10);
  });

  it("is case-insensitive", () => {
    expect(tagSimilarity(["React", "TypeScript"], ["react", "typescript"])).toBe(1.0);
    expect(tagSimilarity(["REACT"], ["react"])).toBe(1.0);
  });

  it("handles duplicate tags within one array (treated as set)", () => {
    // Duplicates within one side should not affect the Jaccard ratio
    // A = {react, react} → set {react}
    // B = {react} → set {react}
    // Jaccard = 1/1 = 1.0
    expect(tagSimilarity(["react", "react"], ["react"])).toBe(1.0);
  });

  it("computes a known partial overlap correctly", () => {
    // A = {react, typescript, fastify}  B = {react, typescript, postgres, sql}
    // intersection = 2, union = 5 → 0.4
    const a = ["react", "typescript", "fastify"];
    const b = ["react", "typescript", "postgres", "sql"];
    expect(tagSimilarity(a, b)).toBeCloseTo(2 / 5, 10);
  });
});

// ---------------------------------------------------------------------------
// findRelatedAgents
// ---------------------------------------------------------------------------

describe("findRelatedAgents", () => {
  const roster = [
    { id: "agent-a", capability_tags: ["react", "typescript", "vitest"] },
    { id: "agent-b", capability_tags: ["react", "typescript", "vitest"] }, // identical → 1.0
    { id: "agent-c", capability_tags: ["react", "typescript", "playwright"] }, // 2/4 = 0.5
    { id: "agent-d", capability_tags: ["postgres", "sql"] }, // 0/5 = 0
  ];

  it("excludes the source agent itself", () => {
    const related = findRelatedAgents("agent-a", roster, 0.7);
    expect(related).not.toContain("agent-a");
  });

  it("returns agent-b (similarity 1.0) with threshold 0.7", () => {
    const related = findRelatedAgents("agent-a", roster, 0.7);
    expect(related).toContain("agent-b");
  });

  it("excludes agent-c (similarity 0.5) below threshold 0.7", () => {
    const related = findRelatedAgents("agent-a", roster, 0.7);
    expect(related).not.toContain("agent-c");
  });

  it("excludes agent-d (similarity 0) with any positive threshold", () => {
    const related = findRelatedAgents("agent-a", roster, 0.7);
    expect(related).not.toContain("agent-d");
  });

  it("returns empty array when source agent is not in the roster", () => {
    expect(findRelatedAgents("unknown-agent", roster, 0.7)).toEqual([]);
  });

  it("respects a lower threshold (e.g. 0.4) and includes agent-c", () => {
    // 2/4 = 0.5 which is >= 0.4
    const related = findRelatedAgents("agent-a", roster, 0.4);
    expect(related).toContain("agent-c");
  });
});
