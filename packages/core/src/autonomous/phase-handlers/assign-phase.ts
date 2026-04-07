// packages/core/src/autonomous/phase-handlers/assign-phase.ts
//
// v6.5.2 — Pure keyword-based assignment pass. No agent call. Infers
// assignees from item tags for any items the scoring agent didn't
// pre-assign.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

interface SprintItem {
  id: string;
  title: string;
  assignee?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface SprintFile {
  items?: SprintItem[];
  sprints?: Array<{ items?: SprintItem[] } & Record<string, unknown>>;
  [key: string]: unknown;
}

/** Map a single tag to a candidate assignee, or null. */
export function inferAssigneeFromTag(tag: string): string | null {
  const t = tag.toLowerCase();
  if (t === 'fix' || t === 'bug' || t === 'security') return 'coder';
  if (t === 'feature' || t === 'new' || t === 'enhancement') return 'coder';
  if (t === 'docs' || t === 'documentation') return 'backend-tech-writer';
  if (t === 'breaking' || t === 'architecture' || t === 'rewrite') return 'architect';
  if (t === 'test' || t === 'qa') return 'backend-qa';
  return null;
}

export function inferAssignee(item: SprintItem): string {
  for (const tag of item.tags ?? []) {
    const candidate = inferAssigneeFromTag(tag);
    if (candidate) return candidate;
  }
  return 'coder';
}

export function makeAssignPhaseHandler() {
  return (ctx: PhaseContext) => runAssignPhase(ctx);
}

export async function runAssignPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const phase = 'assign' as const;
  const startedAt = Date.now();

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const sprintPath = join(
    ctx.projectRoot,
    '.agentforge',
    'sprints',
    `v${ctx.sprintVersion}.json`,
  );

  let assignmentCount = 0;
  const byAgent: Record<string, number> = {};
  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;

  try {
    const raw = readFileSync(sprintPath, 'utf8');
    const sprintFile = JSON.parse(raw) as SprintFile;
    const sprintObj = sprintFile.items
      ? sprintFile
      : sprintFile.sprints && sprintFile.sprints.length > 0
        ? sprintFile.sprints[0]!
        : null;
    const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];

    for (const item of items) {
      if (!item.assignee || item.assignee.trim() === '') {
        item.assignee = inferAssignee(item);
        assignmentCount += 1;
      }
      byAgent[item.assignee] = (byAgent[item.assignee] ?? 0) + 1;
    }

    writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd: 0,
    agentRuns: [],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'assign.json',
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
            assignmentCount,
            byAgent,
            costUsd: 0,
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
