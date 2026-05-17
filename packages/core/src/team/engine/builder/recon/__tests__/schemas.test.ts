/**
 * Unit tests for the five Recon-phase Zod schemas.
 *
 * Each schema is tested with:
 * - A happy-path fixture that should pass validation.
 * - One or more malformed inputs that should fail.
 */

import { describe, it, expect } from "vitest";
import {
  SubsystemsReportSchema,
  DependenciesReportSchema,
  ConventionsReportSchema,
  DomainReportSchema,
  HistoryReportSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// SubsystemsReport
// ---------------------------------------------------------------------------

describe("SubsystemsReportSchema", () => {
  const valid = {
    subsystems: [
      {
        name: "api-routes",
        path: "packages/server/src/routes",
        description: "REST route handlers.",
        public_surface: ["registerRoutes"],
        owner_hint: "api-engineer",
      },
      {
        name: "db-layer",
        path: "packages/db/src",
        description: "SQLite persistence.",
        public_surface: ["getDb", "runMigrations"],
        // owner_hint omitted — optional field
      },
    ],
  };

  it("accepts a well-formed subsystems report", () => {
    expect(SubsystemsReportSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a subsystem without owner_hint", () => {
    const result = SubsystemsReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subsystems[1]?.owner_hint).toBeUndefined();
    }
  });

  it("rejects missing subsystems array", () => {
    expect(SubsystemsReportSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a subsystem with empty name", () => {
    const bad = {
      subsystems: [{ name: "", path: "pkg/src", description: "x", public_surface: [] }],
    };
    expect(SubsystemsReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a subsystem with missing required field", () => {
    const bad = {
      subsystems: [{ name: "foo", path: "pkg/src" /* no description, no public_surface */ }],
    };
    expect(SubsystemsReportSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DependenciesReport
// ---------------------------------------------------------------------------

describe("DependenciesReportSchema", () => {
  const valid = {
    package_manager: "pnpm",
    prod_deps: [
      { name: "fastify", version: "^4.0.0", category: "framework", in_use_proven: true },
    ],
    dev_deps: [
      { name: "vitest", version: "^1.0.0", category: "testing", in_use_proven: false },
    ],
    framework_signals: [
      { name: "fastify", evidence_files: ["src/server.ts"], confidence: 0.99 },
    ],
  };

  it("accepts a valid dependencies report", () => {
    expect(DependenciesReportSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts empty dep arrays", () => {
    const minimal = {
      package_manager: "npm",
      prod_deps: [],
      dev_deps: [],
      framework_signals: [],
    };
    expect(DependenciesReportSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects confidence > 1", () => {
    const bad = {
      ...valid,
      framework_signals: [{ name: "fastify", evidence_files: [], confidence: 1.5 }],
    };
    expect(DependenciesReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const bad = {
      ...valid,
      framework_signals: [{ name: "fastify", evidence_files: [], confidence: -0.1 }],
    };
    expect(DependenciesReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing package_manager", () => {
    const { package_manager: _pm, ...rest } = valid;
    expect(DependenciesReportSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a dep with non-boolean in_use_proven", () => {
    const bad = {
      ...valid,
      prod_deps: [{ name: "fastify", version: "4", category: "framework", in_use_proven: "yes" }],
    };
    expect(DependenciesReportSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConventionsReport
// ---------------------------------------------------------------------------

describe("ConventionsReportSchema", () => {
  const valid = {
    linter_rules: ["no-unused-vars", "import/extensions"],
    test_pattern: ["**/__tests__/*.test.ts"],
    file_layout: ["kebab-case source files"],
    import_style: "ESM with .js extensions",
  };

  it("accepts a minimal conventions report (all optionals absent)", () => {
    expect(ConventionsReportSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a full conventions report", () => {
    const full = {
      formatter: "prettier",
      linter: "eslint",
      linter_rules: ["no-unused-vars"],
      test_runner: "vitest",
      test_pattern: ["**/__tests__/*.test.ts"],
      file_layout: ["kebab-case source files", "__tests__/ colocated"],
      import_style: "ESM with .js extensions",
      error_handling_pattern: "throws typed errors",
    };
    expect(ConventionsReportSchema.safeParse(full).success).toBe(true);
  });

  it("rejects missing import_style", () => {
    const { import_style: _is, ...rest } = valid;
    expect(ConventionsReportSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing linter_rules array", () => {
    const { linter_rules: _lr, ...rest } = valid;
    expect(ConventionsReportSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DomainReport
// ---------------------------------------------------------------------------

describe("DomainReportSchema", () => {
  const valid = {
    product_name: "AgentForge",
    one_liner: "Forges specialized AI agent teams for software projects.",
    user_personas: ["software engineering teams"],
    core_primitives: ["Agent", "Cycle", "SprintPlan"],
    domain_vocabulary: ["forge", "recon", "gate"],
    non_goals: ["not a deployment tool"],
  };

  it("accepts a valid domain report", () => {
    expect(DomainReportSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts empty arrays for all list fields", () => {
    const minimal = {
      product_name: "Foo",
      one_liner: "Does something.",
      user_personas: [],
      core_primitives: [],
      domain_vocabulary: [],
      non_goals: [],
    };
    expect(DomainReportSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects empty product_name", () => {
    const bad = { ...valid, product_name: "" };
    expect(DomainReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing one_liner", () => {
    const { one_liner: _ol, ...rest } = valid;
    expect(DomainReportSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-array for core_primitives", () => {
    const bad = { ...valid, core_primitives: "Agent,Cycle" };
    expect(DomainReportSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HistoryReport
// ---------------------------------------------------------------------------

describe("HistoryReportSchema", () => {
  const valid = {
    recurring_bug_patterns: [
      { pattern: "Missing .js extension", count: 3, last_seen: "2026-05-14" },
    ],
    gate_rejection_themes: ["hallucinated file paths"],
    cost_outliers: ["Opus synthesis on 50k corpus"],
    high_value_subsystems: ["packages/core/src/runtime"],
  };

  it("accepts a valid history report", () => {
    expect(HistoryReportSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts all empty arrays", () => {
    const empty = {
      recurring_bug_patterns: [],
      gate_rejection_themes: [],
      cost_outliers: [],
      high_value_subsystems: [],
    };
    expect(HistoryReportSchema.safeParse(empty).success).toBe(true);
  });

  it("rejects a bug pattern with float count", () => {
    const bad = {
      ...valid,
      recurring_bug_patterns: [{ pattern: "foo", count: 1.5, last_seen: "2026-05-01" }],
    };
    expect(HistoryReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a bug pattern with negative count", () => {
    const bad = {
      ...valid,
      recurring_bug_patterns: [{ pattern: "foo", count: -1, last_seen: "2026-05-01" }],
    };
    expect(HistoryReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing last_seen", () => {
    const bad = {
      ...valid,
      recurring_bug_patterns: [{ pattern: "foo", count: 2 }],
    };
    expect(HistoryReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-array for gate_rejection_themes", () => {
    const bad = { ...valid, gate_rejection_themes: "themes" };
    expect(HistoryReportSchema.safeParse(bad).success).toBe(false);
  });
});
