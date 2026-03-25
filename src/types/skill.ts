/**
 * Skill type definitions for the AgentForge v2 Universal Forge.
 *
 * Skills are first-class typed units that replace v1's free-form
 * skill strings. Each skill has a category, parameters, gates,
 * and composability rules.
 */

import type { DomainId } from "./domain.js";
import type { ModelTier } from "./agent.js";

/**
 * Broad functional category a skill belongs to.
 */
export type SkillCategory =
  | "research"
  | "analysis"
  | "creation"
  | "review"
  | "planning"
  | "communication";

/**
 * A typed parameter accepted by a skill.
 */
export interface SkillParameter {
  /** Parameter name. */
  name: string;
  /** Type descriptor (e.g. "string", "number", "string[]"). */
  type: string;
  /** Whether this parameter must be provided. */
  required: boolean;
  /** Default value used when the parameter is not provided. */
  default?: unknown;
}

/**
 * A structured, composable skill definition.
 *
 * Skills are the atomic units of work an agent can perform.
 * They are typed, parameterized, and gated for quality control.
 */
export interface Skill {
  /** Unique skill name. */
  name: string;
  /** Semantic version of this skill. */
  version: string;
  /** Functional category this skill belongs to. */
  category: SkillCategory;
  /** Domain this skill belongs to. */
  domain: DomainId;
  /** Preferred Claude model tier for running this skill. */
  model_preference: ModelTier;
  /** Human-readable description of what this skill does. */
  description: string;
  /** Typed parameters this skill accepts. */
  parameters: SkillParameter[];
  /** Pre- and post-execution gate checks. */
  gates: {
    /** Conditions that must be met before execution. */
    pre: string[];
    /** Conditions verified after execution. */
    post: string[];
  };
  /** Names of other skills this skill can be composed with. */
  composable_with: string[];
}
