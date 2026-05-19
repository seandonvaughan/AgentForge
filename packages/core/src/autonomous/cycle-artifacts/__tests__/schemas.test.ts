// packages/core/src/autonomous/cycle-artifacts/__tests__/schemas.test.ts
//
// Tests for cycle artifact Zod schemas.
// Covers: happy path, missing required fields, unknown fields (passthrough),
// nullish fields, and all 6 schemas.

import { describe, it, expect } from 'vitest';
import {
  CycleJsonSchema,
  PlanJsonSchema,
  GateJsonSchema,
  ReviewJsonSchema,
  ScoringJsonSchema,
  ExecutePhaseSchema,
  validateCycleJson,
  validatePlanJson,
  validateGateJson,
  validateReviewJson,
  validateScoringJson,
  validateExecutePhase,
} from '../schemas.js';

// ---------------------------------------------------------------------------
// Real fixture from .agentforge/cycles/9a567161-540f-482d-a5fe-a7e98515930f/
// ---------------------------------------------------------------------------

const REAL_CYCLE_FIXTURE = {
  cycleId: '9a567161-540f-482d-a5fe-a7e98515930f',
  sprintVersion: '10.2.1',
  stage: 'completed',
  startedAt: '2026-04-11T00:47:08.559Z',
  completedAt: '2026-04-11T01:18:50.284Z',
  durationMs: 1901725,
  cost: {
    totalUsd: 0.11307149999999999,
    budgetUsd: 200,
    byAgent: {},
    byPhase: {},
  },
  tests: {
    passed: 5492,
    failed: 43,
    skipped: 0,
    total: 5535,
    passRate: 0.9922312556458898,
    newFailures: [],
  },
  git: {
    branch: 'autonomous/v10.2.1',
    commitSha: 'f0bde160c8ae98c6b6091de5653478186fe53f18',
    filesChanged: ['.agentforge/memory/gate-verdict.jsonl'],
  },
  pr: {
    url: 'https://github.com/seandonvaughan/AgentForge/pull/12',
    number: 12,
    draft: false,
  },
  gateVerdict: 'APPROVE',
};

// ---------------------------------------------------------------------------
// 1. CycleJsonSchema
// ---------------------------------------------------------------------------

