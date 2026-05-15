// packages/core/src/autonomous/phase-handlers/release-phase.ts
//
// v6.5.2 — Release phase handler. In an autonomous cycle, the actual
// release happens in the cycle's COMMIT/REVIEW stages (commit + push +
// PR). This handler is a metadata-only marker phase: it updates the
// sprint JSON's `phase` field and publishes a completion event so
// downstream observers see a clear "release happened" signal. No agent
// is dispatched.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

export interface ReleasePhaseOptions {
  // Reserved for future use.
}

export function makeReleasePhaseHandler(options: ReleasePhaseOptions = {}) {
  return (ctx: PhaseContext) => runReleasePhase(ctx, options);
}

export async function runReleasePhase(
  ctx: PhaseContext,
  _options: ReleasePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'release' as const;
  const startedAt = Date.now();

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Update plan/sprint JSON phase field if the file exists.
  // Prefer plan.json in the cycle dir; fall back to the legacy sprint JSON.
  // Always update the legacy sprint JSON too (dashboard reads from there).
  let itemCount = 0;
  const planPath = ctx.cycleId
    ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'plan.json')
    : null;
  const legacySprintPath = join(
    ctx.projectRoot,
    '.agentforge',
    'sprints',
    `v${ctx.sprintVersion}.json`,
  );
  const activePath =
    planPath && existsSync(planPath) ? planPath : legacySprintPath;

  try {
    const raw = readFileSync(activePath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj = parsed.items
      ? parsed
      : parsed.sprints && parsed.sprints.length > 0
        ? parsed.sprints[0]
        : null;
    if (sprintObj) {
      sprintObj.phase = 'release';
      itemCount = Array.isArray(sprintObj.items) ? sprintObj.items.length : 0;
    }
    writeFileSync(activePath, JSON.stringify(parsed, null, 2));
  } catch {
    // non-fatal — file may not exist in some test contexts
  }

  // If we updated plan.json, also mirror the phase change to the legacy sprint
  // JSON so the dashboard (which reads from .agentforge/sprints/) stays in sync.
  if (activePath !== legacySprintPath) {
    try {
      const raw = readFileSync(legacySprintPath, 'utf8');
      const parsed = JSON.parse(raw);
      const sprintObj = parsed.items
        ? parsed
        : parsed.sprints && parsed.sprints.length > 0
          ? parsed.sprints[0]
          : null;
      if (sprintObj) sprintObj.phase = 'release';
      writeFileSync(legacySprintPath, JSON.stringify(parsed, null, 2));
    } catch {
      // non-fatal — legacy sprint JSON may not exist
    }
  }

  const releasedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAt;

  const phaseResult: PhaseResult = {
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
      'release.json',
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
            status: 'completed',
            releasedAt,
            itemCount,
            costUsd: 0,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: releasedAt,
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
    completedAt: releasedAt,
  });

  return phaseResult;
}
