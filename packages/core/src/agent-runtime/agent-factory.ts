import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from './types.js';
import type { ModelTier } from '@agentforge/shared';
import type { WorkspaceAdapter } from '@agentforge/db';
import { injectFreshContext } from './fresh-context.js';
import { AgentOutputSchemaSchema } from '../team/agent-yaml/agent-yaml-schema.js';
import type { AgentOutputSchema } from '../runtime/types.js';
import { resolveAgentSkills } from './skill-resolver.js';
import type { AgentSkillResolution, SkillLoader } from './skill-resolver.js';

/**
 * Thrown by the agent factory when an agent has `output_schema.strict: true`
 * and the transport reports that schema validation failed.
 *
 * Exported so callers can distinguish schema failures from other runtime errors.
 */
export class SchemaValidationError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly schemaName: string,
    public readonly validationError: string,
    public readonly rawOutput: string,
  ) {
    super(
      `SchemaValidationError [${agentId}]: output did not satisfy schema "${schemaName}": ${validationError}`,
    );
    this.name = 'SchemaValidationError';
  }
}

interface AgentYaml {
  name?: string;
  model?: string;
  system_prompt?: string;
  role?: string;
  effort?: string;
  skill_ids?: unknown;
  skills?: unknown;
  learnings?: unknown;
  // T4 — structured output schema declaration
  output_schema?: unknown;
}

export interface LoadAgentConfigOptions {
  /**
   * When true (default), append a "Fresh Context (this cycle)" section to the
   * system prompt with the most-relevant recent memory entries for this agent.
   * Set to false in tests or when bypass is desired.
   */
  injectFreshContext?: boolean;
  /**
   * Optional workspace adapter. When provided, undelivered DMs for `agentId`
   * are pulled and appended to the system prompt as a `## Direct Messages`
   * section (ADR 0001). Without an adapter the helpers exist but no
   * production code path actually delivers DMs to running agents — this hook
   * is what closes the loop for Phase 2 of the comms spec.
   */
  adapter?: WorkspaceAdapter;
}

/**
 * Resolve skill ids and build prompt metadata. Missing skill ids are skipped
 * with a warning — they must never throw or block a cycle.
 */
async function resolveSkills(agent: AgentYaml): Promise<AgentSkillResolution> {
  const skillIds = Array.isArray(agent.skill_ids) ? agent.skill_ids : undefined;
  const legacySkills = Array.isArray(agent.skills) ? agent.skills : undefined;
  const empty = resolveAgentSkills(
    {
      ...(Object.prototype.hasOwnProperty.call(agent, 'skill_ids') ? { skill_ids: skillIds } : {}),
      ...(legacySkills ? { skills: legacySkills } : {}),
    },
    () => null,
  );

  if (empty.skillIds.length === 0) return empty;

  // Dynamically import to avoid circular deps and keep startup cost zero when
  // no skills are requested.
  let loadSkill: SkillLoader | null = null;
  try {
    const catalog = await import('@agentforge/skills-catalog');
    loadSkill = catalog.loadSkill;
  } catch {
    // skills-catalog not available (e.g. not yet built in some CI shards)
    console.warn('[agent-factory] @agentforge/skills-catalog not available — skipping skills injection');
    return empty;
  }

  const resolved = resolveAgentSkills(agent, loadSkill);
  for (const id of resolved.missingSkillIds) {
    console.warn(`[agent-factory] Skill "${id}" not found in catalog — skipping`);
  }

  return resolved;
}

function buildSkillsSection(resolution: AgentSkillResolution): string {
  const bodies = resolution.resolvedSkills.map((skill) => skill.body);
  if (bodies.length === 0) return '';

  return ['## Skills', bodies.join('\n\n---\n\n')].join('\n') + '\n';
}