describe('CycleJsonSchema', () => {
  it('accepts a real cycle.json fixture', () => {
    const result = CycleJsonSchema.safeParse(REAL_CYCLE_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('accepts cycle.json with extra unknown fields (passthrough)', () => {
    const withExtra = { ...REAL_CYCLE_FIXTURE, experimentalField: 'future-value', nestedNew: { a: 1 } };
    const result = CycleJsonSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      // Extra fields are preserved by passthrough
      expect((result.data as Record<string, unknown>).experimentalField).toBe('future-value');
    }
  });

  it('rejects cycle.json missing required cycleId', () => {
    const { cycleId: _dropped, ...without } = REAL_CYCLE_FIXTURE;
    const result = CycleJsonSchema.safeParse(without);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('cycleId');
    }
  });

  it('rejects cycle.json missing required stage', () => {
    const { stage: _dropped, ...without } = REAL_CYCLE_FIXTURE;
    const result = CycleJsonSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('accepts cycle.json where nullish fields (git, pr, gateVerdict) are null', () => {
    const withNulls = { ...REAL_CYCLE_FIXTURE, git: null, pr: null, gateVerdict: null };
    const result = CycleJsonSchema.safeParse(withNulls);
    expect(result.success).toBe(true);
  });

  it('validateCycleJson returns parsed data for valid input', () => {
    const data = validateCycleJson(REAL_CYCLE_FIXTURE);
    expect(data).toBeDefined();
    expect(data?.cycleId).toBe('9a567161-540f-482d-a5fe-a7e98515930f');
  });

  it('validateCycleJson returns undefined (not throws) for invalid input', () => {
    expect(() => {
      const result = validateCycleJson({ cycleId: 'not-a-uuid', stage: 'unknown' });
      expect(result).toBeUndefined();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. PlanJsonSchema
// ---------------------------------------------------------------------------

const MINIMAL_PLAN = {
  items: [
    {
      id: 'item-001',
      title: 'Do the thing',
      priority: 'P0',
      assignee: 'coder',
      tags: ['core'],
    },
  ],
};

describe('PlanJsonSchema', () => {
  it('accepts a minimal plan with items array', () => {
    const result = PlanJsonSchema.safeParse(MINIMAL_PLAN);
    expect(result.success).toBe(true);
  });

  it('rejects plan missing items array', () => {
    const result = PlanJsonSchema.safeParse({ version: '1.0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('items');
    }
  });

  it('accepts plan where optional fields are absent', () => {
    const result = PlanJsonSchema.safeParse({ items: [] });
    expect(result.success).toBe(true);
  });

  it('accepts extra unknown fields on items (passthrough)', () => {
    const withExtra = {
      items: [{ id: 'x', title: 'Y', futureField: 42 }],
      topLevelExtra: 'ok',
    };
    const result = PlanJsonSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
  });

  it('validatePlanJson returns data for valid input', () => {
    const data = validatePlanJson(MINIMAL_PLAN);
    expect(data).toBeDefined();
    expect(data?.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. GateJsonSchema
// ---------------------------------------------------------------------------

const GATE_FAILED_FIXTURE = {
  phase: 'gate',
  error: 'findings for retry: compile errors in search.ts',
  status: 'failed',
};

const GATE_APPROVED_FIXTURE = {
  phase: 'gate',
  verdict: 'APPROVE',
  rationale: 'All tests pass. No blocking issues.',
  findings: [],
  status: 'completed',
  durationMs: 30000,
  costUsd: 0.12,
};

describe('GateJsonSchema', () => {
  it('accepts a failed gate (error + status only, no verdict)', () => {
    const result = GateJsonSchema.safeParse(GATE_FAILED_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('accepts a fully approved gate', () => {
    const result = GateJsonSchema.safeParse(GATE_APPROVED_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('rejects gate missing phase literal', () => {
    const result = GateJsonSchema.safeParse({ verdict: 'APPROVE' });
    expect(result.success).toBe(false);
  });

  it('accepts null verdict (failed gate has no verdict)', () => {
    const result = GateJsonSchema.safeParse({ phase: 'gate', verdict: null, error: 'oops' });
    expect(result.success).toBe(true);
  });

  it('validateGateJson returns data for valid input', () => {
    const data = validateGateJson(GATE_FAILED_FIXTURE);
    expect(data).toBeDefined();
    expect(data?.phase).toBe('gate');
  });
});

// ---------------------------------------------------------------------------
// 4. ReviewJsonSchema
// ---------------------------------------------------------------------------

const REVIEW_FIXTURE = {
  phase: 'review',
  status: 'completed',
  durationMs: 122755,
  costUsd: 0.49552665,
  agentRuns: [
    {
      agentId: 'code-reviewer',
      costUsd: 0.49552665,
      durationMs: 122755,
      response: '## VERDICT: REQUEST_CHANGES\n### ISSUES\n- [CRITICAL] compile errors',
    },
  ],
};

describe('ReviewJsonSchema', () => {
  it('accepts a typical review.json fixture', () => {
    const result = ReviewJsonSchema.safeParse(REVIEW_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('rejects review missing phase literal', () => {
    const { phase: _dropped, ...without } = REVIEW_FIXTURE;
    const result = ReviewJsonSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('accepts review where agentRuns is null', () => {
    const result = ReviewJsonSchema.safeParse({ phase: 'review', agentRuns: null });
    expect(result.success).toBe(true);
  });

  it('accepts extra fields in agentRun entries (passthrough)', () => {
    const withExtra = {
      ...REVIEW_FIXTURE,
      agentRuns: [{ ...REVIEW_FIXTURE.agentRuns[0], newField: 'xyz' }],
    };
    const result = ReviewJsonSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
  });

  it('validateReviewJson returns data for valid input', () => {
    const data = validateReviewJson(REVIEW_FIXTURE);
    expect(data).toBeDefined();
    expect(data?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 5. ScoringJsonSchema
// ---------------------------------------------------------------------------

const SCORING_FIXTURE = {
  result: {
    rankings: [
      {
        itemId: 'item-001',
        title: 'Define schema',
        rank: 1,
        score: 0.97,
        confidence: 0.72,
        estimatedCostUsd: 10,
        dependencies: [],
        suggestedAssignee: 'architect',
        withinBudget: true,
      },
    ],
    totalEstimatedCostUsd: 10,
    budgetOverflowUsd: 0,
    summary: 'Good plan.',
    warnings: [],
  },
  grounding: {
    history: [],
    costMedians: {},
    teamState: { utilization: {} },
  },
  at: '2026-04-11T00:49:58.529Z',
};

describe('ScoringJsonSchema', () => {
  it('accepts a typical scoring.json fixture', () => {
    const result = ScoringJsonSchema.safeParse(SCORING_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('rejects scoring missing result object', () => {
    const result = ScoringJsonSchema.safeParse({ grounding: {}, at: '2026-01-01T00:00:00.000Z' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('result');
    }
  });

  it('accepts scoring where grounding is null', () => {
    const result = ScoringJsonSchema.safeParse({ result: { rankings: [] }, grounding: null });
    expect(result.success).toBe(true);
  });

  it('accepts extra fields in rankings entries (passthrough)', () => {
    const withExtra = {
      ...SCORING_FIXTURE,
      result: {
        ...SCORING_FIXTURE.result,
        rankings: [{ ...SCORING_FIXTURE.result.rankings[0], futureMetric: 99 }],
      },
    };
    const result = ScoringJsonSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
  });

  it('validateScoringJson returns data for valid input', () => {
    const data = validateScoringJson(SCORING_FIXTURE);
    expect(data).toBeDefined();
    expect(data?.result.rankings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. ExecutePhaseSchema
// ---------------------------------------------------------------------------

const EXECUTE_FIXTURE = {
  phase: 'execute',
  status: 'completed',
  durationMs: 1200230,
  costUsd: 22.30127535,
  agentRuns: [
    {
      itemId: 'item-001',
      status: 'completed',
      costUsd: 0.48993825,
      durationMs: 143860,
      response: 'Already implemented.',
      attempts: 1,
      agentId: 'architect',
      model: 'gpt-5.5',
      effort: 'xhigh',
    },
  ],
};

describe('ExecutePhaseSchema', () => {
  it('accepts a typical execute.json fixture', () => {
    const result = ExecutePhaseSchema.safeParse(EXECUTE_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('rejects execute missing phase literal', () => {
    const { phase: _dropped, ...without } = EXECUTE_FIXTURE;
    const result = ExecutePhaseSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('accepts execute where agentRuns is null', () => {
    const result = ExecutePhaseSchema.safeParse({ phase: 'execute', agentRuns: null });
    expect(result.success).toBe(true);
  });

  it('accepts extra unknown fields in agentRun (passthrough)', () => {
    const withExtra = {
      ...EXECUTE_FIXTURE,
      agentRuns: [{ ...EXECUTE_FIXTURE.agentRuns[0], worktree: '/tmp/wt-001' }],
    };
    const result = ExecutePhaseSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
  });

  it('accepts null values for nullish effort and model', () => {
    const withNulls = {
      ...EXECUTE_FIXTURE,
      agentRuns: [{ ...EXECUTE_FIXTURE.agentRuns[0], effort: null, model: null }],
    };
    const result = ExecutePhaseSchema.safeParse(withNulls);
    expect(result.success).toBe(true);
  });

  it('validateExecutePhase returns data for valid input', () => {
    const data = validateExecutePhase(EXECUTE_FIXTURE);
    expect(data).toBeDefined();
    expect(data?.agentRuns).toHaveLength(1);
  });
});
