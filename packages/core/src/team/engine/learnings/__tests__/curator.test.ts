/**
 * End-to-end tests for the learning curator.
 *
 * Each test gets an isolated tmp projectRoot with fixture YAMLs and JSONL
 * memory files. The end-to-end fixture uses 3 agents and 10+ memory entries
 * and verifies per-agent distribution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { curateLearnings } from "../curator.js";
import { extractLesson } from "../curator.js";
import type { CurationResult } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-curator-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeAgentYaml(agentId: string, tags: string[]): void {
  const agentsDir = join(projectRoot, ".agentforge", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${agentId}.yaml`),
    `name: ${agentId}\ncapability_tags:\n${tags.map((t) => `  - ${t}`).join("\n")}\n`,
    "utf8",
  );
}

function writeAgentYamlSkills(agentId: string, skills: string[]): void {
  const agentsDir = join(projectRoot, ".agentforge", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${agentId}.yaml`),
    `name: ${agentId}\nskills:\n${skills.map((s) => `  - ${s}`).join("\n")}\n`,
    "utf8",
  );
}

function writeMemoryFile(type: string, entries: object[]): void {
  const memDir = join(projectRoot, ".agentforge", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, `${type}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n"),
    "utf8",
  );
}

function makeMemEntry(
  id: string,
  type: string,
  value: string,
  tags: string[],
  createdAt?: string,
): object {
  return {
    id,
    type,
    value,
    createdAt: createdAt ?? new Date().toISOString(),
    tags,
  };
}

// ---------------------------------------------------------------------------
// extractLesson
// ---------------------------------------------------------------------------

describe("extractLesson", () => {
  it("extracts lesson field from JSON value", () => {
    const result = extractLesson(
      JSON.stringify({ lesson: "Always use type guards before narrowing.", extra: "ignored" }),
    );
    expect(result).toBe("Always use type guards before narrowing.");
  });

  it("extracts recommendation field from JSON when lesson absent", () => {
    const result = extractLesson(
      JSON.stringify({ recommendation: "Validate all inputs at the API boundary." }),
    );
    expect(result).toBe("Validate all inputs at the API boundary.");
  });

  it("falls back to first sentence for plain text", () => {
    const result = extractLesson("Use strict null checks. They prevent runtime crashes.");
    expect(result).toBe("Use strict null checks.");
  });

  it("handles non-JSON string gracefully", () => {
    const result = extractLesson("[CRITICAL] Missing auth check on endpoint");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// curateLearnings — basic happy path
// ---------------------------------------------------------------------------

describe("curateLearnings — happy path", () => {
  it("returns empty byAgent entries for agents with no matching memory", async () => {
    writeAgentYaml("backend-dev", ["unrelated-tag"]);
    writeMemoryFile("review-finding", [
      makeMemEntry("e1", "review-finding", "[MINOR] A note.", ["totally-different"]),
    ]);

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["backend-dev"],
    });

    // May have zero proposals if score < 0.3
    expect(result.byAgent["backend-dev"]).toBeDefined();
  });

  it("respects maxEntriesPerSource cap", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeMemEntry(
        `e${i}`,
        "gate-verdict",
        `[MAJOR] Finding ${i}`,
        ["review"],
      ),
    );
    writeAgentYaml("reviewer", ["review"]);
    writeMemoryFile("gate-verdict", entries);

    const result = await curateLearnings({
      projectRoot,
      agentIds: ["reviewer"],
      maxEntriesPerSource: 5,
    });

    // At most 5 entries were scored per source
    const proposed = result.byAgent["reviewer"] ?? [];
    expect(proposed.length).toBeLessThanOrEqual(5);
  });

  it("writes learnings-proposed.json to .agentforge/forge/", async () => {
    writeAgentYaml("architect", ["architecture", "design"]);
    writeMemoryFile("gate-verdict", [
      makeMemEntry("g1", "gate-verdict", JSON.stringify({ lesson: "Design before coding." }), ["architecture"]),
    ]);

    await curateLearnings({ projectRoot, agentIds: ["architect"] });

    const outPath = join(projectRoot, ".agentforge", "forge", "learnings-proposed.json");
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as CurationResult;
    expect(parsed.generatedAt).toBeTruthy();
    expect(parsed.byAgent).toBeDefined();
  });

  it("fills sourcesScanned with the three memory types", async () => {
    writeAgentYaml("coder", ["review"]);
    writeMemoryFile("gate-verdict", []);
    writeMemoryFile("review-finding", []);
    writeMemoryFile("cycle-outcome", []);

    const result = await curateLearnings({ projectRoot, agentIds: ["coder"] });
    expect(result.sourcesScanned).toHaveLength(3);
    const types = result.sourcesScanned.map((s) =>
      s.path.replace(/.*[/\\]/, "").replace(".jsonl", ""),
    );
    expect(types).toContain("gate-verdict");
    expect(types).toContain("review-finding");
    expect(types).toContain("cycle-outcome");
  });

  it("falls back to skills array when capability_tags is absent", async () => {
    writeAgentYamlSkills("test-runner", ["testing", "ci"]);
    writeMemoryFile("review-finding", [
      makeMemEntry("e1", "review-finding", "[MAJOR] Test coverage dropped.", ["testing"]),
    ]);

    const result = await curateLearnings({ projectRoot, agentIds: ["test-runner"] });
    const proposals = result.byAgent["test-runner"] ?? [];
    // With role match the score should be above MIN_SCORE
    expect(proposals.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// curateLearnings — end-to-end with 3 agents and 10 memory entries
// ---------------------------------------------------------------------------

describe("curateLearnings — end-to-end multi-agent distribution", () => {
  beforeEach(() => {
    // Three agents with distinct tags
    writeAgentYaml("api-engineer", ["api", "fastify", "route"]);
    writeAgentYaml("db-specialist", ["db", "schema", "sqlite"]);
    writeAgentYaml("security-auditor", ["security", "audit", "auth"]);

    // Gate verdicts (2)
    writeMemoryFile("gate-verdict", [
      makeMemEntry("gv1", "gate-verdict",
        JSON.stringify({ lesson: "Always validate request schemas at the route level." }),
        ["api", "route"],
      ),
      makeMemEntry("gv2", "gate-verdict",
        JSON.stringify({ severity: "MAJOR", lesson: "Gate verdicts must include rationale." }),
        ["audit"],
      ),
    ]);

    // Review findings (5)
    writeMemoryFile("review-finding", [
      makeMemEntry("rf1", "review-finding",
        "**[CRITICAL] Missing auth middleware on /admin routes.**",
        ["security", "auth"],
      ),
      makeMemEntry("rf2", "review-finding",
        "- [MAJOR] Schema migration missing rollback path.",
        ["db", "schema"],
      ),
      makeMemEntry("rf3", "review-finding",
        "[MAJOR] API returns 500 instead of 422 on validation errors.",
        ["api"],
      ),
      makeMemEntry("rf4", "review-finding",
        "[MINOR] Unused variable in auth middleware.",
        ["auth"],
      ),
      makeMemEntry("rf5", "review-finding",
        "[MINOR] Inconsistent column naming in migrations.",
        ["sqlite", "schema"],
      ),
    ]);

    // Cycle outcomes (3)
    writeMemoryFile("cycle-outcome", [
      makeMemEntry("co1", "cycle-outcome",
        JSON.stringify({ summary: "Database writes now go through a transaction wrapper." }),
        ["db"],
      ),
      makeMemEntry("co2", "cycle-outcome",
        JSON.stringify({ recommendation: "Enforce HTTPS on all API routes." }),
        ["api", "security"],
      ),
      makeMemEntry("co3", "cycle-outcome",
        "Audit logging was added to all mutation endpoints.",
        ["audit", "security"],
      ),
    ]);
  });

  it("produces proposals for all three agents", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["api-engineer", "db-specialist", "security-auditor"],
    });

    expect(Object.keys(result.byAgent)).toHaveLength(3);
    expect(result.byAgent["api-engineer"]).toBeDefined();
    expect(result.byAgent["db-specialist"]).toBeDefined();
    expect(result.byAgent["security-auditor"]).toBeDefined();
  });

  it("each agent receives at least one proposal", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["api-engineer", "db-specialist", "security-auditor"],
    });

    for (const agentId of ["api-engineer", "db-specialist", "security-auditor"]) {
      const proposals = result.byAgent[agentId] ?? [];
      expect(proposals.length).toBeGreaterThan(0);
    }
  });

  it("proposals are sorted by score descending per agent", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["api-engineer", "db-specialist", "security-auditor"],
    });

    for (const agentId of ["api-engineer", "db-specialist", "security-auditor"]) {
      const proposals = result.byAgent[agentId] ?? [];
      for (let i = 1; i < proposals.length; i++) {
        expect(proposals[i - 1]!.score).toBeGreaterThanOrEqual(proposals[i]!.score);
      }
    }
  });

  it("security-auditor receives CRITICAL severity proposals for auth findings", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["security-auditor"],
    });

    const proposals = result.byAgent["security-auditor"] ?? [];
    const critical = proposals.filter((p) => p.severity === "CRITICAL");
    expect(critical.length).toBeGreaterThan(0);
    // The CRITICAL finding mentions auth
    expect(critical[0]!.lesson.toLowerCase()).toMatch(/auth|admin/);
  });

  it("db-specialist proposals mention schema or db topics", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["db-specialist"],
    });

    const proposals = result.byAgent["db-specialist"] ?? [];
    const mentionsDb = proposals.some(
      (p) =>
        p.lesson.toLowerCase().includes("schema") ||
        p.lesson.toLowerCase().includes("migration") ||
        p.lesson.toLowerCase().includes("database") ||
        p.lesson.toLowerCase().includes("sqlite") ||
        p.lesson.toLowerCase().includes("transaction"),
    );
    expect(mentionsDb).toBe(true);
  });

  it("all proposals have required fields", async () => {
    const result = await curateLearnings({
      projectRoot,
      agentIds: ["api-engineer", "db-specialist", "security-auditor"],
    });

    for (const proposals of Object.values(result.byAgent)) {
      for (const p of proposals) {
        expect(typeof p.agentId).toBe("string");
        expect(typeof p.lesson).toBe("string");
        expect(p.lesson.length).toBeGreaterThan(0);
        expect(typeof p.score).toBe("number");
        expect(p.score).toBeGreaterThanOrEqual(0);
        expect(p.score).toBeLessThanOrEqual(1);
        expect(typeof p.sourceId).toBe("string");
        expect(["CRITICAL", "MAJOR", "MINOR", "INFO"]).toContain(p.severity);
        expect(["role-tag", "subsystem", "recurring-pattern"]).toContain(p.rationale);
        expect(typeof p.sourceCreatedAt).toBe("string");
      }
    }
  });

  it("persists the result and it can be re-read as valid JSON", async () => {
    await curateLearnings({
      projectRoot,
      agentIds: ["api-engineer", "db-specialist", "security-auditor"],
    });

    const outPath = join(projectRoot, ".agentforge", "forge", "learnings-proposed.json");
    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as CurationResult;
    expect(Object.keys(parsed.byAgent)).toHaveLength(3);
    expect(parsed.sourcesScanned).toHaveLength(3);
    expect(new Date(parsed.generatedAt).getTime()).toBeGreaterThan(0);
  });
});
