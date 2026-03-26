/**
 * Tests for AgentValidator (P2-2).
 *
 * Verifies that the validator correctly identifies required-field violations,
 * invalid model values, structural issues, and that all real agent YAMLs
 * in .agentforge/agents/ are valid.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

import { AgentValidator } from "../../src/builder/agent-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentforge-validator-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeAgentYaml(dir: string, fileName: string, data: unknown): Promise<string> {
  const filePath = join(dir, fileName);
  await writeFile(filePath, yaml.dump(data), "utf8");
  return filePath;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// Valid agent
// ---------------------------------------------------------------------------

describe("AgentValidator — validateOne", () => {
  it("valid agent passes with 0 errors", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "coder.yaml", {
      name: "coder",
      model: "sonnet",
      system_prompt: "You are the coder agent.",
      skills: ["code_generation", "refactoring"],
      triggers: {
        file_patterns: ["**/*.ts", "**/*.js"],
      },
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    expect(errors).toHaveLength(0);
  });

  it("valid agent with only required fields passes with 0 errors", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "minimal.yaml", {
      name: "minimal",
      model: "haiku",
      system_prompt: "You are the minimal agent.",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    expect(errors).toHaveLength(0);
  });

  // -- Required field: name --

  it("missing name → error with field 'name'", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "no-name.yaml", {
      model: "sonnet",
      system_prompt: "You are an agent.",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const nameErrors = errors.filter((e) => e.field === "name");
    expect(nameErrors.length).toBeGreaterThan(0);
    expect(nameErrors[0].severity).toBe("error");
  });

  // -- Required field: system_prompt --

  it("missing system_prompt → error with field 'system_prompt'", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "no-prompt.yaml", {
      name: "agent",
      model: "sonnet",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const promptErrors = errors.filter((e) => e.field === "system_prompt");
    expect(promptErrors.length).toBeGreaterThan(0);
    expect(promptErrors[0].severity).toBe("error");
  });

  // -- Invalid model value --

  it("invalid model value → error with field 'model'", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "bad-model.yaml", {
      name: "agent",
      model: "gpt-4",
      system_prompt: "You are an agent.",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const modelErrors = errors.filter((e) => e.field === "model");
    expect(modelErrors.length).toBeGreaterThan(0);
    expect(modelErrors[0].severity).toBe("error");
    expect(modelErrors[0].message).toContain("gpt-4");
  });

  it("model 'opus' is valid", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "opus-agent.yaml", {
      name: "opus-agent",
      model: "opus",
      system_prompt: "You are a strategic agent.",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const modelErrors = errors.filter((e) => e.field === "model");
    expect(modelErrors).toHaveLength(0);
  });

  it("model 'haiku' is valid", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "haiku-agent.yaml", {
      name: "haiku-agent",
      model: "haiku",
      system_prompt: "You are a lightweight agent.",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const modelErrors = errors.filter((e) => e.field === "model");
    expect(modelErrors).toHaveLength(0);
  });

  // -- Empty system_prompt --

  it("empty system_prompt → error", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "empty-prompt.yaml", {
      name: "agent",
      model: "sonnet",
      system_prompt: "   ",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const promptErrors = errors.filter((e) => e.field === "system_prompt");
    expect(promptErrors.length).toBeGreaterThan(0);
    expect(promptErrors[0].severity).toBe("error");
  });

  // -- Skills not array --

  it("skills not array → error", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "bad-skills.yaml", {
      name: "agent",
      model: "sonnet",
      system_prompt: "You are an agent.",
      skills: "code_generation",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const skillErrors = errors.filter((e) => e.field === "skills");
    expect(skillErrors.length).toBeGreaterThan(0);
    expect(skillErrors[0].severity).toBe("error");
  });

  it("skills as empty array is valid", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "empty-skills.yaml", {
      name: "agent",
      model: "sonnet",
      system_prompt: "You are an agent.",
      skills: [],
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const skillErrors = errors.filter((e) => e.field === "skills");
    expect(skillErrors).toHaveLength(0);
  });

  // -- triggers.file_patterns not array --

  it("triggers.file_patterns not array → error", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "bad-patterns.yaml", {
      name: "agent",
      model: "sonnet",
      system_prompt: "You are an agent.",
      triggers: {
        file_patterns: "**/*.ts",
      },
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const patternErrors = errors.filter((e) => e.field === "triggers.file_patterns");
    expect(patternErrors.length).toBeGreaterThan(0);
    expect(patternErrors[0].severity).toBe("error");
  });

  it("triggers.file_patterns with non-string elements → error", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "non-string-patterns.yaml", {
      name: "agent",
      model: "sonnet",
      system_prompt: "You are an agent.",
      triggers: {
        file_patterns: ["**/*.ts", 42, true],
      },
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const patternErrors = errors.filter((e) => e.field === "triggers.file_patterns");
    expect(patternErrors.length).toBeGreaterThan(0);
  });

  it("invalid YAML syntax → error", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "bad-yaml.yaml");
    await writeFile(filePath, "name: [unclosed bracket\nmodel: sonnet", "utf8");

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    const yamlErrors = errors.filter((e) => e.field === "yaml");
    expect(yamlErrors.length).toBeGreaterThan(0);
    expect(yamlErrors[0].severity).toBe("error");
  });

  it("multiple required fields missing → multiple errors", async () => {
    const dir = await makeTempDir();
    const filePath = await writeAgentYaml(dir, "empty-agent.yaml", {
      version: "1.0",
    });

    const validator = new AgentValidator(dir);
    const errors = await validator.validateOne(filePath);
    // name, model, system_prompt all missing
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// validate() — scans a directory
// ---------------------------------------------------------------------------

describe("AgentValidator — validate()", () => {
  it("returns valid=true and 0 errors for empty directory", async () => {
    const dir = await makeTempDir();
    const validator = new AgentValidator(dir);
    const result = await validator.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.agentsChecked).toBe(0);
  });

  it("returns valid=true for a directory of all-valid agents", async () => {
    const dir = await makeTempDir();
    await writeAgentYaml(dir, "coder.yaml", {
      name: "coder",
      model: "sonnet",
      system_prompt: "You are the coder agent.",
    });
    await writeAgentYaml(dir, "architect.yaml", {
      name: "architect",
      model: "opus",
      system_prompt: "You are the architect agent.",
    });

    const validator = new AgentValidator(dir);
    const result = await validator.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.agentsChecked).toBe(2);
  });

  it("returns valid=false when one agent is invalid", async () => {
    const dir = await makeTempDir();
    await writeAgentYaml(dir, "valid.yaml", {
      name: "valid",
      model: "sonnet",
      system_prompt: "You are a valid agent.",
    });
    await writeAgentYaml(dir, "invalid.yaml", {
      name: "invalid",
      model: "bad-model",
      system_prompt: "You are an invalid agent.",
    });

    const validator = new AgentValidator(dir);
    const result = await validator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.agentsChecked).toBe(2);
  });

  it("agentsChecked reflects number of yaml files found", async () => {
    const dir = await makeTempDir();
    for (let i = 0; i < 5; i++) {
      await writeAgentYaml(dir, `agent-${i}.yaml`, {
        name: `agent-${i}`,
        model: "haiku",
        system_prompt: `You are agent ${i}.`,
      });
    }
    // Non-yaml files should be ignored
    await writeFile(join(dir, "notes.txt"), "some notes", "utf8");
    await writeFile(join(dir, "README.md"), "readme", "utf8");

    const validator = new AgentValidator(dir);
    const result = await validator.validate();
    expect(result.agentsChecked).toBe(5);
  });

  it("handles non-existent directory gracefully", async () => {
    const validator = new AgentValidator("/nonexistent/path/that/does/not/exist");
    const result = await validator.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.agentsChecked).toBe(0);
  });

  it("separates errors from warnings in the result", async () => {
    const dir = await makeTempDir();
    // This agent is missing name (error) but otherwise fine
    await writeAgentYaml(dir, "bad.yaml", {
      model: "sonnet",
      system_prompt: "You are an agent.",
    });

    const validator = new AgentValidator(dir);
    const result = await validator.validate();
    expect(result.errors.length).toBeGreaterThan(0);
    // warnings is a separate array
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  // -- Real agents directory integration test --

  it("scans real .agentforge/agents/ directory and finds 0 errors", async () => {
    // Resolve relative to the project root
    const projectRoot = resolve(new URL("../../", import.meta.url).pathname);
    const agentsDir = join(projectRoot, ".agentforge", "agents");

    const validator = new AgentValidator(agentsDir);
    const result = await validator.validate();

    if (result.agentsChecked === 0) {
      // Directory doesn't exist in this environment — skip gracefully
      expect(result.valid).toBe(true);
      return;
    }

    expect(result.agentsChecked).toBeGreaterThan(0);
    if (!result.valid) {
      // Print errors for debugging
      const msg = result.errors
        .map((e) => `  [${e.agentFile}] ${e.field}: ${e.message}`)
        .join("\n");
      throw new Error(`Real agent validation failed with ${result.errors.length} error(s):\n${msg}`);
    }
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
