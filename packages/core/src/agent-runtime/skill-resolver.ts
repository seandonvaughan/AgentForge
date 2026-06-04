import type { Skill } from '@agentforge/skills-catalog';

export interface AgentSkillYamlFields {
  skill_ids?: unknown;
  skills?: unknown;
}

export interface ResolvedAgentSkill {
  id: string;
  version: string;
  tags: string[];
  appliesTo: string[];
  maxTokens: number;
  requiredTools: string[];
  filePath: string;
  upstream?: string;
  upstreamRef?: string;
}

export interface ResolvedAgentSkillWithBody extends ResolvedAgentSkill {
  body: string;
}

export interface AgentSkillResolution {
  skillIds: string[];
  resolvedSkills: ResolvedAgentSkillWithBody[];
  missingSkillIds: string[];
  requiredTools: string[];
}

export type SkillLoader = (id: string) => Skill | null;
export type SkillCatalogLoader = () => Skill[];

export const LEGACY_SKILL_ID_MAP: Readonly<Record<string, readonly string[]>> = {
  bug_fixing: ['af-tdd'],
  code_generation: ['af-tdd'],
  code_review: ['af-verify-before-done'],
  coverage_analysis: ['af-tdd'],
  evaluation: ['af-rubric-grade'],
  fixture_design: ['af-tdd'],
  mock_generation: ['af-tdd'],
  pr_review: ['af-verify-before-done'],
  refactoring: ['af-tdd'],
  rubric_grading: ['af-rubric-grade'],
  scoring: ['af-rubric-grade'],
  test_generation: ['af-tdd'],
  test_strategy: ['af-tdd'],
  verification: ['af-verify-before-done'],
};

export function resolveRequestedSkillIds(agent: AgentSkillYamlFields): string[] {
  if (Object.prototype.hasOwnProperty.call(agent, 'skill_ids')) {
    return uniqueStrings(toStringArray(agent.skill_ids));
  }

  const mapped: string[] = [];
  for (const legacySkill of toStringArray(agent.skills)) {
    mapped.push(...(LEGACY_SKILL_ID_MAP[legacySkill] ?? []));
  }
  return uniqueStrings(mapped);
}

export function resolveAgentSkills(
  agent: AgentSkillYamlFields,
  loadSkill: SkillLoader,
  agentId?: string,
  listAllSkills?: SkillCatalogLoader,
): AgentSkillResolution {
  const skillIds = resolveRequestedSkillIds(agent);
  const resolvedSkills: ResolvedAgentSkillWithBody[] = [];
  const missingSkillIds: string[] = [];
  const seenSkillIds = new Set(skillIds);

  for (const id of skillIds) {
    const skill = loadSkill(id);
    if (!skill) {
      missingSkillIds.push(id);
      continue;
    }
    resolvedSkills.push(toResolvedSkill(skill));
  }

  if (agentId && listAllSkills) {
    for (const skill of listAllSkills()) {
      const id = skill.frontmatter.id;
      if (seenSkillIds.has(id) || !skill.frontmatter.mandatory_for?.includes(agentId)) {
        continue;
      }
      seenSkillIds.add(id);
      skillIds.push(id);
      resolvedSkills.push(toResolvedSkill(skill));
    }
  }

  return {
    skillIds,
    resolvedSkills,
    missingSkillIds,
    requiredTools: collectRequiredTools(resolvedSkills),
  };
}

export function collectRequiredTools(skills: Array<{ requiredTools: string[] }>): string[] {
  return [...new Set(skills.flatMap((skill) => skill.requiredTools).filter((tool) => tool !== 'Task'))]
    .sort((a, b) => a.localeCompare(b));
}

function toResolvedSkill(skill: Skill): ResolvedAgentSkillWithBody {
  return {
    id: skill.frontmatter.id,
    version: skill.frontmatter.version,
    tags: [...skill.frontmatter.tags],
    appliesTo: [...skill.frontmatter.applies_to],
    maxTokens: skill.frontmatter.max_tokens,
    requiredTools: [...(skill.frontmatter.requires_tools ?? [])],
    filePath: skill.filePath,
    ...(skill.frontmatter.upstream ? { upstream: skill.frontmatter.upstream } : {}),
    ...(skill.frontmatter.upstream_ref ? { upstreamRef: skill.frontmatter.upstream_ref } : {}),
    body: skill.body,
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
