// packages/core/src/autonomous/__tests__/scoring-pipeline-roster.test.ts
//
// Tests that the scorer prompt includes the mandatory re-read clause and
// that sanitizeAssignees() correctly guards against off-roster IDs at runtime.
//
// This covers the sprint item: "Improve scorer prompt to penalize invented
// agent IDs not present in team.yaml roster."
// Historical context: BackendEngineer/FrontendEngineer/QAEngineer invented IDs
// caused UNVERIFIED ROUTING flags that triggered sprint gate REJECT verdicts.

import { describe, it, expect, vi } from 'vitest';
import { ScoringPipeline } from '../scoring-pipeline.js';
import type {
  AdapterForScoring,
  RuntimeForScoring,
  ScoringPipelineResult,
} from '../scoring-pipeline.js';
import type { BacklogItem } from '../proposal-to-backlog.js';
import type { CycleConfig } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

// ---------------------------------------------------------------------------
// Private method access — same pattern used by scoring-pipeline-fallback.test.ts
// ---------------------------------------------------------------------------
type PipelineWithPrivates = {
  buildScoringPrompt(backlog: BacklogItem[], grounding: object): string;
  sanitizeAssignees(result: import('../types.js').ScoringResult): import('../types.js').ScoringResult;
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeConfig(): CycleConfig {
  return {
    budget: { perCycleUsd: 50, perItemUsd: 1.5, perAgentUsd: 10, allowOverageApproval: false },
    limits: {
      maxItemsPerSprint: 10,
      maxDurationMinutes: 60,
      maxConsecutiveFailures: 3,
      maxExecutePhaseFailureRate: 0.5,
      maxExecutePhaseParallelism: 3,
      maxItemRetries: 2,
    },
    quality: { testPassRateFloor: 0.9, allowRegression: false, requireBuildSuccess: true, requireTypeCheckSuccess: true },
    git: { branchPrefix: 'auto', baseBranch: 'main', refuseCommitToBaseBranch: true, includeDiagnosticBranchOnFailure: false, maxFilesPerCommit: 50 },
    pr: { draft: true, assignReviewer: null, labelPrefix: 'auto', labels: [], titleTemplate: 'Auto Sprint' },
    sourcing: { lookbackDays: 7, minProposalConfidence: 0.5, includeTodoMarkers: true, todoMarkerPattern: 'TODO\\(autonomous\\)' },
    testing: { command: 'pnpm test', timeoutMinutes: 10, reporter: 'json', saveRawLog: false, buildCommand: 'pnpm build', typeCheckCommand: 'pnpm typecheck' },
    scoring: { agentId: 'backlog-scorer', maxRetries: 1, fallbackToStatic: true },
    logging: { logDir: '/tmp/agentforge-test', retainCycles: 5 },
    safety: { stopFilePath: '/tmp/.stop', secretScanEnabled: false, verifyCleanWorkingTreeBeforeStart: false, workingTreeWhitelist: [] },
    retry: { maxAutoRetries: 2, requireApprovalAfter: 1, reExecuteOnRetry: false },
  } as unknown as CycleConfig;
}

function makeBacklogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'item-1',
    title: 'Fix the thing',
    description: 'Fix the broken thing',
    priority: 'P1',
    tags: ['fix'],
    source: 'todo-marker',
    confidence: 0.8,
    ...overrides,
  };
}

function makeAdapter(): AdapterForScoring {
  return {
    getSprintHistory: vi.fn().mockResolvedValue([]),
    getCostMedians: vi.fn().mockResolvedValue({}),
    getP50CostByTag: vi.fn().mockResolvedValue({}),
    getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
  };
}

function makeRuntime(): RuntimeForScoring {
  return { run: vi.fn().mockRejectedValue(new Error('not used in these tests')) };
}

function makeLogger(): CycleLogger {
  return {
    logScoring: vi.fn(),
    logScoringFallback: vi.fn(),
    logKillSwitch: vi.fn(),
    logCycleResult: vi.fn(),
    logGitEvent: vi.fn(),
    logTestRun: vi.fn(),
    logPREvent: vi.fn(),
  } as unknown as CycleLogger;
}

function makePipeline(cwd?: string): PipelineWithPrivates {
  return new ScoringPipeline(
    makeRuntime(),
    makeAdapter(),
    makeConfig(),
    makeLogger(),
    cwd,
  ) as unknown as PipelineWithPrivates;
}

function buildPrompt(pipeline: PipelineWithPrivates, backlog: BacklogItem[] = [makeBacklogItem()]): string {
  return pipeline.buildScoringPrompt(backlog, {});
}

// ---------------------------------------------------------------------------
// Tests: scorer prompt content — gate-rejection penalty framing
// ---------------------------------------------------------------------------

describe('ScoringPipeline scorer prompt — gate-rejection penalty framing', () => {
  it('mentions sprint REJECT verdict risk in penalty section', () => {
    const prompt = buildPrompt(makePipeline());
    // Must communicate gate rejection as the consequence, not just a "flag"
    expect(prompt).toMatch(/REJECT\s+verdict/i);
  });

  it('identifies UNVERIFIED ROUTING as the flag name', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toMatch(/UNVERIFIED ROUTING/);
  });

  it('describes the automatic reassignment to "coder" at runtime', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toMatch(/reassigned to.*coder.*runtime/i);
  });

  it('explicitly names BackendEngineer/FrontendEngineer/QAEngineer as forbidden', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toContain('BackendEngineer');
    expect(prompt).toContain('FrontendEngineer');
    expect(prompt).toContain('QAEngineer');
  });
});

