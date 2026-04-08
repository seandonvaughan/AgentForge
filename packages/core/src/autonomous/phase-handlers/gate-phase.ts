// packages/core/src/autonomous/phase-handlers/gate-phase.ts
//
// v6.5.2 — Real gate phase handler. CEO agent reviews everything that
// happened in the cycle and approves or rejects. On REJECT, throws
// GateRejectedError so the cycle runner aborts before release.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { writeMemoryEntry } from '../../memory/types.js';

export const GATE_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export class GateRejectedError extends Error {
  constructor(public readonly rationale: string) {
    super(`Gate rejected: ${rationale}`);
    this.name = 'GateRejectedError';
  }
}

export interface GatePhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeGatePhaseHandler(options: GatePhaseOptions = {}) {
  return (ctx: PhaseContext) => runGatePhase(ctx, options);
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

interface GateVerdict {
  verdict: 'APPROVE' | 'REJECT';
  rationale: string;
}

/**
 * Extract finding lines from the code-review markdown output.
 * Lines that contain a severity keyword (CRITICAL / MAJOR) are collected and
 * returned so the gate-verdict memory entry can surface them to future audits.
 */
export function extractFindingsByLevel(
  reviewText: string,
  level: 'CRITICAL' | 'MAJOR',
): string[] {
  const pattern = new RegExp(level, 'i');
  return reviewText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && pattern.test(l))
    .slice(0, 10); // cap to avoid bloating the memory entry
}

export function parseGateVerdict(text: string): GateVerdict {
  // Try strict JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
      const v = String(parsed.verdict).toUpperCase();
      if (v === 'APPROVE' || v === 'REJECT') {
        return {
          verdict: v,
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
        };
      }
    }
  } catch {
    // fall through
  }

  // Try to extract a JSON object from within the text
  const match = text.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
        const v = String(parsed.verdict).toUpperCase();
        if (v === 'APPROVE' || v === 'REJECT') {
          return {
            verdict: v,
            rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // Malformed: treat as REJECT with raw text as rationale
  return { verdict: 'REJECT', rationale: text || 'Malformed gate response' };
}

export async function runGatePhase(
  ctx: PhaseContext,
  options: GatePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'gate' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? GATE_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'ceo';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Gather context from prior phases
  const phasesDir = ctx.cycleId
    ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'phases')
    : null;

  let items = '(no items)';
  let testResults = '(no test results)';
  let reviewFindings = '(no review findings)';
  let costSoFar = 0;

  try {
    const sprintPath = join(
      ctx.projectRoot,
      '.agentforge',
      'sprints',
      `v${ctx.sprintVersion}.json`,
    );
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj = parsed.items ? parsed : parsed.sprints?.[0] ?? null;
    if (sprintObj?.items?.length) {
      items = sprintObj.items
        .map((i: any) => `- [${i.id}] ${i.title} (${i.status ?? 'unknown'})`)
        .join('\n');
    }
  } catch {
    // ignore
  }

  if (phasesDir) {
    const testJson = tryReadJson(join(phasesDir, 'test.json'));
    if (testJson) {
      testResults = JSON.stringify(
        {
          status: testJson.status,
          passed: testJson.passed,
          failed: testJson.failed,
          total: testJson.total,
        },
        null,
        2,
      );
    }
    const reviewJson = tryReadJson(join(phasesDir, 'review.json'));
    if (reviewJson) {
      reviewFindings =
        typeof reviewJson.findings === 'string'
          ? reviewJson.findings
          : JSON.stringify(reviewJson, null, 2);
    }

    // Sum cost across all known phase JSONs
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review']) {
      const j = tryReadJson(join(phasesDir, `${name}.json`));
      if (j && typeof j.costUsd === 'number') costSoFar += j.costUsd;
    }
  }

  const task = `You are the CEO of AgentForge. Sprint v${ctx.sprintVersion} has completed execution. Here is the full state:

## Sprint items
${items}

## Test results
${testResults}

## Code review findings
${reviewFindings}

## Cost so far
$${costSoFar.toFixed(4)}

Decide: APPROVE or REJECT this sprint for release. Provide a 1-paragraph rationale.

Respond as JSON: { "verdict": "APPROVE" | "REJECT", "rationale": "..." }`;

  let response = '';
  let runCost = 0;
  let agentError: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    response = typeof result?.output === 'string' ? result.output : '';
    runCost = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err);
  }

  const verdict: GateVerdict = agentError
    ? { verdict: 'REJECT', rationale: `Agent error: ${agentError}` }
    : parseGateVerdict(response);

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status: verdict.verdict === 'APPROVE' ? 'completed' : 'failed',
    durationMs,
    costUsd: runCost,
    agentRuns: [
      { agentId, costUsd: runCost, durationMs, response, verdict: verdict.verdict },
    ],
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'gate.json',
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
            agentId,
            verdict: verdict.verdict,
            rationale: verdict.rationale,
            costUsd: runCost,
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

  // Write a gate-verdict memory entry for every cycle — both APPROVE and REJECT
  // are high-signal because they record what the CEO agent found acceptable or
  // not. Future audit phases read these entries to surface recurring patterns.
  const criticalFindings = extractFindingsByLevel(reviewFindings, 'CRITICAL');
  const majorFindings = extractFindingsByLevel(reviewFindings, 'MAJOR');
  writeMemoryEntry(ctx.projectRoot, {
    type: 'gate-verdict',
    value: JSON.stringify({
      cycleId: ctx.cycleId ?? null,
      sprintVersion: ctx.sprintVersion,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      criticalFindings,
      majorFindings,
    }),
    source: ctx.cycleId,
    tags: [
      `verdict:${verdict.verdict.toLowerCase()}`,
      `sprint:v${ctx.sprintVersion}`,
    ],
  });

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  if (verdict.verdict === 'REJECT') {
    throw new GateRejectedError(verdict.rationale);
  }

  return phaseResult;
}
