/**
 * agent-template-writer.ts
 *
 * Builds an AgentTemplate-compatible YAML object from a `TeamPlanAgent` and
 * writes it to disk using js-yaml.dump().
 *
 * This module wraps the inline `buildAgentYaml` logic that previously lived
 * directly in synthesis.ts, making it importable and testable in isolation.
 *
 * MANDATORY: use js-yaml.dump() only — no template strings.
 */

import yaml from "js-yaml";
import type { TeamPlanAgent } from "./synthesis.js";

/** Default dump options for agent template YAML files. */
const DUMP_OPTS: yaml.DumpOptions = {
  lineWidth: 120,
  noRefs: true,
  sortKeys: false,
};

/** Map an agent tier to its default reasoning-effort level. */
function defaultEffortFor(tier: "fable" | "opus" | "sonnet" | "haiku"): string {
  if (tier === "fable") return "xhigh";
  if (tier === "opus") return "xhigh";
  if (tier === "sonnet") return "high";
  return "medium";
}

/**
 * Build an AgentTemplate-compatible plain object for an agent.
 *
 * The `output_schema` field is copied verbatim when present so YAML
 * round-trips are byte-equivalent (deep-equal; key order may differ).
 *
 * When `category === "implementation"` and `output_schema` is absent, a
 * warning is logged but execution continues (backward compat).
 */
export function buildAgentTemplateObject(agent: TeamPlanAgent): Record<string, unknown> {
  if (agent.category === "implementation" && !agent.output_schema) {
    console.warn(
      `[agent-template-writer] implementation agent "${agent.id}" is missing ` +
        `output_schema — consider adding a structured return-value contract.`,
    );
  }

  const obj: Record<string, unknown> = {
    name: agent.id,
    model: agent.tier,
    team: agent.category,
    effort: defaultEffortFor(agent.tier),
    version: "1.0",
    description: agent.capability_tags.slice(0, 5).join(", "),
    system_prompt: agent.system_prompt,
    skills: agent.capability_tags,
    triggers: {
      file_patterns: [],
      keywords: agent.capability_tags,
    },
    collaboration: {
      reports_to: agent.category === "strategic" ? null : "architect",
      reviews_from: [],
      can_delegate_to: [],
      parallel: true,
    },
    context: {
      max_files: 30,
      auto_include: agent.auto_include_files,
      project_specific: agent.owns_subsystems,
    },
    learnings: agent.learnings_seed,
    owns_subsystems: agent.owns_subsystems,
    capability_tags: agent.capability_tags,
    ...(agent.skill_ids && agent.skill_ids.length > 0 ? { skill_ids: agent.skill_ids } : {}),
  };

  // Copy output_schema verbatim — js-yaml.dump handles the nested structure.
  if (agent.output_schema !== undefined) {
    obj["output_schema"] = agent.output_schema;
  }

  return obj;
}

/**
 * Serialize an agent to AgentTemplate-compatible YAML string.
 *
 * Uses js-yaml.dump() exclusively (CodeQL ReDoS requirement).
 */
export function dumpAgentTemplate(agent: TeamPlanAgent): string {
  return yaml.dump(buildAgentTemplateObject(agent), DUMP_OPTS);
}
