// packages/core/src/scoring/rubric-v1.ts
//
// Rubric v1 — 9 deterministic criteria with weights.
// Each criterion produces a signal with a key, weight, and source.

// Signal is defined here (not in step-scorer) to avoid circular imports.
// deterministic-signals, llm-grader, and step-scorer all import Signal from here.
export interface Signal {
  key: string;
  value: number;
  source: 'deterministic' | 'llm-graded' | 'heuristic';
  weight: number;
  note?: string;
}

export interface RubricCriterion {
  key: string;
  weight: number;
  source: 'deterministic' | 'llm-graded' | 'heuristic';
  description: string;
}

export const RUBRIC_VERSION = 'v1';

export const RUBRIC_V1: RubricCriterion[] = [
  {
    key: 'schema.valid',
    weight: 0.20,
    source: 'deterministic',
    description: 'Wave 3 schema validation passed',
  },
  {
    key: 'schema.required_fields_present',
    weight: 0.12,
    source: 'deterministic',
    description: 'Required fields present ratio',
  },
  {
    key: 'files.in_scope',
    weight: 0.15,
    source: 'deterministic',
    description: 'Touched files within agent owns_subsystems',
  },
  {
    key: 'files.size_sane',
    weight: 0.10,
    source: 'deterministic',
    description: 'No diff > 2000 LoC unless refactor capability',
  },
  {
    key: 'tests.delta_nonneg',
    weight: 0.13,
    source: 'deterministic',
    description: 'Test passed count delta non-negative',
  },
  {
    key: 'tdd.red_green_observed',
    weight: 0.08,
    source: 'deterministic',
    description: 'Red/green TDD markers observed when af-tdd in skill_ids',
  },
  {
    key: 'verify.checks_run',
    weight: 0.08,
    source: 'deterministic',
    description: 'Explicit verification observed when af-verify-before-done in skill_ids',
  },
  {
    key: 'output.length_sane',
    weight: 0.07,
    source: 'deterministic',
    description: 'Raw output length between 50 and 50000 chars',
  },
  {
    key: 'output.no_placeholder_strings',
    weight: 0.07,
    source: 'deterministic',
    description: 'No TODO/FIXME/placeholder strings in parsed output',
  },
];

export function getRubricWeight(key: string): number {
  return RUBRIC_V1.find((c) => c.key === key)?.weight ?? 0;
}
