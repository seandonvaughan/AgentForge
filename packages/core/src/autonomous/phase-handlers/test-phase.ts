// packages/core/src/autonomous/phase-handlers/test-phase.ts
//
// v6.5.2 — Test phase handler. Dispatches the backend-qa agent to analyze
// the execute phase results and the working-tree diff for testing gaps.
// Read-only: does NOT run vitest. The cycle's VERIFY stage runs tests via
// RealTestRunner. This phase produces a test strategy report only.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

export const TEST_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];
export const TEST_PHASE_AGENT = 'backend-qa';

export interface TestPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeTestPhaseHandler(options: TestPhaseOptions = {}) {
  return (ctx: PhaseContext) => runTestPhase(ctx, options);
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

  // Load execute phase results if available.
  let itemResults: unknown[] = [];
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

  const task = `You are the backend QA lead for AgentForge. Sprint v${ctx.sprintVersion} just completed its execute phase with these results:

${JSON.stringify(itemResults, null, 2)}

Use Read/Glob/Grep/Bash to:
1. Identify which source files changed (git diff --stat HEAD)
2. Look at the changed files — are there any obviously missing tests? Edge cases the executing agents might have missed?
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
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
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
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status,
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
