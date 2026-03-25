/**
 * Template Loader — reads and parses YAML agent templates.
 *
 * Provides functions to load individual templates or an entire directory
 * of templates, returning strongly-typed {@link AgentTemplate} objects.
 * Supports both the legacy flat directory layout (`templates/agents/`)
 * and the new domain-based layout (`templates/domains/<domain>/agents/`).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import type { AgentTemplate } from "../types/agent.js";
import type { DomainId } from "../types/domain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed YAML document has the minimum shape of an
 * {@link AgentTemplate}. Fills in defaults for optional nested fields so
 * downstream code can rely on the full interface.
 */
function validateTemplate(raw: unknown, sourcePath: string): AgentTemplate {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Template at ${sourcePath} did not parse to an object.`);
  }

  const doc = raw as Record<string, unknown>;

  if (typeof doc.name !== "string" || !doc.name) {
    throw new Error(`Template at ${sourcePath} is missing a "name" field.`);
  }

  const model = (doc.model as string) ?? "sonnet";
  if (model !== "opus" && model !== "sonnet" && model !== "haiku") {
    throw new Error(
      `Template "${doc.name}" has invalid model tier "${model}".`,
    );
  }

  const triggers = doc.triggers as Record<string, unknown> | undefined;
  const collaboration = doc.collaboration as Record<string, unknown> | undefined;
  const context = doc.context as Record<string, unknown> | undefined;

  return {
    name: doc.name as string,
    model,
    version: String(doc.version ?? "1.0"),
    description: String(doc.description ?? ""),
    system_prompt: String(doc.system_prompt ?? ""),
    skills: Array.isArray(doc.skills) ? (doc.skills as string[]) : [],
    triggers: {
      file_patterns: Array.isArray(triggers?.file_patterns)
        ? (triggers!.file_patterns as string[])
        : [],
      keywords: Array.isArray(triggers?.keywords)
        ? (triggers!.keywords as string[])
        : [],
    },
    collaboration: {
      reports_to:
        collaboration?.reports_to != null
          ? String(collaboration.reports_to)
          : null,
      reviews_from: Array.isArray(collaboration?.reviews_from)
        ? (collaboration!.reviews_from as string[])
        : [],
      can_delegate_to: Array.isArray(collaboration?.can_delegate_to)
        ? (collaboration!.can_delegate_to as string[])
        : [],
      parallel: Boolean(collaboration?.parallel ?? false),
    },
    context: {
      max_files: Number(context?.max_files ?? 20),
      auto_include: Array.isArray(context?.auto_include)
        ? (context!.auto_include as string[])
        : [],
      project_specific: Array.isArray(context?.project_specific)
        ? (context!.project_specific as string[])
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single YAML agent template from disk.
 *
 * @param templatePath - Absolute or relative path to a `.yaml` file.
 * @returns A validated {@link AgentTemplate}.
 */
export async function loadTemplate(
  templatePath: string,
): Promise<AgentTemplate> {
  const content = await readFile(templatePath, "utf-8");
  const raw = yaml.load(content);
  return validateTemplate(raw, templatePath);
}

/**
 * Load every `.yaml` file in a directory and return a map keyed by the
 * lowercase, hyphenated agent name (e.g. "security-auditor").
 *
 * @param templatesDir - Directory containing `.yaml` template files.
 */
export async function loadAllTemplates(
  templatesDir: string,
): Promise<Map<string, AgentTemplate>> {
  const entries = await readdir(templatesDir);
  const yamlFiles = entries.filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );

  const templates = new Map<string, AgentTemplate>();

  for (const file of yamlFiles) {
    const fullPath = join(templatesDir, file);
    const template = await loadTemplate(fullPath);
    // Key is the lowercase, hyphenated name (e.g. "Security Auditor" -> "security-auditor")
    const key = template.name.toLowerCase().replace(/\s+/g, "-");
    templates.set(key, template);
  }

  return templates;
}

/**
 * Return the default templates directory.
 *
 * Points to `<package-root>/templates/domains/` so callers can iterate
 * over domain sub-directories.  The legacy `templates/agents/` path is
 * still readable via {@link loadAllTemplates} when passed explicitly.
 *
 * Works whether the code is running from `src/` (ts-node / tsx) or from
 * `dist/` (compiled JS).
 */
export function getDefaultTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // From src/builder/ or dist/builder/, go up two levels to package root.
  const packageRoot = join(dirname(thisFile), "..", "..");
  return join(packageRoot, "templates", "domains");
}

/**
 * Load agent templates organized by domain.
 *
 * Scans `domainsDir` for sub-directories that contain an `agents/`
 * folder, loads every `.yaml`/`.yml` file in each, and returns a
 * two-level map: `DomainId -> (agentKey -> AgentTemplate)`.
 *
 * @param domainsDir - Root directory containing domain sub-directories
 *   (e.g. `templates/domains/`).
 * @returns A map from domain id to a map of agent templates.
 */
export async function loadDomainTemplates(
  domainsDir: string,
): Promise<Map<DomainId, Map<string, AgentTemplate>>> {
  const result = new Map<DomainId, Map<string, AgentTemplate>>();

  const entries = await readdir(domainsDir);

  for (const entry of entries) {
    const domainPath = join(domainsDir, entry);
    const agentsPath = join(domainPath, "agents");

    // Skip entries that are not directories
    const domainStat = await stat(domainPath).catch(() => null);
    if (!domainStat?.isDirectory()) continue;

    // Skip domains that have no agents/ sub-directory
    const agentsStat = await stat(agentsPath).catch(() => null);
    if (!agentsStat?.isDirectory()) continue;

    const templates = await loadAllTemplates(agentsPath);
    if (templates.size > 0) {
      result.set(entry as DomainId, templates);
    }
  }

  return result;
}
