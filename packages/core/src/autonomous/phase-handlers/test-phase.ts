// packages/core/src/autonomous/phase-handlers/test-phase.ts
//
// v6.5.2 — Test phase handler. Dispatches the backend-qa agent to analyze
// the execute phase results and the working-tree diff for testing gaps.
// Read-only: does NOT run vitest. The cycle's VERIFY stage runs tests via
// RealTestRunner. This phase produces a test strategy report only.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import {
  appendLessonAttributions,
  readLessonAttributions,
} from '../../memory/lesson-attribution.js';
import {
  formatExecuteReviewTargets,
  loadExecuteReviewTargets,
} from './review-targets.js';

export const TEST_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];
export const TEST_PHASE_AGENT = 'backend-qa';
const MAX_TEST_PHASE_ITEM_RESULTS = 20;
const MAX_TEST_PHASE_CHANGED_FILES = 100;
const MAX_TEST_PHASE_TEXT_CHARS = 2_000;

const EXCLUDED_TEST_PHASE_PATH_PREFIXES = [
  '.agentforge/cycles/',
  '.agentforge/worktrees/',
  '.playwright-mcp/',
  '.pnpm-store/',
  '.svelte-kit/',
  'coverage/',
  'dist/',
  'node_modules/',
  'test-results/',
];

export interface TestPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeTestPhaseHandler(options: TestPhaseOptions = {}) {
  return (ctx: PhaseContext) => runTestPhase(ctx, options);
}

function isTestPhasePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return !EXCLUDED_TEST_PHASE_PATH_PREFIXES.some((prefix) => (
    lower === prefix.slice(0, -1) || lower.startsWith(prefix)
  ));
}

