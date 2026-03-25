/**
 * Skill Loader — reads and validates YAML skill definitions.
 *
 * Provides functions to load individual skill files or all skills
 * within a domain's skills/ directory, returning strongly-typed
 * {@link Skill} objects.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import yaml from "js-yaml";

import type { Skill, SkillCategory, SkillParameter } from "../types/skill.js";
import type { ModelTier } from "../types/agent.js";
import type { DomainId } from "../types/domain.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: ReadonlySet<string> = new Set<SkillCategory>([
  "research",
  "analysis",
  "creation",
  "review",
  "planning",
  "communication",
]);

const VALID_MODELS: ReadonlySet<string> = new Set<ModelTier>([
  "opus",
  "sonnet",
  "haiku",
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed YAML document has the shape of a {@link Skill}.
 * Fills in defaults for optional fields.
 */
function validateSkill(raw: unknown, sourcePath: string): Skill {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Skill at ${sourcePath} did not parse to an object.`);
  }

  const doc = raw as Record<string, unknown>;

  // --- Required fields ---

  if (typeof doc.name !== "string" || !doc.name) {
    throw new Error(`Skill at ${sourcePath} is missing a "name" field.`);
  }

  if (typeof doc.category !== "string" || !doc.category) {
    throw new Error(
      `Skill "${doc.name ?? sourcePath}" is missing a "category" field.`,
    );
  }
  if (!VALID_CATEGORIES.has(doc.category)) {
    throw new Error(
      `Skill "${doc.name}" has invalid category "${doc.category}". ` +
        `Valid values: ${[...VALID_CATEGORIES].join(", ")}.`,
    );
  }

  if (typeof doc.domain !== "string" || !doc.domain) {
    throw new Error(
      `Skill "${doc.name}" is missing a "domain" field.`,
    );
  }

  if (typeof doc.model_preference !== "string" || !doc.model_preference) {
    throw new Error(
      `Skill "${doc.name}" is missing a "model_preference" field.`,
    );
  }
  if (!VALID_MODELS.has(doc.model_preference)) {
    throw new Error(
      `Skill "${doc.name}" has invalid model_preference "${doc.model_preference}". ` +
        `Valid values: ${[...VALID_MODELS].join(", ")}.`,
    );
  }

  // --- Optional fields with defaults ---

  const gates = doc.gates as Record<string, unknown> | undefined;

  const parameters: SkillParameter[] = Array.isArray(doc.parameters)
    ? (doc.parameters as Record<string, unknown>[]).map((p) => ({
        name: String(p.name ?? ""),
        type: String(p.type ?? "string"),
        required: Boolean(p.required ?? false),
        ...(p.default !== undefined ? { default: p.default } : {}),
      }))
    : [];

  return {
    name: doc.name as string,
    version: String(doc.version ?? "1.0"),
    category: doc.category as SkillCategory,
    domain: doc.domain as DomainId,
    model_preference: doc.model_preference as ModelTier,
    description: typeof doc.description === "string"
      ? doc.description.trim()
      : String(doc.description ?? ""),
    parameters,
    gates: {
      pre: Array.isArray(gates?.pre) ? (gates!.pre as string[]) : [],
      post: Array.isArray(gates?.post) ? (gates!.post as string[]) : [],
    },
    composable_with: Array.isArray(doc.composable_with)
      ? (doc.composable_with as string[])
      : [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single YAML skill definition from disk.
 *
 * @param skillPath - Absolute or relative path to a `.yaml` / `.yml` file.
 * @returns A validated {@link Skill}.
 */
export async function loadSkill(skillPath: string): Promise<Skill> {
  const content = await readFile(skillPath, "utf-8");
  const raw = yaml.load(content);
  return validateSkill(raw, skillPath);
}

/**
 * Recursively load all `.yaml` / `.yml` skill files from a domain's
 * skills directory.
 *
 * The directory may be flat (YAML files at the root) or organized into
 * subdirectories by category (e.g. `research/`, `creation/`).
 *
 * @param skillsDir - The root skills directory (e.g. `templates/domains/core/skills/`).
 * @returns Array of validated {@link Skill} objects.
 */
export async function loadDomainSkills(skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const fullPath = join(skillsDir, entry);
    const ext = extname(entry);

    if (ext === ".yaml" || ext === ".yml") {
      // File at root level
      const skill = await loadSkill(fullPath);
      skills.push(skill);
    } else if (!ext) {
      // Likely a subdirectory — attempt to read its contents
      let subEntries: string[];
      try {
        subEntries = await readdir(fullPath);
      } catch {
        continue;
      }

      for (const subEntry of subEntries) {
        const subExt = extname(subEntry);
        if (subExt === ".yaml" || subExt === ".yml") {
          const skill = await loadSkill(join(fullPath, subEntry));
          skills.push(skill);
        }
      }
    }
  }

  return skills;
}
