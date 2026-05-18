import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from './types.js';
import type { ModelTier } from '@agentforge/shared';
import type { WorkspaceAdapter } from '@agentforge/db';
import { injectFreshContext } from './fresh-context.js';

/**
 * Schema descriptor attached to an agent YAML via the `output_schema` field.
 * When present, the agent is expected to emit structured JSON on every run.
 *
 * T4 — inlined with TODO pending T1/T2 merge onto origin/main.
 */
interface AgentOutputSchema {
  /** Human-readable schema name used in error messages and ValidatedJsonOutput. */
  name: string;
  /**
   * When true, a failed schema validation throws SchemaValidationError instead
   * of returning the raw text. When false (default), the run still succeeds
   * even if the output cannot be parsed as JSON.
   */
  strict?: boolean;
  /** Optional JSON Schema object for structural validation (not enforced here —
   *  transport-layer validation populates RunResult.schemaValidation). */
  schema?: Record<string, unknown>;
}

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
  skill_ids?: string[];
  // T4 — structured output schema declaration
  output_schema?: AgentOutputSchema;
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
 * Build a `## Skills` section from the given skill ids.
 *
 * Missing skill ids are skipped with a warning — they must never throw or
 * block a cycle. Returns an empty string when no skills are found.
 */
async function buildSkillsSection(skillIds: string[]): Promise<string> {
  if (skillIds.length === 0) return '';

  // Dynamically import to avoid circular deps and keep startup cost zero when
  // no skills are requested.
  let loadSkill: ((id: string) => import('@agentforge/skills-catalog').Skill | null) | null = null;
  try {
    const catalog = await import('@agentforge/skills-catalog');
    loadSkill = catalog.loadSkill;
  } catch {
    // skills-catalog not available (e.g. not yet built in some CI shards)
    console.warn('[agent-factory] @agentforge/skills-catalog not available — skipping skills injection');
    return '';
  }

  const bodies: string[] = [];
  for (const id of skillIds) {
    const skill = loadSkill(id);
    if (!skill) {
      console.warn(`[agent-factory] Skill "${id}" not found in catalog — skipping`);
      continue;
    }
    bodies.push(skill.body);
  }

  if (bodies.length === 0) return '';

  return ['## Skills', bodies.join('\n\n---\n\n')].join('\n') + '\n';
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
    const skillIds: string[] = parsed.skill_ids ?? [];
    const skillsSection = await buildSkillsSection(skillIds);

    const promptWithSkills = skillsSection
      ? `${baseSystemPrompt.trimEnd()}\n\n${skillsSection}`
      : baseSystemPrompt;

    // --- Fresh context + DMs injection ---
    const shouldInject = options.injectFreshContext !== false;
    const systemPrompt = shouldInject
      ? injectFreshContext(
          promptWithSkills,
          agentId,
          agentforgeDir,
          options.adapter ? { adapter: options.adapter } : undefined,
        )
      : promptWithSkills;

    return {
      agentId,
      name: parsed.name ?? agentId,
      model: modelMap[parsed.model ?? 'sonnet'] ?? 'sonnet',
      systemPrompt,
      workspaceId: 'default',
      ...(parsed.effort && { effort: parsed.effort }),
      // T4 — carry output_schema through so the execute-phase dispatch loop
      // can attach it to the RunRequest and validate results on return.
      ...(parsed.output_schema && { outputSchema: parsed.output_schema }),
    };
  } catch {
    return null;
  }
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
