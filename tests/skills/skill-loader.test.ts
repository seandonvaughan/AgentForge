import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkill, loadDomainSkills } from "../../src/skills/skill-loader.js";

describe("skill-loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-skill-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadSkill", () => {
    it("should parse a valid skill YAML file", async () => {
      const content = `
name: web_search
version: "1.0"
category: research
domain: core
model_preference: haiku
description: Search the web for information.
parameters:
  - name: query
    type: string
    required: true
  - name: depth
    type: string
    required: false
    default: thorough
gates:
  pre: []
  post:
    - "Results must include source URLs"
composable_with:
  - summarize
`;
      await writeFile(join(tempDir, "web_search.yaml"), content);

      const skill = await loadSkill(join(tempDir, "web_search.yaml"));

      expect(skill.name).toBe("web_search");
      expect(skill.version).toBe("1.0");
      expect(skill.category).toBe("research");
      expect(skill.domain).toBe("core");
      expect(skill.model_preference).toBe("haiku");
      expect(skill.description).toBe("Search the web for information.");
      expect(skill.parameters).toHaveLength(2);
      expect(skill.parameters[0].name).toBe("query");
      expect(skill.parameters[0].type).toBe("string");
      expect(skill.parameters[0].required).toBe(true);
      expect(skill.parameters[1].default).toBe("thorough");
      expect(skill.gates.pre).toEqual([]);
      expect(skill.gates.post).toContain("Results must include source URLs");
      expect(skill.composable_with).toContain("summarize");
    });

    it("should throw on missing name field", async () => {
      const content = `
version: "1.0"
category: research
domain: core
model_preference: haiku
description: No name here.
parameters: []
gates:
  pre: []
  post: []
composable_with: []
`;
      await writeFile(join(tempDir, "no_name.yaml"), content);

      await expect(
        loadSkill(join(tempDir, "no_name.yaml"))
      ).rejects.toThrow("name");
    });

    it("should throw on missing category field", async () => {
      const content = `
name: bad_skill
version: "1.0"
domain: core
model_preference: haiku
description: Missing category.
parameters: []
gates:
  pre: []
  post: []
composable_with: []
`;
      await writeFile(join(tempDir, "no_category.yaml"), content);

      await expect(
        loadSkill(join(tempDir, "no_category.yaml"))
      ).rejects.toThrow("category");
    });

    it("should throw on invalid category value", async () => {
      const content = `
name: bad_category
version: "1.0"
category: hacking
domain: core
model_preference: haiku
description: Invalid category.
parameters: []
gates:
  pre: []
  post: []
composable_with: []
`;
      await writeFile(join(tempDir, "bad_category.yaml"), content);

      await expect(
        loadSkill(join(tempDir, "bad_category.yaml"))
      ).rejects.toThrow("category");
    });

    it("should throw on invalid model_preference", async () => {
      const content = `
name: bad_model
version: "1.0"
category: research
domain: core
model_preference: gpt4
description: Invalid model.
parameters: []
gates:
  pre: []
  post: []
composable_with: []
`;
      await writeFile(join(tempDir, "bad_model.yaml"), content);

      await expect(
        loadSkill(join(tempDir, "bad_model.yaml"))
      ).rejects.toThrow("model_preference");
    });

    it("should throw on non-existent file", async () => {
      await expect(
        loadSkill(join(tempDir, "does_not_exist.yaml"))
      ).rejects.toThrow();
    });

    it("should throw on malformed YAML", async () => {
      await writeFile(
        join(tempDir, "malformed.yaml"),
        "name: [unclosed bracket\n  invalid: yaml: content:\n"
      );

      await expect(
        loadSkill(join(tempDir, "malformed.yaml"))
      ).rejects.toThrow();
    });

    it("should fill defaults for optional fields", async () => {
      const content = `
name: minimal_skill
category: analysis
domain: core
model_preference: haiku
`;
      await writeFile(join(tempDir, "minimal.yaml"), content);

      const skill = await loadSkill(join(tempDir, "minimal.yaml"));

      expect(skill.name).toBe("minimal_skill");
      expect(skill.version).toBe("1.0");
      expect(skill.description).toBe("");
      expect(skill.parameters).toEqual([]);
      expect(skill.gates).toEqual({ pre: [], post: [] });
      expect(skill.composable_with).toEqual([]);
    });
  });

  describe("loadDomainSkills", () => {
    it("should load all skills from nested category directories", async () => {
      const researchDir = join(tempDir, "skills", "research");
      const creationDir = join(tempDir, "skills", "creation");
      await mkdir(researchDir, { recursive: true });
      await mkdir(creationDir, { recursive: true });

      await writeFile(
        join(researchDir, "web_search.yaml"),
        `name: web_search\ncategory: research\ndomain: core\nmodel_preference: haiku\n`
      );
      await writeFile(
        join(creationDir, "file_write.yaml"),
        `name: file_write\ncategory: creation\ndomain: core\nmodel_preference: haiku\n`
      );

      const skills = await loadDomainSkills(join(tempDir, "skills"));

      expect(skills).toHaveLength(2);
      const names = skills.map((s) => s.name);
      expect(names).toContain("web_search");
      expect(names).toContain("file_write");
    });

    it("should return empty array for empty directory", async () => {
      const emptyDir = join(tempDir, "empty_skills");
      await mkdir(emptyDir, { recursive: true });

      const skills = await loadDomainSkills(emptyDir);

      expect(skills).toEqual([]);
    });

    it("should skip non-yaml files in subdirectories", async () => {
      const subDir = join(tempDir, "skills", "research");
      await mkdir(subDir, { recursive: true });

      await writeFile(
        join(subDir, "web_search.yaml"),
        `name: web_search\ncategory: research\ndomain: core\nmodel_preference: haiku\n`
      );
      await writeFile(join(subDir, "README.md"), "# Skills\n");
      await writeFile(join(subDir, "config.json"), '{"key": "val"}\n');

      const skills = await loadDomainSkills(join(tempDir, "skills"));

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("web_search");
    });

    it("should also load .yml files", async () => {
      const subDir = join(tempDir, "skills", "analysis");
      await mkdir(subDir, { recursive: true });

      await writeFile(
        join(subDir, "summarize.yml"),
        `name: summarize\ncategory: analysis\ndomain: core\nmodel_preference: haiku\n`
      );

      const skills = await loadDomainSkills(join(tempDir, "skills"));

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("summarize");
    });

    it("should handle a flat directory with no subdirectories", async () => {
      const flatDir = join(tempDir, "flat_skills");
      await mkdir(flatDir, { recursive: true });

      await writeFile(
        join(flatDir, "summarize.yaml"),
        `name: summarize\ncategory: analysis\ndomain: core\nmodel_preference: haiku\n`
      );

      const skills = await loadDomainSkills(flatDir);

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("summarize");
    });
  });
});