// ---------------------------------------------------------------------------
// Tests: scorer prompt content — mandatory re-read clause
// ---------------------------------------------------------------------------

describe('ScoringPipeline scorer prompt — mandatory re-read clause', () => {
  it('contains a mandatory re-read step before JSON output', () => {
    const prompt = buildPrompt(makePipeline());
    // The step must be framed as mandatory, not advisory
    expect(prompt).toMatch(/MANDATORY\s+re-read\s+step/i);
  });

  it('instructs scorer to scroll back to the roster and read top to bottom', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toMatch(/top to bottom/i);
  });

  it('instructs scorer to replace off-roster assignees before emitting JSON', () => {
    const prompt = buildPrompt(makePipeline());
    // Must say "replace" + "not present" / "NOT present" — not just "stop and re-read"
    expect(prompt).toMatch(/NOT present.*replace|replace.*NOT present|replace it immediately/is);
  });

  it('includes coder as the explicit safe fallback in the re-read step', () => {
    const prompt = buildPrompt(makePipeline());
    // The mandatory step must name coder as the safe replacement
    expect(prompt).toMatch(/safe fallback|safe replacement/i);
  });

  it('pre-flight checklist still present after mandatory step', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toContain('Pre-flight checklist');
    expect(prompt).toMatch(/\[ \].*suggestedAssignee/);
  });
});

// ---------------------------------------------------------------------------
// Tests: scorer prompt content — roster list injection
// ---------------------------------------------------------------------------

describe('ScoringPipeline scorer prompt — roster list', () => {
  it('prompt contains the fallback roster when no cwd is provided', () => {
    const prompt = buildPrompt(makePipeline());
    // Fallback FALLBACK_AGENT_IDS always includes these canonical IDs
    expect(prompt).toContain('coder');
    expect(prompt).toContain('frontend-dev');
    expect(prompt).toContain('api-specialist');
  });

  it('prompt includes "Valid agent IDs" header before roster', () => {
    const prompt = buildPrompt(makePipeline());
    expect(prompt).toMatch(/Valid agent IDs/);
  });
});

// ---------------------------------------------------------------------------
// Tests: sanitizeAssignees — post-processing guard
// ---------------------------------------------------------------------------

describe('ScoringPipeline.sanitizeAssignees — off-roster replacement', () => {
  function makeScoringResult(assignees: string[]) {
    return {
      rankings: assignees.map((assignee, i) => ({
        itemId: `item-${i}`,
        title: `Task ${i}`,
        rank: i + 1,
        score: 0.8,
        confidence: 0.8,
        estimatedCostUsd: 1.0,
        estimatedDurationMinutes: 15,
        rationale: 'Test',
        dependencies: [] as string[],
        suggestedAssignee: assignee,
        suggestedTags: [] as string[],
        withinBudget: true,
      })),
      totalEstimatedCostUsd: assignees.length,
      budgetOverflowUsd: 0,
      summary: 'Test',
      warnings: [] as string[],
    };
  }

  it('leaves on-roster assignees unchanged', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['coder', 'frontend-dev']));
    expect(result.rankings[0]?.suggestedAssignee).toBe('coder');
    expect(result.rankings[1]?.suggestedAssignee).toBe('frontend-dev');
  });

  it('replaces off-roster BackendEngineer with coder', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['BackendEngineer']));
    expect(result.rankings[0]?.suggestedAssignee).toBe('coder');
  });

  it('replaces off-roster FrontendEngineer with coder', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['FrontendEngineer']));
    expect(result.rankings[0]?.suggestedAssignee).toBe('coder');
  });

  it('replaces off-roster QAEngineer with coder', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['QAEngineer']));
    expect(result.rankings[0]?.suggestedAssignee).toBe('coder');
  });

  it('appends a warning for each off-roster replacement', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(
      makeScoringResult(['BackendEngineer', 'coder', 'FrontendEngineer']),
    );
    // Two off-roster IDs → two warnings
    const rosterWarnings = result.warnings.filter(w => w.includes('not in roster'));
    expect(rosterWarnings).toHaveLength(2);
  });

  it('warning message names the original off-roster ID', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['QAEngineer']));
    expect(result.warnings.some(w => w.includes('QAEngineer'))).toBe(true);
  });

  it('warning message names the item ID', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['BackendEngineer']));
    expect(result.warnings.some(w => w.includes('item-0'))).toBe(true);
  });

  it('preserves existing warnings when appending roster warnings', () => {
    const pipeline = makePipeline();
    const input = makeScoringResult(['FrontendEngineer']);
    input.warnings = ['pre-existing warning'];
    const result = pipeline.sanitizeAssignees(input);
    expect(result.warnings).toContain('pre-existing warning');
    expect(result.warnings.some(w => w.includes('not in roster'))).toBe(true);
  });

  it('handles all-valid roster: zero warnings appended', () => {
    const pipeline = makePipeline();
    const result = pipeline.sanitizeAssignees(makeScoringResult(['coder', 'api-specialist', 'backend-qa']));
    expect(result.warnings).toHaveLength(0);
  });
});
