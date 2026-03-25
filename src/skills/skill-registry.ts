/**
 * Skill Registry — manages registration and lookup of structured skills.
 *
 * Provides methods to register skills, query them by name, category,
 * or domain, and resolve the set of skills available to a given agent
 * based on its domain and delegation graph.
 */

import type { Skill, SkillCategory } from "../types/skill.js";
import type { DomainId } from "../types/domain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal agent descriptor used to resolve available skills.
 *
 * Only the fields needed for skill resolution are required.
 */
export interface AgentSkillQuery {
  /** The domain the agent belongs to. */
  domain: DomainId;
  /** Additional domains the agent can access via delegation graph. */
  delegationDomains?: DomainId[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-memory registry of structured skills.
 *
 * Skills are indexed by name (unique), and can be queried by category
 * or domain. The {@link getAvailableSkills} method resolves which skills
 * an agent can use based on skill inheritance rules:
 *
 * 1. **Core skills** — available to all agents regardless of domain.
 * 2. **Domain skills** — available to agents within that domain.
 * 3. **Cross-domain skills** — available if the delegation graph connects
 *    the agent's domain to the skill's domain.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  /**
   * Register a skill. Throws if a skill with the same name already exists.
   */
  register(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      throw new Error(
        `Skill "${skill.name}" is already registered.`,
      );
    }
    this.skills.set(skill.name, skill);
  }

  /**
   * Retrieve a skill by its unique name.
   *
   * @returns The skill, or `undefined` if not found.
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Return all skills that belong to the given category.
   */
  getByCategory(category: SkillCategory): Skill[] {
    const result: Skill[] = [];
    for (const skill of this.skills.values()) {
      if (skill.category === category) {
        result.push(skill);
      }
    }
    return result;
  }

  /**
   * Return all skills that belong to the given domain.
   */
  getByDomain(domain: DomainId): Skill[] {
    const result: Skill[] = [];
    for (const skill of this.skills.values()) {
      if (skill.domain === domain) {
        result.push(skill);
      }
    }
    return result;
  }

  /**
   * Resolve the set of skills available to an agent based on skill
   * inheritance rules:
   *
   * 1. All "core" domain skills are always included.
   * 2. Skills from the agent's own domain are included.
   * 3. Skills from domains listed in `delegationDomains` are included.
   *
   * Duplicates are avoided by collecting into a Set of skill names.
   */
  getAvailableSkills(query: AgentSkillQuery): Skill[] {
    const allowedDomains = new Set<DomainId>();

    // Core skills are always available
    allowedDomains.add("core");

    // Agent's own domain
    allowedDomains.add(query.domain);

    // Cross-domain via delegation graph
    if (query.delegationDomains) {
      for (const d of query.delegationDomains) {
        allowedDomains.add(d);
      }
    }

    const result: Skill[] = [];
    for (const skill of this.skills.values()) {
      if (allowedDomains.has(skill.domain)) {
        result.push(skill);
      }
    }
    return result;
  }
}
