import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from './types.js';
import type { ModelTier } from '@agentforge/shared';
import type { WorkspaceAdapter } from '@agentforge/db';
import { injectFreshContext } from './fresh-context.js';

interface AgentYaml {
  name?: string;
  model?: string;
  system_prompt?: string;
  role?: string;
  effort?: string;
  skill_ids?: string[];
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
    };
  } catch {
    return null;
  }
}
