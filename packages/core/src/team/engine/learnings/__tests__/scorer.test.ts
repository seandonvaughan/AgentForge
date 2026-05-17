/**
 * Tests for the scorer module — recency decay, severity tiers, role match.
 */

import { describe, it, expect } from "vitest";
import { recencyScore, parseSeverity, hasRoleMatch, scoreEntry } from "../scorer.js";
import type { MemoryEntry } from "../memory-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id: "test-id",
    type: "review-finding",
    value: "Always validate input before processing.",
    createdAt: new Date().toISOString(),
    tags: [],
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

describe("recencyScore", () => {
  it("returns 1.0 for a brand-new entry", () => {
    expect(recencyScore(new Date().toISOString())).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 at exactly the half-life (30 days)", () => {
    expect(recencyScore(daysAgo(30))).toBeCloseTo(0.5, 1);
  });

  it("returns ~0.25 at 60 days (two half-lives)", () => {
    expect(recencyScore(daysAgo(60))).toBeCloseTo(0.25, 1);
  });

  it("returns 1.0 for an invalid date", () => {
    expect(recencyScore("not-a-date")).toBe(1.0);
  });

  it("does not exceed 1.0 for future dates", () => {
    const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    expect(recencyScore(future)).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// parseSeverity
// ---------------------------------------------------------------------------

describe("parseSeverity", () => {
  it("parses CRITICAL from tags", () => {
    expect(parseSeverity(makeEntry({ tags: ["critical", "sprint:v9"] }))).toBe("CRITICAL");
  });

  it("parses MAJOR from tags", () => {
    expect(parseSeverity(makeEntry({ tags: ["major"] }))).toBe("MAJOR");
  });

  it("parses MINOR from tags", () => {
    expect(parseSeverity(makeEntry({ tags: ["minor"] }))).toBe("MINOR");
  });

  it("parses CRITICAL from [CRITICAL] bracket in value", () => {
    expect(
      parseSeverity(makeEntry({ value: "**[CRITICAL] Some finding**", tags: [] })),
    ).toBe("CRITICAL");
  });

  it("parses MAJOR from [MAJOR] bracket in value", () => {
    expect(
      parseSeverity(makeEntry({ value: "- [MAJOR] duplicate logic found", tags: [] })),
    ).toBe("MAJOR");
  });

  it("parses severity from JSON value field", () => {
    expect(
      parseSeverity(
        makeEntry({
          value: JSON.stringify({ severity: "MINOR", message: "Lint warning" }),
          tags: [],
        }),
      ),
    ).toBe("MINOR");
  });

  it("defaults to INFO when no severity markers present", () => {
    expect(
      parseSeverity(makeEntry({ value: "A generic note", tags: [] })),
    ).toBe("INFO");
  });
});

// ---------------------------------------------------------------------------
// hasRoleMatch
// ---------------------------------------------------------------------------

describe("hasRoleMatch", () => {
  it("returns false with empty agentTags", () => {
    expect(hasRoleMatch(makeEntry({ tags: ["review"] }), [])).toBe(false);
  });

  it("matches on entry tags", () => {
    expect(
      hasRoleMatch(makeEntry({ tags: ["review", "critical"] }), ["review"]),
    ).toBe(true);
  });

  it("matches on value text (case-insensitive)", () => {
    expect(
      hasRoleMatch(
        makeEntry({ value: "Always run tests before merging.", tags: [] }),
        ["test"],
      ),
    ).toBe(true);
  });

  it("returns false when no overlap", () => {
    expect(
      hasRoleMatch(makeEntry({ tags: ["ci"], value: "CI note." }), ["db", "api"]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreEntry (integration)
// ---------------------------------------------------------------------------

describe("scoreEntry", () => {
  it("score is in [0, 1]", () => {
    const entry = makeEntry({ tags: ["critical"] });
    const { score } = scoreEntry(entry, "agent-a", ["review"]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("role match boosts score above non-match baseline", () => {
    const entry = makeEntry({ tags: ["review"] });
    const withMatch = scoreEntry(entry, "agent-a", ["review"]);
    const withoutMatch = scoreEntry(entry, "agent-a", ["unrelated"]);
    expect(withMatch.score).toBeGreaterThan(withoutMatch.score);
  });

  it("CRITICAL entry scores higher than INFO entry (same agent tags)", () => {
    const critical = makeEntry({ tags: ["critical"] });
    const info = makeEntry({ tags: [] });
    const { score: sc } = scoreEntry(critical, "agent-a", []);
    const { score: si } = scoreEntry(info, "agent-a", []);
    expect(sc).toBeGreaterThan(si);
  });

  it("old entry scores lower than new entry (same severity and tags)", () => {
    const old = makeEntry({ createdAt: daysAgo(90), tags: ["major"] });
    const fresh = makeEntry({ createdAt: daysAgo(0), tags: ["major"] });
    const { score: so } = scoreEntry(old, "agent-a", []);
    const { score: sf } = scoreEntry(fresh, "agent-a", []);
    expect(sf).toBeGreaterThan(so);
  });

  it("returns roleMatched=true when agent tag appears in entry", () => {
    const entry = makeEntry({ tags: ["api"] });
    const { roleMatched } = scoreEntry(entry, "api-engineer", ["api"]);
    expect(roleMatched).toBe(true);
  });
});
