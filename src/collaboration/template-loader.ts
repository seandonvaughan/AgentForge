/**
 * Collaboration Template Loader -- reads and parses YAML collaboration
 * templates into strongly-typed {@link CollaborationTemplate} objects.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import yaml from "js-yaml";

import type { CollaborationTemplate } from "../types/collaboration.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set([
  "hierarchy",
  "flat",
  "matrix",
  "hub-and-spoke",
  "custom",
]);

/**
 * Validate and normalise a raw parsed YAML document into a
 * {@link CollaborationTemplate}.
 */
function validateCollaborationTemplate(
  raw: unknown,
  sourcePath: string,
): CollaborationTemplate {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `Collaboration template at ${sourcePath} did not parse to an object.`,
    );
  }

  const doc = raw as Record<string, unknown>;

  if (typeof doc.name !== "string" || !doc.name) {
    throw new Error(
      `Collaboration template at ${sourcePath} is missing a "name" field.`,
    );
  }

  const type = (doc.type as string) ?? "custom";
  if (!VALID_TYPES.has(type)) {
    throw new Error(
      `Collaboration template "${doc.name}" has invalid type "${type}".`,
    );
  }

  const topology = doc.topology as Record<string, unknown> | undefined;
  const delegation = doc.delegation_rules as Record<string, unknown> | undefined;
  const communication = doc.communication as Record<string, unknown> | undefined;
  const escalation = doc.escalation as Record<string, unknown> | undefined;
  const loopLimits = doc.loop_limits as Record<string, unknown> | undefined;

  const gates = Array.isArray(
    (communication as Record<string, unknown> | undefined)?.gates,
  )
    ? (communication!.gates as Array<Record<string, unknown>>).map((g) => ({
        name: String(g.name ?? ""),
        type: (g.type as "hard-gate" | "soft-gate") ?? "hard-gate",
        rule: String(g.rule ?? ""),
      }))
    : [];

  return {
    name: doc.name as string,
    type: type as CollaborationTemplate["type"],
    description: String(doc.description ?? ""),
    topology: {
      root: topology?.root != null ? String(topology.root) : null,
      levels: Array.isArray(topology?.levels)
        ? (topology!.levels as Array<Record<string, unknown>>).map((l) => ({
            agents: Array.isArray(l.agents) ? (l.agents as string[]) : [],
            role: String(l.role ?? ""),
          }))
        : [],
    },
    delegation_rules: {
      direction:
        (delegation?.direction as "top-down" | "peer" | "any") ?? "top-down",
      cross_level: Boolean(delegation?.cross_level ?? false),
      peer_collaboration: Boolean(delegation?.peer_collaboration ?? false),
      review_flow:
        (delegation?.review_flow as "bottom-up" | "top-down" | "peer") ??
        "bottom-up",
    },
    communication: {
      patterns: Array.isArray(communication?.patterns)
        ? (communication!.patterns as string[])
        : [],
      gates,
    },
    escalation: {
      max_retries: Number(escalation?.max_retries ?? 3),
      escalate_to: String(escalation?.escalate_to ?? "root"),
      human_escalation: Boolean(escalation?.human_escalation ?? true),
    },
    loop_limits: {
      review_cycle: Number(loopLimits?.review_cycle ?? 3),
      delegation_depth: Number(loopLimits?.delegation_depth ?? 5),
      retry_same_agent: Number(loopLimits?.retry_same_agent ?? 2),
      total_actions: Number(loopLimits?.total_actions ?? 50),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single YAML collaboration template from disk.
 *
 * @param templatePath - Absolute or relative path to a `.yaml` file.
 * @returns A validated {@link CollaborationTemplate}.
 */
export async function loadCollaborationTemplate(
  templatePath: string,
): Promise<CollaborationTemplate> {
  const content = await readFile(templatePath, "utf-8");
  const raw = yaml.load(content);
  return validateCollaborationTemplate(raw, templatePath);
}

/**
 * Load every `.yaml` / `.yml` file in a directory and return a map keyed
 * by the template name.
 *
 * @param templatesDir - Directory containing `.yaml` collaboration files.
 */
export async function loadAllCollaborationTemplates(
  templatesDir: string,
): Promise<Map<string, CollaborationTemplate>> {
  const entries = await readdir(templatesDir);
  const yamlFiles = entries.filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );

  const templates = new Map<string, CollaborationTemplate>();

  for (const file of yamlFiles) {
    const fullPath = join(templatesDir, file);
    const template = await loadCollaborationTemplate(fullPath);
    templates.set(template.name, template);
  }

  return templates;
}
