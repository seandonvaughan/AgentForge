import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadTemplate,
  loadAllTemplates,
} from "../../src/builder/template-loader.js";

describe("template-loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-tpl-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadTemplate", () => {
    it("should parse a valid YAML template", async () => {
      const templateContent = `
name: Security Auditor
model: sonnet
version: "1.0"
description: Audits code for security vulnerabilities
system_prompt: "You are a security auditor for {project_name}."
skills:
  - vulnerability-scanning
  - code-review
triggers:
  file_patterns:
    - "**/*.ts"
  keywords:
    - security
    - vulnerability
collaboration:
  reports_to: architect
  reviews_from:
    - coder
  can_delegate_to:
    - file-reader
  parallel: true
context:
  max_files: 30
  auto_include:
    - "*.config.*"
  project_specific: []
`;
      await writeFile(join(tempDir, "security-auditor.yaml"), templateContent);

      const template = await loadTemplate(
        join(tempDir, "security-auditor.yaml")
      );

      expect(template.name).toBe("Security Auditor");
      expect(template.model).toBe("sonnet");
      expect(template.version).toBe("1.0");
      expect(template.description).toBe(
        "Audits code for security vulnerabilities"
      );
      expect(template.skills).toContain("vulnerability-scanning");
      expect(template.skills).toContain("code-review");
      expect(template.triggers.file_patterns).toContain("**/*.ts");
      expect(template.triggers.keywords).toContain("security");
      expect(template.collaboration.reports_to).toBe("architect");
      expect(template.collaboration.reviews_from).toContain("coder");
      expect(template.collaboration.can_delegate_to).toContain("file-reader");
      expect(template.collaboration.parallel).toBe(true);
      expect(template.context.max_files).toBe(30);
    });

    it("should fill in defaults for missing optional fields", async () => {
      const templateContent = `
name: Minimal Agent
`;
      await writeFile(join(tempDir, "minimal.yaml"), templateContent);

      const template = await loadTemplate(join(tempDir, "minimal.yaml"));

      expect(template.name).toBe("Minimal Agent");
      expect(template.model).toBe("sonnet");
      expect(template.version).toBe("1.0");
      expect(template.description).toBe("");
      expect(template.system_prompt).toBe("");
      expect(template.skills).toEqual([]);
      expect(template.triggers.file_patterns).toEqual([]);
      expect(template.triggers.keywords).toEqual([]);
      expect(template.collaboration.reports_to).toBeNull();
      expect(template.collaboration.reviews_from).toEqual([]);
      expect(template.collaboration.can_delegate_to).toEqual([]);
      expect(template.collaboration.parallel).toBe(false);
      expect(template.context.max_files).toBe(20);
      expect(template.context.auto_include).toEqual([]);
      expect(template.context.project_specific).toEqual([]);
    });

    it("should throw on missing name field", async () => {
      await writeFile(
        join(tempDir, "invalid.yaml"),
        "model: sonnet\ndescription: no name\n"
      );

      await expect(
        loadTemplate(join(tempDir, "invalid.yaml"))
      ).rejects.toThrow('missing a "name" field');
    });

    it("should throw on invalid model tier", async () => {
      await writeFile(
        join(tempDir, "bad-model.yaml"),
        "name: Bad Agent\nmodel: gpt-4\n"
      );

      await expect(
        loadTemplate(join(tempDir, "bad-model.yaml"))
      ).rejects.toThrow('invalid model tier');
    });

    it("should throw on non-existent file", async () => {
      await expect(
        loadTemplate(join(tempDir, "does-not-exist.yaml"))
      ).rejects.toThrow();
    });

    it("should throw on malformed YAML", async () => {
      await writeFile(
        join(tempDir, "malformed.yaml"),
        "name: [unclosed bracket\n  invalid: yaml: content:\n"
      );

      await expect(
        loadTemplate(join(tempDir, "malformed.yaml"))
      ).rejects.toThrow();
    });
  });

  describe("loadAllTemplates", () => {
    it("should load multiple templates from a directory", async () => {
      await writeFile(
        join(tempDir, "coder.yaml"),
        "name: Coder\nmodel: sonnet\n"
      );
      await writeFile(
        join(tempDir, "architect.yaml"),
        "name: Architect\nmodel: opus\n"
      );
      await writeFile(
        join(tempDir, "linter.yaml"),
        "name: Linter\nmodel: haiku\n"
      );

      const templates = await loadAllTemplates(tempDir);

      expect(templates.size).toBe(3);
      expect(templates.has("coder")).toBe(true);
      expect(templates.has("architect")).toBe(true);
      expect(templates.has("linter")).toBe(true);
    });

    it("should key templates by lowercase hyphenated name", async () => {
      await writeFile(
        join(tempDir, "security.yaml"),
        "name: Security Auditor\nmodel: sonnet\n"
      );

      const templates = await loadAllTemplates(tempDir);

      expect(templates.has("security-auditor")).toBe(true);
      expect(templates.get("security-auditor")!.name).toBe("Security Auditor");
    });

    it("should also load .yml files", async () => {
      await writeFile(
        join(tempDir, "agent.yml"),
        "name: YML Agent\nmodel: haiku\n"
      );

      const templates = await loadAllTemplates(tempDir);

      expect(templates.size).toBe(1);
      expect(templates.has("yml-agent")).toBe(true);
    });

    it("should skip non-yaml files", async () => {
      await writeFile(
        join(tempDir, "agent.yaml"),
        "name: Agent\nmodel: sonnet\n"
      );
      await writeFile(join(tempDir, "README.md"), "# Templates\n");
      await writeFile(join(tempDir, "config.json"), '{"key": "value"}\n');

      const templates = await loadAllTemplates(tempDir);

      expect(templates.size).toBe(1);
    });

    it("should return empty map for empty directory", async () => {
      const templates = await loadAllTemplates(tempDir);

      expect(templates.size).toBe(0);
    });
  });
});
