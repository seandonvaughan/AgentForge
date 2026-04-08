// packages/core/src/autonomous/phase-handlers/review-phase.ts
//
// v6.5.2 — Review phase handler. Dispatches the code-reviewer agent to
// review the actual diff produced by the execute phase. Read-only —
// does NOT modify any files.
//
// v6.8.0 — Writes review-finding memory entries for MAJOR and CRITICAL
// findings so the audit phase can surface recurring anti-patterns in
// subsequent cycles.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { writeMemoryEntry } from '../../memory/types.js';
import { extractFindingsByLevel } from './gate-phase.js';

export const REVIEW_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];
export const REVIEW_PHASE_AGENT = 'code-reviewer';

export interface ReviewPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeReviewPhaseHandler(options: ReviewPhaseOptions = {}) {
  return (ctx: PhaseContext) => runReviewPhase(ctx, options);
}

export async function runReviewPhase(
  ctx: PhaseContext,
  options: ReviewPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'review' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? REVIEW_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? REVIEW_PHASE_AGENT;

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const task = `You are the code-reviewer for AgentForge. Sprint v${ctx.sprintVersion} just completed its execute phase. Review the changes.

Use Bash to run:
- git diff --stat HEAD (summary of what changed)
- git diff HEAD (full diff)
- git log -1 --format="%B" (commit message if any, though there may not be one yet)

Then Read the changed files to understand context beyond the diff.

Produce a code review (markdown, ~400 words) covering:
- Overall correctness — does the code do what the sprint items asked for?
- Code quality issues (naming, complexity, duplication)
- Security concerns
- Test coverage gaps
- Any bugs you'd reject the PR for

End with an overall verdict on a 1-5 scale where 1=reject, 5=ship.

Do NOT modify any files.`;

  let review = '';
  let costUsd = 0;
  let status: PhaseResult['status'] = 'completed';
  let errorMsg: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    review = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    status = 'failed';
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const verdict = parseVerdict(review);
  const concerns = parseConcerns(review);
  const durationMs = Date.now() - startedAt;

  // Persist CRITICAL and MAJOR findings to the cross-cycle memory store so the
  // audit phase can detect recurring anti-patterns across sprints. One entry
  // per finding line — granularity enables per-file pattern counting.
  const criticalLines = extractFindingsByLevel(review, 'CRITICAL');
  const majorLines = extractFindingsByLevel(review, 'MAJOR');
  for (const line of criticalLines) {
    writeMemoryEntry(ctx.projectRoot, {
      type: 'review-finding',
      value: line,
      source: ctx.cycleId,
      tags: ['review', 'finding', 'critical', `sprint:v${ctx.sprintVersion}`],
    });
  }
  for (const line of majorLines) {
    writeMemoryEntry(ctx.projectRoot, {
      type: 'review-finding',
      value: line,
      source: ctx.cycleId,
      tags: ['review', 'finding', 'major', `sprint:v${ctx.sprintVersion}`],
    });
  }

  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: review }],
    ...(errorMsg ? { error: errorMsg } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'review.json',
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
            review,
            verdict,
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

/** Parse a 1-5 verdict score from a review markdown. Falls back to 3. */
export function parseVerdict(markdown: string): number {
  if (!markdown) return 3;
  const patterns = [
    /verdict[^0-9]{0,30}([1-5])\s*\/\s*5/i,
    /verdict[^0-9]{0,30}([1-5])\b/i,
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
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      concerns.push(trimmed.replace(/^[-*]\s+/, ''));
    }
  }
  return concerns.slice(0, 20);
}
