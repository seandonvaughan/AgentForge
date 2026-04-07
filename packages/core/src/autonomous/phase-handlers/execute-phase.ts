// packages/core/src/autonomous/phase-handlers/execute-phase.ts
//
// v6.5.1 — Real execute phase handler.
//
// Reads the sprint JSON written by the plan phase, then dispatches each
// sprint item sequentially to its assignee agent via the RuntimeAdapter.
// Each agent runs `claude -p` with Read/Write/Edit/Bash/Glob/Grep tools
// enabled so it can actually modify files in the working tree. The
// cycle's git stage later picks up those modifications via
// `collectChangedFiles` and commits them.
//
// Per-item failures are tolerated: an individual agent throw marks that
// item failed and the phase moves on. The phase only returns 'failed'
// when more than `config.limits.maxExecutePhaseFailureRate` (default 0.5)
// of items fail. All-failures returns 'blocked'.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';

/** Default tools enabled for execute-phase agent runs. Task is intentionally
 *  excluded to prevent recursive subagent dispatch from burning quota. */
export const EXECUTE_PHASE_DEFAULT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
];

interface SprintItem {
  id: string;
  title: string;
  description?: string;
  assignee: string;
  status: string;
  source?: string;
  tags?: string[];
}

interface SprintFile {
  version?: string;
  items?: SprintItem[];
  // Newer wrapped format from sprint-generator: { sprints: [{...}] }
  sprints?: Array<{ version?: string; items?: SprintItem[] } & Record<string, unknown>>;
  [key: string]: unknown;
}

interface ItemResult {
  itemId: string;
  status: 'completed' | 'failed';
  costUsd: number;
  durationMs: number;
  response: string;
  attempts: number;
  error?: string;
}

export interface ExecutePhaseOptions {
  /** Override the default Read/Write/Edit/Bash/Glob/Grep tool list. */
  allowedTools?: string[];
  /** Failure-rate threshold above which the phase returns 'failed'.
   *  Default 0.5. */
  maxFailureRate?: number;
  /** Max concurrent item dispatches. Default 3. */
  maxParallelism?: number;
  /** Max retries per failing item (additional attempts beyond the first).
   *  Default 1 (so each item gets up to 2 total tries). */
  maxItemRetries?: number;
}

export function makeExecutePhaseHandler(options: ExecutePhaseOptions = {}) {
  return (ctx: PhaseContext) => runExecutePhase(ctx, options);
}

