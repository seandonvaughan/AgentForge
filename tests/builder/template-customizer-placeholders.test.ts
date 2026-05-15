/**
 * template-customizer — new placeholder tests.
 *
 * Covers {project_purpose}, {key_subsystems}, {baked_learnings} substitution
 * paths added to support meaningful agent customization.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { customizeTemplate } from "../../packages/core/src/team/engine/builder/template-customizer.js";
import type { AgentTemplate } from "../../packages/core/src/team/engine/types/agent.js";
import type { FullScanResult } from "../../packages/core/src/team/engine/scanner/index.js";

function makeTemplate(systemPrompt: string): AgentTemplate {
  return {
    name: "test-agent",
    model: "sonnet",
    version: "1.0",
    description: "test",
    system_prompt: systemPrompt,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: "ceo",
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 10, auto_include: [], project_specific: [] },
  };
}

function makeScan(): FullScanResult {
  return {
    files: {
      total_files: 0,
      total_loc: 0,
      languages: {},
      frameworks_detected: [],
      files: [],
    },
    dependencies: {
      package_manager: "pnpm",
      runtime_deps: [],
      dev_deps: [],
      linters: [],
      test_frameworks: [],
      build_tools: [],
      total_deps: 0,
    },
    ci: { ci_provider: "github-actions", config_files: [] },
    git: { is_git_repo: false, contributors: [], total_commits: 0, recent_commit_count: 0 },
    docs: { docs_dirs: [], docs_files: [], readme_present: false, has_changelog: false, has_contributing: false },
  } as unknown as FullScanResult;
}

describe("template-customizer — new placeholders", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentforge-customizer-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("{project_purpose}", () => {
    it("derives purpose from README's first substantial paragraph", async () => {
      await writeFile(
        join(tempRoot, "README.md"),
        `# Test Project\n\nThis project is a substantial paragraph that describes what we do in enough detail that the customizer should pick it up as the purpose statement.\n`
      );
      const template = makeTemplate("Purpose: {project_purpose}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("substantial paragraph");
      expect(out.system_prompt).not.toContain("{project_purpose}");
    });

    it("falls back to package.json description when README is too thin", async () => {
      await writeFile(join(tempRoot, "README.md"), "# Tiny\n\nNope.\n");
      await writeFile(
        join(tempRoot, "package.json"),
        JSON.stringify({ description: "A package.json description that wins" })
      );
      const template = makeTemplate("Purpose: {project_purpose}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("package.json description that wins");
    });

    it("renders the documented-yet placeholder when nothing is available", () => {
      const template = makeTemplate("Purpose: {project_purpose}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("not been documented yet");
    });

    it("strips inline image badges, link wrappers, and HTML from README", async () => {
      await writeFile(
        join(tempRoot, "README.md"),
        `# X\n\n![badge](https://example.com/badge.svg) [npm](https://npmjs.com/p) Real prose follows here in enough length to be picked, including <em>tags</em>.\n`
      );
      const template = makeTemplate("Purpose: {project_purpose}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("Real prose follows");
      expect(out.system_prompt).not.toMatch(/example\.com/);
      expect(out.system_prompt).not.toMatch(/<em>/);
    });
  });

  describe("{key_subsystems}", () => {
    it("lists packages/* dirs with their package.json descriptions", async () => {
      const pkgRoot = join(tempRoot, "packages");
      await mkdir(join(pkgRoot, "core"), { recursive: true });
      await mkdir(join(pkgRoot, "server"), { recursive: true });
      await writeFile(
        join(pkgRoot, "core", "package.json"),
        JSON.stringify({ description: "core runtime" })
      );
      await writeFile(
        join(pkgRoot, "server", "package.json"),
        JSON.stringify({ description: "fastify api" })
      );

      const template = makeTemplate("Subs:\n{key_subsystems}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("**core** — core runtime");
      expect(out.system_prompt).toContain("**server** — fastify api");
    });

    it("renders empty string when no packages/ or apps/ exist", () => {
      const template = makeTemplate("Subs:\n{key_subsystems}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      // Placeholder collapses to empty — should not contain literal placeholder
      expect(out.system_prompt).not.toContain("{key_subsystems}");
    });
  });

  describe("{baked_learnings}", () => {
    it("falls back to friendly placeholder when memory is empty", () => {
      const template = makeTemplate("Lessons:\n{baked_learnings}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
      });
      expect(out.system_prompt).toContain("no prior learnings");
    });

    it("injects curated lessons when learnings: option is supplied", () => {
      const template = makeTemplate("Lessons:\n{baked_learnings}");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
        learnings: ["lesson A", "lesson B"],
      });
      expect(out.system_prompt).toContain("- lesson A");
      expect(out.system_prompt).toContain("- lesson B");
    });

    it("persists the curated lessons onto the returned template's learnings field", () => {
      const template = makeTemplate("...");
      const out = customizeTemplate(template, makeScan(), "TestProj", {
        projectRoot: tempRoot,
        learnings: ["x", "y", "z"],
      });
      expect(out.learnings).toEqual(["x", "y", "z"]);
    });
  });
});
