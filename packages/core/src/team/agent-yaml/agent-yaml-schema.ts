/**
 * agent-yaml-schema.ts
 *
 * Zod schema for a single `.agentforge/agents/<id>.yaml` file.
 *
 * NOTE: AgentOutputSchemaSchema is inlined here temporarily pending the T1
 * merge that adds it to `@agentforge/shared`. Once T1 lands, replace the
 * inline definition with:
 *
 *   import { AgentOutputSchemaSchema } from '@agentforge/shared';
 *
 * TODO(T1-merge): swap to shared import.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// AgentOutputSchemaSchema — describes a structured return-value contract for
// an implementation-tier agent.  Sourced from the T1 Wave-3 shared contract.
// ---------------------------------------------------------------------------

export const AgentOutputSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schema: z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
    })
    .passthrough(),
  strict: z.boolean().default(true),
});

export type AgentOutputSchema = z.infer<typeof AgentOutputSchemaSchema>;

// ---------------------------------------------------------------------------
// AgentYaml — the full schema for a single agent YAML file.
// ---------------------------------------------------------------------------

export const AgentYamlSchema = z.object({
  name: z.string().min(1),
  model: z.enum(["fable", "opus", "sonnet", "haiku"]),
  team: z.string().optional(),
  effort: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  system_prompt: z.string().min(1),
  skills: z.array(z.string()).optional(),
  // Claude Code tool names mirrored into .claude/agents/<id>.md frontmatter.
  tools: z.array(z.string()).optional(),
  triggers: z
    .object({
      file_patterns: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
    })
    .optional(),
  collaboration: z
    .object({
      reports_to: z.string().nullable().optional(),
      reviews_from: z.array(z.string()).optional(),
      can_delegate_to: z.array(z.string()).optional(),
      parallel: z.boolean().optional(),
    })
    .optional(),
  context: z
    .object({
      max_files: z.number().optional(),
      auto_include: z.array(z.string()).optional(),
      project_specific: z.array(z.string()).optional(),
    })
    .optional(),
  learnings: z.array(z.string()).optional(),
  owns_subsystems: z.array(z.string()).optional(),
  capability_tags: z.array(z.string()).optional(),
  skill_ids: z.array(z.string()).optional(),
  // Structured output contract for implementation-tier agents.
  output_schema: AgentOutputSchemaSchema.optional(),
});

export type AgentYaml = z.infer<typeof AgentYamlSchema>;