export async function runExecutePhase(
  ctx: PhaseContext,
  options: ExecutePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'execute' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? EXECUTE_PHASE_DEFAULT_TOOLS;
  const maxFailureRate = options.maxFailureRate ?? 0.5;
  const maxParallelism = Math.max(1, options.maxParallelism ?? 3);
  const maxItemRetries = Math.max(0, options.maxItemRetries ?? 1);

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // ---- Read sprint JSON ----
  const sprintPath = join(
    ctx.projectRoot,
    '.agentforge',
    'sprints',
    `v${ctx.sprintVersion}.json`,
  );

  let raw: string;
  try {
    raw = readFileSync(sprintPath, 'utf8');
  } catch (err) {
    const message = `execute phase: failed to read sprint file at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  let sprintFile: SprintFile;
  try {
    sprintFile = JSON.parse(raw) as SprintFile;
  } catch (err) {
    const message = `execute phase: sprint JSON parse error at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  // Locate items array (supports both flat and wrapped { sprints: [...] }).
  const sprintObj =
    sprintFile.items
      ? sprintFile
      : sprintFile.sprints && sprintFile.sprints.length > 0
        ? sprintFile.sprints[0]!
        : null;
  const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];

  let totalCost = 0;

  // ---- Dispatch items in parallel with a numeric concurrency cap ----
  // We use a simple semaphore (no file-conflict detection in v6.5.3 — known
  // limitation for v6.5.4+). Promise.allSettled ensures we collect every
  // result even when some items fail.
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      const tryAcquire = () => {
        if (active < maxParallelism) {
          active += 1;
          resolve();
        } else {
          queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  const dispatchItem = async (item: SprintItem): Promise<ItemResult> => {
    await acquire();
    const itemStartedAt = Date.now();
    let lastError: string | undefined;
    let attempts = 0;
    try {
      for (let attempt = 0; attempt <= maxItemRetries; attempt++) {
        attempts = attempt + 1;
        const task = buildItemPrompt(item, ctx.projectRoot, attempt, lastError);
        try {
          const result = await ctx.runtime.run(item.assignee, task, {
            allowedTools,
          });
          const durationMs = Date.now() - itemStartedAt;
          const costUsd =
            typeof result?.costUsd === 'number' ? result.costUsd : 0;
          totalCost += costUsd;
          item.status = 'completed';
          return {
            itemId: item.id,
            status: 'completed',
            costUsd,
            durationMs,
            response: typeof result?.output === 'string' ? result.output : '',
            attempts,
          };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt >= maxItemRetries) {
            const durationMs = Date.now() - itemStartedAt;
            item.status = 'failed';
            return {
              itemId: item.id,
              status: 'failed',
              costUsd: 0,
              durationMs,
              response: '',
              attempts,
              error: lastError,
            };
          }
        }
      }
      // unreachable
      const durationMs = Date.now() - itemStartedAt;
      item.status = 'failed';
      return {
        itemId: item.id,
        status: 'failed',
        costUsd: 0,
        durationMs,
        response: '',
        attempts,
        error: lastError ?? 'unknown',
      };
    } finally {
      ctx.bus.publish('sprint.phase.item.completed', {
        sprintId: ctx.sprintId,
        phase,
        cycleId: ctx.cycleId,
        itemId: item.id,
        status: item.status,
        completedAt: new Date().toISOString(),
      });
      try {
        writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
      } catch {
        // Non-fatal
      }
      release();
    }
  };

  const settled = await Promise.allSettled(items.map((it) => dispatchItem(it)));
  const itemResults: ItemResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const item = items[i]!;
    item.status = 'failed';
    return {
      itemId: item.id,
      status: 'failed',
      costUsd: 0,
      durationMs: 0,
      response: '',
      attempts: 0,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  // ---- Compute phase status ----
  const total = itemResults.length;
  const failed = itemResults.filter((r) => r.status === 'failed').length;
  const completed = total - failed;
  let status: PhaseResult['status'];
  if (total === 0) {
    status = 'completed';
  } else if (failed === total) {
    status = 'blocked';
  } else if (failed / total > maxFailureRate) {
    status = 'failed';
  } else {
    status = 'completed';
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd: totalCost,
    agentRuns: itemResults,
    itemResults,
  };

  // ---- Write phase JSON to cycle log dir ----
  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
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
            totalItems: total,
            completedItems: completed,
            failedItems: failed,
            costUsd: totalCost,
            durationMs,
            itemResults,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // Non-fatal — phase result is still emitted via the bus.
    }
  }
  // Suppress unused-import warning for existsSync — kept for future use.
  void existsSync;

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}

function buildItemPrompt(
  item: SprintItem,
  cwd: string,
  attempt: number = 0,
  lastError?: string,
): string {
  const tags =
    item.tags && item.tags.length > 0 ? item.tags.join(', ') : 'none';
  const description = item.description || item.title;
  const source = item.source || 'manual';
  const base = `You are working on sprint item "${item.title}" in the AgentForge repository at ${cwd}.

Description: ${description}
Source: ${source} (e.g., TODO(autonomous) marker)
Tags: ${tags}

Your job: use the Read, Write, Edit, Bash, Glob, and Grep tools to make the code change required to resolve this item. Do NOT commit anything — the autonomous cycle's Git stage will commit everything that changed in the working tree after all items are done.

Work efficiently. Report what you changed when done.`;

  if (attempt > 0 && lastError) {
    return `${base}

PREVIOUS ATTEMPT FAILED:
${lastError}

Please take a different approach. Read the relevant files carefully before making changes.`;
  }
  return base;
}
