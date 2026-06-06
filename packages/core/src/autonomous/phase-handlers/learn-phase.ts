// packages/core/src/autonomous/phase-handlers/learn-phase.ts
//
// v6.5.2 — Real learn phase handler. data-analyst writes a retrospective.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { writeMemoryEntry } from '../../memory/types.js';

export const LEARN_PHASE_DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];

export interface LearnPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeLearnPhaseHandler(options: LearnPhaseOptions = {}) {
  return (ctx: PhaseContext) => runLearnPhase(ctx, options);
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function truncateText(value: unknown, max = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

function compactPhaseArtifact(name: string, artifact: Record<string, any>): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    status: artifact.status ?? 'unknown',
    costUsd: artifact.costUsd ?? 0,
    durationMs: artifact.durationMs ?? 0,
  };

  if (name === 'execute') {
    const runs = Array.isArray(artifact.agentRuns) ? artifact.agentRuns : artifact.itemResults;
    if (Array.isArray(runs)) {
      compact['agentRuns'] = runs.slice(0, 10).map((run: Record<string, unknown>) => ({
        itemId: run['itemId'],
        agentId: run['agentId'],
        status: run['status'],
        title: run['title'],
        worktreeBranch: run['worktreeBranch'],
        error: truncateText(run['error'], 500),
        response: truncateText(run['response'], 1200),
      }));
    }
  } else if (name === 'review' || name === 'gate') {
    const runs = Array.isArray(artifact.agentRuns) ? artifact.agentRuns : [];
    compact['agentRuns'] = runs.slice(0, 5).map((run: Record<string, unknown>) => ({
      agentId: run['agentId'],
      verdict: run['verdict'],
      response: truncateText(run['response'], 2000),
      error: truncateText(run['error'], 500),
    }));
  } else if (name === 'test') {
    compact['tests'] = artifact.tests ?? artifact.result ?? artifact;
  }

  return compact;
}

function readCycleSummary(projectRoot: string, cycleId: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  const phasesDir = join(cycleDir, 'phases');

  for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate']) {
    const artifact = tryReadJson(join(phasesDir, `${name}.json`));
    if (artifact) summary[name] = compactPhaseArtifact(name, artifact);
  }

  const planJson = tryReadJson(join(cycleDir, 'plan.json'));
  if (planJson) {
    summary['planItems'] = (planJson.items ?? planJson.plan?.items ?? [])
      .slice?.(0, 10)
      ?.map((item: Record<string, unknown>) => ({
        id: item['id'],
        title: item['title'],
        assignee: item['assignee'],
        status: item['status'],
      })) ?? [];
  }

  const testsJson = tryReadJson(join(cycleDir, 'tests.json'));
  if (testsJson) summary['testResult'] = testsJson;

  const cycleJson = tryReadJson(join(cycleDir, 'cycle.json'));
  if (cycleJson) {
    summary['cycle'] = {
      stage: cycleJson.stage,
      tests: cycleJson.tests,
      gateVerdict: cycleJson.gateVerdict,
      pr: cycleJson.pr,
      git: cycleJson.git,
    };
  }

  const eventsPath = join(cycleDir, 'events.jsonl');
  if (existsSync(eventsPath)) {
    const events = readFileSync(eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-30)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      });
    summary['recentEvents'] = events;
  }

  return summary;
}

function collectAgentIds(summary: Record<string, unknown>, fallbackAgentId: string): string[] {
  const ids = new Set<string>([fallbackAgentId]);
  const execute = summary['execute'] as { agentRuns?: Array<Record<string, unknown>> } | undefined;
  for (const run of execute?.agentRuns ?? []) {
    if (typeof run['agentId'] === 'string') ids.add(run['agentId']);
  }
  return [...ids].sort();
}

export function extractLearnedFact(retrospective: string): string {
  const lines = retrospective
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^what went well|what failed|cost|test results|recommendations/i.test(line));
  const first = lines.find((line) => /\b(use|avoid|add|fix|keep|preserve|run|ensure|write|verify|parallel|memory|learn)\b/i.test(line))
    ?? lines[0]
    ?? 'Review the cycle retrospective before planning the next AgentForge cycle.';
  return first.length > 360 ? `${first.slice(0, 357)}...` : first;
}

function writeLearnedFacts(input: {
  projectRoot: string;
  cycleId: string;
  sprintId: string;
  sprintVersion: string;
  agentIds: string[];
  retrospective: string;
  retrospectivePath: string;
}): void {
  const value = extractLearnedFact(input.retrospective);
  for (const agentId of input.agentIds) {
    writeMemoryEntry(input.projectRoot, {
      type: 'learned-fact',
      key: `learn-${input.cycleId}-${agentId}`,
      value,
      source: agentId,
      tags: ['learn', 'cycle', input.sprintVersion, agentId],
      metadata: {
        cycleId: input.cycleId,
        sprintId: input.sprintId,
        sprintVersion: input.sprintVersion,
        agentId,
        retrospectivePath: input.retrospectivePath,
      },
    });
  }
}

export async function runLearnPhase(
  ctx: PhaseContext,
  options: LearnPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'learn' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? LEARN_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'data-analyst';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const summary = ctx.cycleId ? readCycleSummary(ctx.projectRoot, ctx.cycleId) : {};

  const task = `You are the data-analyst for AgentForge. Sprint v${ctx.sprintVersion} has completed. Return a retrospective (markdown, ~400 words) covering:

1. What went well (specific items, specific agents)
2. What failed or underperformed (with root cause guesses)
3. Cost vs. expected — were estimates accurate?
4. Test results — any flaky or concerning tests?
5. Recommendations for the next cycle (concrete items to add to the backlog)

Return the markdown as your final answer only. Do not create, edit, delete, or append any files; AgentForge persists your response into cycle artifacts.

Cycle data summary:
${JSON.stringify(summary, null, 2)}

Format as markdown with section headers.`;

  let retrospective = '';
  let costUsd = 0;
  let model: string | undefined;
  let effort: string | undefined;
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, {
      allowedTools,
      codexSandbox: 'read-only',
    });
    retrospective = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
    if (typeof (result as any)?.model === 'string') model = (result as any).model;
    if (typeof (result as any)?.effort === 'string') effort = (result as any).effort;
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: retrospective, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(error ? { error } : {}) }],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'learn.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      const retrospectivePath = join(
        ctx.projectRoot,
        '.agentforge',
        'cycles',
        ctx.cycleId,
        'retrospective.md',
      );
      writeFileSync(retrospectivePath, retrospective, 'utf8');
      if (status === 'completed' && retrospective.trim().length > 0) {
        writeLearnedFacts({
          projectRoot: ctx.projectRoot,
          cycleId: ctx.cycleId,
          sprintId: ctx.sprintId,
          sprintVersion: ctx.sprintVersion,
          agentIds: collectAgentIds(summary, agentId),
          retrospective,
          retrospectivePath,
        });
      }
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            agentId,
            retrospectivePath,
            retrospective,
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
