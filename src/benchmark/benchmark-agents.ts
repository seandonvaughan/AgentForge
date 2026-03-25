/**
 * Benchmark agent templates for the v3 launch gate validation.
 *
 * Three agents at different tiers to exercise the cost routing pipeline.
 * In v2: tasks always run on the agent's configured tier.
 * In v3: CostAwareRunner may route tasks to cheaper tiers.
 */

import type { AgentTemplate } from "../types/agent.js";

/** High-tier agent — handles complex architectural tasks. */
export const BENCHMARK_ARCHITECT: AgentTemplate = {
  name: "benchmark-architect",
  model: "opus",
  effort: "high",
  version: "3.0",
  description: "Benchmark agent for complex architectural and design tasks.",
  system_prompt:
    "You are a senior software architect. Provide concise, well-structured responses. " +
    "Focus on correctness and clarity. Keep responses under 300 words unless the task demands more.",
  skills: ["architecture", "design", "analysis"],
  triggers: { file_patterns: [], keywords: [] },
  collaboration: {
    reports_to: null,
    reviews_from: [],
    can_delegate_to: [],
    parallel: false,
  },
  context: { max_files: 10, auto_include: [], project_specific: [] },
  category: "strategic",
};

/** Medium-tier agent — handles implementation and review tasks. */
export const BENCHMARK_DEVELOPER: AgentTemplate = {
  name: "benchmark-developer",
  model: "sonnet",
  effort: "medium",
  version: "3.0",
  description: "Benchmark agent for implementation, review, and analysis tasks.",
  system_prompt:
    "You are a software developer. Write clean, correct code. " +
    "Keep explanations brief. Focus on the task at hand.",
  skills: ["coding", "review", "testing"],
  triggers: { file_patterns: [], keywords: [] },
  collaboration: {
    reports_to: null,
    reviews_from: [],
    can_delegate_to: [],
    parallel: false,
  },
  context: { max_files: 10, auto_include: [], project_specific: [] },
  category: "implementation",
};

/** Low-tier agent — handles simple, mechanical tasks. */
export const BENCHMARK_UTILITY: AgentTemplate = {
  name: "benchmark-utility",
  model: "haiku",
  effort: "low",
  version: "3.0",
  description: "Benchmark agent for simple formatting, generation, and utility tasks.",
  system_prompt:
    "You are a utility assistant. Complete tasks quickly and accurately. " +
    "Keep responses minimal and to the point.",
  skills: ["formatting", "generation", "conversion"],
  triggers: { file_patterns: [], keywords: [] },
  collaboration: {
    reports_to: null,
    reviews_from: [],
    can_delegate_to: [],
    parallel: false,
  },
  context: { max_files: 10, auto_include: [], project_specific: [] },
  category: "utility",
};

/** All benchmark agents indexed by tier for easy lookup. */
export const BENCHMARK_AGENTS = {
  opus: BENCHMARK_ARCHITECT,
  sonnet: BENCHMARK_DEVELOPER,
  haiku: BENCHMARK_UTILITY,
} as const;
