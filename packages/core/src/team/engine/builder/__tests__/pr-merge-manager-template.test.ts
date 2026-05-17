/**
 * Tests for the pr-merge-manager agent templates.
 *
 * Verifies both the flat template (templates/agents/) and the domain template
 * (templates/domains/software/agents/) load cleanly via loadTemplate() and
 * satisfy required-field contracts.
 */
import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplate } from "../template-loader.js";
import type { AgentTemplate } from "../../types/agent.js";

// Resolve repo root from this test file. The file lives at:
//   <repo>/packages/core/src/team/engine/builder/__tests__/<this>.test.ts
// So from __dirname (the __tests__ folder), we climb 7 levels to reach <repo>.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..", "..");

const FLAT_TEMPLATE_PATH = join(
  REPO_ROOT,
  "templates",
  "agents",
  "pr-merge-manager.yaml",
);

const DOMAIN_TEMPLATE_PATH = join(
  REPO_ROOT,
  "templates",
  "domains",
  "software",
  "agents",
  "pr-merge-manager.yaml",
);

function assertRequiredFields(template: AgentTemplate, label: string): void {
  expect(template.name, `${label}: name`).toBe("pr-merge-manager");
  expect(template.model, `${label}: model`).toBe("sonnet");
  expect(template.description, `${label}: description`).toMatch(
    /REQUIRED on every team/i,
  );
  expect(template.skills, `${label}: skills`).toContain("git_merge");
  expect(template.skills, `${label}: skills`).toContain("conflict_resolution");
  expect(template.skills, `${label}: skills`).toContain("pr_review");
  expect(
    template.triggers.file_patterns,
    `${label}: triggers.file_patterns`,
  ).toHaveLength(0);
  expect(template.triggers.keywords, `${label}: triggers.keywords`).toContain(
    "merge",
  );
  expect(template.triggers.keywords, `${label}: triggers.keywords`).toContain(
    "rebase",
  );
  expect(
    template.collaboration.reports_to,
    `${label}: collaboration.reports_to`,
  ).toBe("engineering-manager-infra");
  expect(
    template.context.auto_include,
    `${label}: context.auto_include`,
  ).toContain(".github/PULL_REQUEST_TEMPLATE.md");
  expect(
    template.context.auto_include,
    `${label}: context.auto_include`,
  ).toContain(".github/workflows/ci.yml");
}

function assertSystemPromptCoversSpecialCases(
  template: AgentTemplate,
  label: string,
): void {
  const prompt = template.system_prompt;
  expect(prompt, `${label}: JSONL rule`).toMatch(/jsonl/i);
  expect(prompt, `${label}: SQLite rule`).toMatch(/sqlite/i);
  expect(prompt, `${label}: lock file rule`).toMatch(/lock/i);
  expect(prompt, `${label}: non-trivial comment`).toMatch(
    /pr-merge-manager.*non-trivial/i,
  );
}

describe("flat template — templates/agents/pr-merge-manager.yaml", () => {
  it("loads without throwing", async () => {
    await expect(loadTemplate(FLAT_TEMPLATE_PATH)).resolves.toBeDefined();
  });

  it("satisfies required fields", async () => {
    const template = await loadTemplate(FLAT_TEMPLATE_PATH);
    assertRequiredFields(template, "flat");
  });

  it("system_prompt covers all special-case merge rules", async () => {
    const template = await loadTemplate(FLAT_TEMPLATE_PATH);
    assertSystemPromptCoversSpecialCases(template, "flat");
  });

  it("has no file_patterns triggers (orchestrator-invoked)", async () => {
    const template = await loadTemplate(FLAT_TEMPLATE_PATH);
    expect(template.triggers.file_patterns).toHaveLength(0);
  });
});

describe("domain template — templates/domains/software/agents/pr-merge-manager.yaml", () => {
  it("loads without throwing", async () => {
    await expect(loadTemplate(DOMAIN_TEMPLATE_PATH)).resolves.toBeDefined();
  });

  it("satisfies required fields", async () => {
    const template = await loadTemplate(DOMAIN_TEMPLATE_PATH);
    assertRequiredFields(template, "domain");
  });

  it("system_prompt covers all special-case merge rules", async () => {
    const template = await loadTemplate(DOMAIN_TEMPLATE_PATH);
    assertSystemPromptCoversSpecialCases(template, "domain");
  });

  it("domain template carries {baked_learnings} placeholder", async () => {
    const template = await loadTemplate(DOMAIN_TEMPLATE_PATH);
    expect(template.system_prompt).toContain("{baked_learnings}");
  });

  it("domain template carries {project_name} placeholder", async () => {
    const template = await loadTemplate(DOMAIN_TEMPLATE_PATH);
    expect(template.system_prompt).toContain("{project_name}");
  });
});
