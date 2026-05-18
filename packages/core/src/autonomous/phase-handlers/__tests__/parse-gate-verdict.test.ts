// Unit tests for parseGateVerdict — the gate-phase JSON extractor.
//
// Covers the regression mode from cycle db9c145f (v17.2.0, 2026-05-17):
// the agent emitted a valid verdict object wrapped in a markdown
// ```json fence + preceded by `★ Insight` prose; the old non-greedy
// regex truncated the JSON mid-rationale and the cycle was rejected
// despite an actual APPROVE vote.

import { describe, it, expect } from "vitest";
import { parseGateVerdict } from "../gate-phase.js";

describe("parseGateVerdict — strict JSON", () => {
  it("parses raw APPROVE", () => {
    const r = parseGateVerdict('{"verdict": "APPROVE", "rationale": "ok"}');
    expect(r.verdict).toBe("APPROVE");
    expect(r.rationale).toBe("ok");
  });

  it("parses raw REJECT", () => {
    const r = parseGateVerdict('{"verdict": "REJECT", "rationale": "ci failing"}');
    expect(r.verdict).toBe("REJECT");
  });

  it("normalises lowercase verdict", () => {
    const r = parseGateVerdict('{"verdict": "approve", "rationale": "ok"}');
    expect(r.verdict).toBe("APPROVE");
  });
});

describe("parseGateVerdict — fenced markdown blocks", () => {
  it("extracts from ```json fenced block (the v17.2.0 failure case)", () => {
    const response = [
      "`★ Insight ─────────────────────────────────────`",
      "The verification protocol here is the key guard against stale-review false positives.",
      "`─────────────────────────────────────────────────`",
      "",
      "I've now verified all MAJOR findings against the current working tree.",
      "Here is my structured verdict:",
      "",
      "```json",
      "{",
      '  "verdict": "APPROVE",',
      '  "rationale": "All 5 sprint items completed. No CRITICAL findings.",',
      '  "findings": []',
      "}",
      "```",
    ].join("\n");

    const r = parseGateVerdict(response);
    expect(r.verdict).toBe("APPROVE");
    expect(r.rationale).toContain("5 sprint items completed");
  });

  it("extracts from ``` fence without language tag", () => {
    const r = parseGateVerdict('```\n{"verdict":"REJECT","rationale":"ci red"}\n```');
    expect(r.verdict).toBe("REJECT");
  });

  it("extracts when rationale contains nested braces", () => {
    const response = [
      "Here is my verdict:",
      "```json",
      "{",
      '  "verdict": "APPROVE",',
      '  "rationale": "Verified types match {a, b, c} schema and {x, y} is unchanged."',
      "}",
      "```",
    ].join("\n");
    const r = parseGateVerdict(response);
    expect(r.verdict).toBe("APPROVE");
    expect(r.rationale).toContain("{a, b, c}");
  });

  it("extracts when rationale contains backslash-escaped quotes", () => {
    const r = parseGateVerdict(
      '```json\n{"verdict":"APPROVE","rationale":"Diff includes \\"foo\\" -> \\"bar\\""}\n```',
    );
    expect(r.verdict).toBe("APPROVE");
    expect(r.rationale).toContain('"foo"');
  });
});

describe("parseGateVerdict — inline JSON (no fence)", () => {
  it("extracts a verdict object surrounded by prose", () => {
    const response = [
      "Reviewing the cycle artifacts...",
      "Everything looks good. My structured verdict:",
      '{"verdict": "APPROVE", "rationale": "tests pass, lint clean"}',
      "",
      "Cycle complete.",
    ].join("\n");
    const r = parseGateVerdict(response);
    expect(r.verdict).toBe("APPROVE");
  });

  it("walks balanced braces past the first false-match `}`", () => {
    // Prior non-greedy regex stopped at the first `}` after `verdict`,
    // truncating the object and triggering a fallback REJECT.
    const response = [
      "Verdict: ",
      '{"verdict": "APPROVE", "rationale": "abc", "metrics": {"tests": 6569}}',
    ].join("\n");
    const r = parseGateVerdict(response);
    expect(r.verdict).toBe("APPROVE");
    expect(r.rationale).toBe("abc");
  });
});

describe("parseGateVerdict — last-resort fallback", () => {
  it("treats empty text as REJECT", () => {
    const r = parseGateVerdict("");
    expect(r.verdict).toBe("REJECT");
  });

  it("treats prose-only response as REJECT and preserves the text", () => {
    const r = parseGateVerdict("I think we should approve but cannot decide.");
    expect(r.verdict).toBe("REJECT");
    expect(r.rationale).toContain("should approve");
  });
});