function truncatePromptText(value: string, maxChars = MAX_TEST_PHASE_TEXT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[AgentForge truncated this execute result field at ${maxChars} chars.]`;
}

function summarizeExecuteItemForPrompt(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const source = entry as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'itemId',
    'status',
    'agentId',
    'attempts',
    'costUsd',
    'durationMs',
    'model',
    'effort',
    'capabilityTier',
    'worktreePath',
    'worktreeBranch',
  ]) {
    if (source[key] !== undefined) summary[key] = source[key];
  }

  const changedFiles = Array.isArray(source['worktreeChangedFiles'])
    ? source['worktreeChangedFiles'].filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    : [];
  const filteredChangedFiles = changedFiles
    .map((file) => file.replace(/\\/g, '/'))
    .filter(isTestPhasePath)
    .slice(0, MAX_TEST_PHASE_CHANGED_FILES);
  if (filteredChangedFiles.length > 0) {
    summary['worktreeChangedFiles'] = filteredChangedFiles;
  }
  if (changedFiles.length > filteredChangedFiles.length) {
    summary['worktreeChangedFilesOmitted'] = changedFiles.length - filteredChangedFiles.length;
  }

  if (typeof source['error'] === 'string') {
    summary['error'] = truncatePromptText(source['error']);
  }
  if (typeof source['response'] === 'string') {
    summary['response'] = truncatePromptText(source['response']);
  }

  const validatedOutput = source['validatedOutput'];
  if (validatedOutput && typeof validatedOutput === 'object' && !Array.isArray(validatedOutput)) {
    const vo = validatedOutput as Record<string, unknown>;
    summary['validatedOutput'] = {
      schemaName: vo['schemaName'],
      ok: vo['ok'],
      ...(typeof vo['validationError'] === 'string'
        ? { validationError: truncatePromptText(vo['validationError'], 500) }
        : {}),
    };
  }

  return summary;
}

export async function runTestPhase(
  ctx: PhaseContext,
  options: TestPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'test' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? TEST_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? TEST_PHASE_AGENT;

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // P0.6 — on the objective/epic path the advisory LLM QA-strategy report is
  // redundant: every child already passed the deterministic per-child verify
  // (P0.5 — scoped typecheck + affected tests inside its worktree) and the
  // cycle-runner's VERIFY stage runs the full real test suite after the gate.
  // Skip the report for $0. Legacy (signal) cycles are untouched.
  if (ctx.objective !== undefined) {
    const durationMs = Date.now() - startedAt;
    const skipResult: PhaseResult = {
      phase,
      status: 'completed',
      durationMs,
      costUsd: 0,
      agentRuns: [],
    };
    if (ctx.cycleId) {
      const phaseJsonPath = join(
        ctx.projectRoot,
        '.agentforge',
        'cycles',
        ctx.cycleId,
        'phases',
        'test.json',
      );
      try {
        mkdirSync(dirname(phaseJsonPath), { recursive: true });
        writeFileSync(
          phaseJsonPath,
          JSON.stringify(
            {
              phase,
              skipped: true,
              reason:
                'epic path — deterministic per-child verify + cycle VERIFY stage replace the advisory QA-strategy report',
              costUsd: 0,
            },
            null,
            2,
          ),
        );
      } catch {
        // non-fatal
      }
    }
    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      result: skipResult,
      completedAt: new Date().toISOString(),
    });
    return skipResult;
  }

  // Load execute phase results if available.
  let itemResults: unknown[] = [];
  const reviewTargets = loadExecuteReviewTargets(ctx.projectRoot, ctx.cycleId);
  const reviewTargetSection = formatExecuteReviewTargets(
    reviewTargets,
    ctx.projectRoot,
    ctx.baseBranch ?? 'main',
  );
  if (ctx.cycleId) {
    const execPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    try {
      const raw = readFileSync(execPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.itemResults)) itemResults = parsed.itemResults;
    } catch {
      // missing or unparseable — proceed with empty results
    }
  }

  const promptItemResults = itemResults
    .slice(0, MAX_TEST_PHASE_ITEM_RESULTS)
    .map(summarizeExecuteItemForPrompt);
  const omittedItemCount = Math.max(0, itemResults.length - promptItemResults.length);
  const itemResultsJson = JSON.stringify(
    omittedItemCount > 0
      ? [...promptItemResults, { omittedItemResults: omittedItemCount }]
      : promptItemResults,
    null,
    2,
  );

  const task = `You are the backend QA lead for AgentForge. Sprint v${ctx.sprintVersion} just completed its execute phase with these summarized results:

${itemResultsJson}

${reviewTargetSection}

Use Read/Glob/Grep/Bash to:
1. Identify which source files changed. If execute-phase review targets are listed, use their branch-safe \`git diff\` / \`git show\` commands, direct file read commands, and changed-file lists instead of the parent checkout. Avoid worktree-scoped git commands and Git grep in Codex read-only sandbox.
2. Look at the changed files in the target worktree(s) — are there any obviously missing tests? Edge cases the executing agents might have missed?
3. Check if any items reported failures or partial completion
4. Flag anything risky (changes to core safety paths: git-ops, kill-switch, agent-runtime, cycle-runner)

Produce a test strategy report (markdown, ~250 words) covering:
- Risk assessment per changed file
- Missing test coverage concerns
- Recommended follow-up tests (specific test case names)
- Overall confidence in the sprint's quality (1-5 scale)

Do NOT run tests. The VERIFY stage will do that separately. You are only analyzing for test gaps.`;

  let strategy = '';
  let costUsd = 0;
  let status: PhaseResult['status'] = 'completed';
  let errorMsg: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, {
      allowedTools,
      codexSandbox: 'read-only',
    });
    strategy = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    status = 'failed';
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const confidence = parseConfidence(strategy);
  const concerns = parseConcerns(strategy);
  const durationMs = Date.now() - startedAt;

  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: strategy }],
    ...(errorMsg ? { error: errorMsg } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'test.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            kind: 'qa-strategy',
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status,
            testsRun: false,
            agentId,
            strategy,
            confidence,
            concerns,
            costUsd,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // non-fatal
    }
  }

  // Phase 0 — lesson-attribution: augment existing rows with verifyPassed.
  // Read cycle.json to get the aggregate test result (tests.failed), which is
  // written by the VERIFY stage (cycle-runner.ts) and represents the real
  // test outcome for this cycle. Non-fatal: never blocks the phase.
  if (ctx.cycleId) {
    try {
      // Read tests.failed from cycle.json (written by the VERIFY stage).
      let testsFailed: number | undefined;
      const cycleJsonPath = join(
        ctx.projectRoot,
        '.agentforge',
        'cycles',
        ctx.cycleId,
        'cycle.json',
      );
      try {
        const raw = readFileSync(cycleJsonPath, 'utf8');
        const cycleData = JSON.parse(raw) as Record<string, unknown>;
        const tests = cycleData['tests'];
        if (tests !== null && typeof tests === 'object') {
          const testsObj = tests as Record<string, unknown>;
          if (typeof testsObj['failed'] === 'number') {
            testsFailed = testsObj['failed'];
          }
        }
      } catch {
        // cycle.json absent or unparseable — skip augmentation
      }

      if (testsFailed !== undefined) {
        const verifyPassed = testsFailed === 0;
        const existingRows = readLessonAttributions(ctx.projectRoot).filter(
          (r) => r.cycleId === ctx.cycleId,
        );
        if (existingRows.length > 0) {
          const augmentedRows = existingRows.map((r) => ({
            cycleId: r.cycleId,
            itemId: r.itemId,
            agentId: r.agentId,
            lessonId: r.lessonId,
            lessonText: r.lessonText,
            scope: 'cycle' as const,
            verifyPassed,
          }));
          appendLessonAttributions(ctx.projectRoot, augmentedRows);
        }
      }
    } catch {
      // non-fatal — phase result must not be affected by attribution failure
    }
  }

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}

/** Parse a 1-5 confidence score from markdown. Falls back to 3. */
export function parseConfidence(markdown: string): number {
  if (!markdown) return 3;
  // Look for patterns like "confidence: 4", "confidence: 4/5", "4/5", "confidence (1-5): 4"
  const patterns = [
    /confidence[^0-9]{0,30}([1-5])\s*\/\s*5/i,
    /confidence[^0-9]{0,30}([1-5])\b/i,
    /\b([1-5])\s*\/\s*5\b/,
  ];
  for (const re of patterns) {
    const m = markdown.match(re);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 5) return n;
    }
  }
  return 3;
}

function parseConcerns(markdown: string): string[] {
  if (!markdown) return [];
  const concerns: string[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      concerns.push(trimmed.replace(/^[-*]\s+/, ''));
    }
  }
  return concerns.slice(0, 20);
}