function buildLearningsSection(learnings: unknown[]): string {
  const cleaned = learnings
    .map((lesson) => typeof lesson === 'string'
      ? Array.from(lesson)
        .map((ch) => {
          const code = ch.charCodeAt(0);
          return code < 32 || code === 127 ? ' ' : ch;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      : '')
    .filter((lesson) => lesson.length > 0);

  if (cleaned.length === 0) return '';

  return ['## Learnings', cleaned.map((lesson) => `- ${lesson}`).join('\n')].join('\n') + '\n';
}

export async function loadAgentConfig(
  agentId: string,
  agentforgeDir: string,
  options: LoadAgentConfigOptions = {},
): Promise<AgentRuntimeConfig | null> {
  try {
    // Dynamically import js-yaml
    const yaml = await import('js-yaml');
    const raw = await readFile(join(agentforgeDir, 'agents', `${agentId}.yaml`), 'utf-8');
    const parsed = yaml.load(raw) as AgentYaml;

    const modelMap: Record<string, ModelTier> = {
      opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
    };

    const baseSystemPrompt =
      parsed.system_prompt ?? `You are ${parsed.name ?? agentId}, an AI agent.`;

    // --- Skills injection ---
    // Splice order:
    //   [base system_prompt]
    //   ## Skills
    //   <skill bodies separated by ---> (if any)
    //   ## Fresh Context / ## Direct Messages  ← injectFreshContext handles these
    const skillResolution = await resolveSkills(parsed);
    const skillsSection = buildSkillsSection(skillResolution);
    const learnings = Array.isArray(parsed.learnings) ? parsed.learnings : [];
    const learningsSection = buildLearningsSection(learnings);

    const promptWithSkills = skillsSection
      ? `${baseSystemPrompt.trimEnd()}\n\n${skillsSection}`
      : baseSystemPrompt;
    const promptWithLearnings = learningsSection
      ? `${promptWithSkills.trimEnd()}\n\n${learningsSection}`
      : promptWithSkills;

    // --- Fresh context + DMs injection ---
    const shouldInject = options.injectFreshContext !== false;
    const systemPrompt = shouldInject
      ? injectFreshContext(
          promptWithLearnings,
          agentId,
          agentforgeDir,
          options.adapter ? { adapter: options.adapter } : undefined,
        )
      : promptWithLearnings;

    const outputSchema = parseOutputSchema(agentId, parsed.output_schema);

    return {
      agentId,
      name: parsed.name ?? agentId,
      model: modelMap[parsed.model ?? 'sonnet'] ?? 'sonnet',
      systemPrompt,
      workspaceId: 'default',
      skillIds: skillResolution.skillIds,
      resolvedSkills: skillResolution.resolvedSkills.map(({ body: _body, ...metadata }) => metadata),
      missingSkillIds: skillResolution.missingSkillIds,
      requiredTools: skillResolution.requiredTools,
      ...(parsed.effort && { effort: parsed.effort }),
      // T4 — carry output_schema through so the execute-phase dispatch loop
      // can attach it to the RunRequest and validate results on return.
      ...(outputSchema ? { outputSchema } : {}),
    };
  } catch {
    return null;
  }
}

function parseOutputSchema(agentId: string, value: unknown): AgentOutputSchema | undefined {
  if (value === undefined) return undefined;

  const parsed = AgentOutputSchemaSchema.safeParse(value);
  if (!parsed.success) {
    console.warn(
      `[agent-factory] Agent "${agentId}" has invalid output_schema; structured validation disabled.`,
    );
    return undefined;
  }

  const data = parsed.data;
  const schema: AgentOutputSchema['schema'] = {
    type: 'object',
    properties: data.schema.properties,
    ...(data.schema.required !== undefined ? { required: data.schema.required } : {}),
    ...(data.schema.additionalProperties !== undefined
      ? { additionalProperties: data.schema.additionalProperties }
      : {}),
  };

  return {
    name: data.name,
    schema,
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.strict !== undefined ? { strict: data.strict } : {}),
  };
}

/**
 * T4 — Validates a RunResult against an agent's declared output_schema.
 *
 * - If `schemaValidation.ok === false` AND `schema.strict === true`, throws
 *   `SchemaValidationError`.
 * - Otherwise returns the raw response string unchanged.
 *
 * Callers that want the parsed JSON object should call `JSON.parse()` on the
 * return value when `schemaValidation.ok === true`.
 */
export function assertSchemaValidation(
  agentId: string,
  schema: AgentOutputSchema,
  result: {
    response: string;
    schemaValidation?: { ok: boolean; error?: string };
  },
): string {
  const sv = result.schemaValidation;
  // No transport-level validation info — treat as unvalidated (pass-through).
  if (!sv) return result.response;

  if (!sv.ok && schema.strict === true) {
    throw new SchemaValidationError(
      agentId,
      schema.name,
      sv.error ?? 'unknown validation error',
      result.response,
    );
  }

  return result.response;
}
