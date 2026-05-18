/**
 * agent-yaml-writer.ts
 *
 * Serializes an AgentYaml object to a YAML string using js-yaml.dump().
 *
 * MANDATORY: always use js-yaml.dump() — never template strings.
 * CodeQL flags template-string YAML as high-severity ReDoS.
 */

import yaml from "js-yaml";
import type { AgentYaml } from "./agent-yaml-schema.js";

/** Default js-yaml dump options shared across all agent YAML writes. */
const DUMP_OPTS: yaml.DumpOptions = {
  lineWidth: 120,
  noRefs: true,
};

/**
 * Serialize an `AgentYaml` object to a YAML string.
 *
 * The `output_schema` field is written verbatim when present.
 * Round-tripping via `js-yaml.load` then `dumpAgentYaml` produces
 * a deep-equal value (key order may differ).
 */
export function dumpAgentYaml(agent: AgentYaml): string {
  // Build a plain object to hand to js-yaml. We cast through unknown to
  // satisfy strict typing — the shape is identical to AgentYaml but with
  // undefined fields omitted so YAML output stays clean.
  const obj: Record<string, unknown> = {
    name: agent.name,
    model: agent.model,
  };

  // Only emit optional fields when they have a value, to keep YAML minimal.
  if (agent.team !== undefined) obj["team"] = agent.team;
  if (agent.effort !== undefined) obj["effort"] = agent.effort;
  if (agent.version !== undefined) obj["version"] = agent.version;
  if (agent.description !== undefined) obj["description"] = agent.description;

  obj["system_prompt"] = agent.system_prompt;

  if (agent.skills !== undefined) obj["skills"] = agent.skills;
  if (agent.triggers !== undefined) obj["triggers"] = agent.triggers;
  if (agent.collaboration !== undefined) obj["collaboration"] = agent.collaboration;
  if (agent.context !== undefined) obj["context"] = agent.context;
  if (agent.learnings !== undefined) obj["learnings"] = agent.learnings;
  if (agent.owns_subsystems !== undefined) obj["owns_subsystems"] = agent.owns_subsystems;
  if (agent.capability_tags !== undefined) obj["capability_tags"] = agent.capability_tags;
  if (agent.skill_ids !== undefined) obj["skill_ids"] = agent.skill_ids;

  // Pass output_schema through verbatim — js-yaml handles nested objects.
  if (agent.output_schema !== undefined) obj["output_schema"] = agent.output_schema;

  return yaml.dump(obj, DUMP_OPTS);
}
