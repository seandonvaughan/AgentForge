/**
 * AgentValidator — validates .agentforge/agents/*.yaml files.
 *
 * Checks required fields, valid model values, and structural correctness.
 * Never throws; always returns a structured ValidationResult.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidationError {
  agentFile: string;
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  agentsChecked: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_MODELS = new Set(["opus", "sonnet", "haiku"]);
const REQUIRED_FIELDS = ["name", "model", "system_prompt"] as const;

// ---------------------------------------------------------------------------
// AgentValidator
// ---------------------------------------------------------------------------

export class AgentValidator {
  constructor(private agentsDir: string) {}

  /**
   * Validate a single agent YAML file at the given absolute path.
   * Returns an array of ValidationErrors (empty if the file is valid).
   */
  async validateOne(filePath: string): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const fileName = filePath.split("/").pop() ?? filePath;

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      errors.push({
        agentFile: fileName,
        field: "file",
        message: `Cannot read file: ${filePath}`,
        severity: "error",
      });
      return errors;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      errors.push({
        agentFile: fileName,
        field: "yaml",
        message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        severity: "error",
      });
      return errors;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push({
        agentFile: fileName,
        field: "root",
        message: "Agent YAML must be a mapping object at the root level",
        severity: "error",
      });
      return errors;
    }

    const agent = parsed as Record<string, unknown>;

    // -- Required fields --
    for (const field of REQUIRED_FIELDS) {
      if (!(field in agent) || agent[field] === undefined || agent[field] === null) {
        errors.push({
          agentFile: fileName,
          field,
          message: `Missing required field: "${field}"`,
          severity: "error",
        });
      }
    }

    // -- name: must be a non-empty string --
    if ("name" in agent) {
      if (typeof agent.name !== "string" || agent.name.trim() === "") {
        errors.push({
          agentFile: fileName,
          field: "name",
          message: `"name" must be a non-empty string`,
          severity: "error",
        });
      }
    }

    // -- model: must be one of opus | sonnet | haiku --
    if ("model" in agent && agent.model !== undefined && agent.model !== null) {
      if (!VALID_MODELS.has(String(agent.model))) {
        errors.push({
          agentFile: fileName,
          field: "model",
          message: `"model" must be one of: opus, sonnet, haiku — got "${agent.model}"`,
          severity: "error",
        });
      }
    }

    // -- system_prompt: must be a non-empty string --
    if ("system_prompt" in agent && agent.system_prompt !== undefined && agent.system_prompt !== null) {
      if (typeof agent.system_prompt !== "string") {
        errors.push({
          agentFile: fileName,
          field: "system_prompt",
          message: `"system_prompt" must be a string`,
          severity: "error",
        });
      } else if (agent.system_prompt.trim() === "") {
        errors.push({
          agentFile: fileName,
          field: "system_prompt",
          message: `"system_prompt" must not be empty`,
          severity: "error",
        });
      }
    }

    // -- skills: if present, must be an array --
    if ("skills" in agent && agent.skills !== undefined && agent.skills !== null) {
      if (!Array.isArray(agent.skills)) {
        errors.push({
          agentFile: fileName,
          field: "skills",
          message: `"skills" must be an array`,
          severity: "error",
        });
      }
    }

    // -- triggers.file_patterns: if present, must be an array of strings --
    if ("triggers" in agent && agent.triggers !== null && typeof agent.triggers === "object") {
      const triggers = agent.triggers as Record<string, unknown>;
      if ("file_patterns" in triggers && triggers.file_patterns !== undefined && triggers.file_patterns !== null) {
        if (!Array.isArray(triggers.file_patterns)) {
          errors.push({
            agentFile: fileName,
            field: "triggers.file_patterns",
            message: `"triggers.file_patterns" must be an array of strings`,
            severity: "error",
          });
        } else {
          const nonStrings = (triggers.file_patterns as unknown[]).filter((p) => typeof p !== "string");
          if (nonStrings.length > 0) {
            errors.push({
              agentFile: fileName,
              field: "triggers.file_patterns",
              message: `"triggers.file_patterns" must be an array of strings — found ${nonStrings.length} non-string value(s)`,
              severity: "error",
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * Validate all *.yaml files in agentsDir.
   * Returns a structured ValidationResult; never throws.
   */
  async validate(): Promise<ValidationResult> {
    const allErrors: ValidationError[] = [];
    let agentsChecked = 0;

    let entries: string[];
    try {
      const dirEntries = await readdir(this.agentsDir);
      entries = dirEntries.filter((f) => f.endsWith(".yaml"));
    } catch {
      // Directory doesn't exist or isn't readable — return empty result
      return { valid: true, errors: [], warnings: [], agentsChecked: 0 };
    }

    for (const entry of entries) {
      const filePath = join(this.agentsDir, entry);
      const fileErrors = await this.validateOne(filePath);
      allErrors.push(...fileErrors);
      agentsChecked++;
    }

    const errors = allErrors.filter((e) => e.severity === "error");
    const warnings = allErrors.filter((e) => e.severity === "warning");

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      agentsChecked,
    };
  }
}
