/**
 * Barrel export for the skill system.
 *
 * Re-exports the skill loader, registry, and relevant types
 * for convenient access from other modules.
 */

export { loadSkill, loadDomainSkills } from "./skill-loader.js";
export { SkillRegistry } from "./skill-registry.js";
export type { AgentSkillQuery } from "./skill-registry.js";
