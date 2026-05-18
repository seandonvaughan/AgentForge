/**
 * tests/team/agent-yaml/output-schema-roundtrip.test.ts
 *
 * Verifies that the `output_schema` field survives a full YAML round-trip:
 *   AgentYaml object → dumpAgentYaml() → js-yaml.load() → AgentYamlSchema.parse()
 *
 * The parsed result must deep-equal the original input (key order may differ).
 */

import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import {
  AgentYamlSchema,
  AgentOutputSchemaSchema,
  type AgentYaml,
  type AgentOutputSchema,
} from "../../../packages/core/src/team/agent-yaml/agent-yaml-schema.js";
import { dumpAgentYaml } from "../../../packages/core/src/team/agent-yaml/agent-yaml-writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_OUTPUT_SCHEMA: AgentOutputSchema = {
  name: "fastify-engineer-result",
  description: "Structured return value for the Fastify v5 engineer",
  schema: {
    type: "object",
    properties: {
      files_modified: { type: "array", items: { type: "string" } },
      tests_added: { type: "integer" },
      lines_changed: { type: "integer" },
      routes_added: { type: "integer" },
    },
    required: ["files_modified"],
    additionalProperties: false,
  },
  strict: true,
};

const SAMPLE_AGENT_WITH_OUTPUT_SCHEMA: AgentYaml = {
  name: "fastify-v5-engineer",
  model: "sonnet",
  team: "implementation",
  effort: "high",
  version: "1.0",
  description: "fastify-route, zod-schema, vitest, typescript, esm",
  system_prompt:
    "You are the Fastify v5 engineer for AgentForge. Your primary files are\n" +
    "`packages/server/src/routes/v5/index.ts` and `packages/server/src/server.ts`.",
  skills: ["fastify-route", "zod-schema", "vitest"],
  owns_subsystems: ["packages/server"],
  capability_tags: ["fastify-route", "zod-schema", "vitest", "typescript", "esm"],
  learnings: ["Always use execFile instead of exec for subprocess calls"],
  output_schema: SAMPLE_OUTPUT_SCHEMA,
};

const SAMPLE_AGENT_WITHOUT_OUTPUT_SCHEMA: AgentYaml = {
  name: "memory-curator",
  model: "haiku",
  team: "utility",
  effort: "medium",
  version: "1.0",
  description: "jsonl, memory, deduplication",
  system_prompt:
    "You are the memory curator for AgentForge. Your primary files are\n" +
    "`.agentforge/memory/` and `packages/core/src/team/engine/learnings/curator.ts`.",
  skills: ["jsonl", "memory"],
  owns_subsystems: [".agentforge/memory"],
  capability_tags: ["jsonl", "memory", "deduplication"],
  learnings: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(agent: AgentYaml): AgentYaml {
  const yamlString = dumpAgentYaml(agent);
  const parsed = parseYaml(yamlString);
  return AgentYamlSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentYaml output_schema round-trip", () => {
  it("preserves output_schema through YAML serialisation and re-parse", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);

    expect(result.output_schema).toBeDefined();
    expect(result.output_schema?.name).toBe(SAMPLE_OUTPUT_SCHEMA.name);
    expect(result.output_schema?.description).toBe(SAMPLE_OUTPUT_SCHEMA.description);
    expect(result.output_schema?.strict).toBe(true);
  });

  it("deep-equals the original output_schema after round-trip", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    expect(result.output_schema).toEqual(SAMPLE_OUTPUT_SCHEMA);
  });

  it("preserves schema.properties after round-trip", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    const props = result.output_schema?.schema.properties ?? {};
    expect(Object.keys(props)).toContain("files_modified");
    expect(Object.keys(props)).toContain("tests_added");
    expect(Object.keys(props)).toContain("lines_changed");
    expect(Object.keys(props)).toContain("routes_added");
  });

  it("preserves schema.required after round-trip", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    expect(result.output_schema?.schema.required).toEqual(["files_modified"]);
  });

  it("preserves schema.additionalProperties after round-trip", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    expect(result.output_schema?.schema.additionalProperties).toBe(false);
  });

  it("preserves all other AgentYaml fields when output_schema is present", () => {
    const result = roundTrip(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    expect(result.name).toBe(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA.name);
    expect(result.model).toBe(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA.model);
    expect(result.system_prompt).toBe(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA.system_prompt);
    expect(result.capability_tags).toEqual(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA.capability_tags);
  });

  it("round-trips agent without output_schema (output_schema is undefined)", () => {
    const result = roundTrip(SAMPLE_AGENT_WITHOUT_OUTPUT_SCHEMA);
    expect(result.output_schema).toBeUndefined();
    expect(result.name).toBe(SAMPLE_AGENT_WITHOUT_OUTPUT_SCHEMA.name);
    expect(result.model).toBe(SAMPLE_AGENT_WITHOUT_OUTPUT_SCHEMA.model);
  });

  it("dumpAgentYaml uses js-yaml (no template strings) — YAML is parseable", () => {
    // If template strings were used, corner-cases like colons in system_prompt
    // would produce malformed YAML. js-yaml.dump correctly quotes them.
    const yamlString = dumpAgentYaml(SAMPLE_AGENT_WITH_OUTPUT_SCHEMA);
    expect(() => parseYaml(yamlString)).not.toThrow();
  });

  it("AgentOutputSchemaSchema validates a minimal output_schema", () => {
    const minimal = {
      name: "my-agent-result",
      schema: {
        type: "object" as const,
        properties: {
          files_modified: { type: "array" },
        },
      },
    };
    const result = AgentOutputSchemaSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    // strict defaults to true
    expect(result.data?.strict).toBe(true);
  });

  it("AgentOutputSchemaSchema rejects schema without type:object", () => {
    const bad = {
      name: "bad-schema",
      schema: {
        type: "array",
        items: { type: "string" },
      },
    };
    const result = AgentOutputSchemaSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
