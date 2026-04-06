/**
 * sprint-orchestration.ts — HTTP routes for sprint lifecycle.
 *
 * As of v6.4 / Task 15, this file is a THIN HTTP wrapper. The phase logic
 * lives in `packages/server/src/lib/phase-handlers.ts` as plain async
 * functions. The route handlers here build a `PhaseContext`, look up the
 * handler in `PHASE_HANDLERS`, and either:
 *   - `await` it (release / learn — must complete before reply for the
 *     regression test contract: phase persisted to disk before 202)
 *   - Fire-and-forget via `void runXxxPhase(ctx)` for the background-async
 *     phases that v6.3 ran in `void (async () => {})()` blocks
 *
 * Behaviour-preserving refactor — the regression test in
 * tests/autonomous/integration/phase-handlers-http.test.ts (33 tests) is
 * the contract.
 */

import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { globalStream } from './stream.js';
import { careerHook } from '../../lib/career-hook.js';
import {
  PHASE_ORDER,
  PHASE_AGENT_MAP,
  PHASE_HANDLERS,
  createNoopBus,
  readSprint,
  writeSprint,
  sprintPath,
  type Phase,
  type PhaseContext,
  type PhaseName,
  type SprintFile,
} from '../../lib/phase-handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default project root: up from packages/server/src/routes/v5/ → monorepo root
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface CreateSprintBody {
  version: string;
  title: string;
  items: Array<{
    title: string;
    description: string;
    priority: 'P0' | 'P1' | 'P2';
    assignee: string;
  }>;
  budget: number;
  teamSize: number;
  successCriteria: string[];
}

interface UpdateItemBody {
  status?: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  assignee?: string;
}

// ---------------------------------------------------------------------------
// Helper: build PhaseContext for an HTTP request
// ---------------------------------------------------------------------------

function buildPhaseContext(opts: {
  sprint: SprintFile;
  projectRoot: string;
  agentforgeDir: string;
}): PhaseContext {
  return {
    sprintId: opts.sprint.sprintId,
    sprintVersion: opts.sprint.version,
    projectRoot: opts.projectRoot,
    agentforgeDir: opts.agentforgeDir,
    bus: createNoopBus(),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function sprintOrchestrationRoutes(
  app: FastifyInstance,
  opts?: { projectRoot?: string },
): Promise<void> {
  const projectRoot = opts?.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const agentforgeDir = join(projectRoot, '.agentforge');

  // ── POST /api/v5/sprints — Create a new sprint ───────────────────────────

  app.post<{ Body: CreateSprintBody }>('/api/v5/sprints', async (req, reply) => {
    const body = req.body;

    if (!body?.version) return reply.status(400).send({ error: 'version is required' });
    if (!body?.title) return reply.status(400).send({ error: 'title is required' });
    if (!Array.isArray(body?.items)) return reply.status(400).send({ error: 'items must be an array' });

    const { version, title, items, budget, teamSize, successCriteria } = body;

    // Reject if file already exists
    if (existsSync(sprintPath(projectRoot, version))) {
      return reply.status(409).send({
        error: `Sprint v${version} already exists`,
        code: 'SPRINT_EXISTS',
      });
    }

    const sprint: SprintFile = {
      sprintId: generateId(),
      version,
      title,
      createdAt: nowIso(),
      phase: 'planned',
      items: items.map((item) => ({
        id: generateId(),
        title: item.title,
        description: item.description,
        priority: item.priority,
        assignee: item.assignee,
        status: 'planned',
      })),
      budget: budget ?? 0,
      teamSize: teamSize ?? 1,
      successCriteria: successCriteria ?? [],
      auditFindings: [],
      agentsInvolved: [],
      budgetUsed: 0,
      phaseResults: [],
    };

    writeSprint(projectRoot, version, sprint);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${version} created: "${title}"`,
      data: { type: 'created', version, sprintId: sprint.sprintId },
    });

    return reply.status(201).send({ data: sprint });
  });

  // ── PATCH /api/v5/sprints/:version/advance — Advance sprint to next phase ─

  app.patch<{ Params: { version: string } }>(
    '/api/v5/sprints/:version/advance',
    async (req, reply) => {
      const { version } = req.params;
      const sprint = readSprint(projectRoot, version);

      if (!sprint) {
        return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
      }

      const currentPhase = (sprint.phase ?? 'planned') as Phase;
      const currentIdx = PHASE_ORDER.indexOf(currentPhase);

      if (currentIdx === -1) {
        return reply.status(422).send({
          error: `Unknown phase "${currentPhase}"`,
          code: 'UNKNOWN_PHASE',
        });
      }

      if (currentIdx >= PHASE_ORDER.length - 1) {
        return reply.status(409).send({
          error: `Sprint v${version} is already in final phase "${currentPhase}"`,
          code: 'ALREADY_FINAL_PHASE',
        });
      }

      const previousPhase = currentPhase;
      const newPhase = PHASE_ORDER[currentIdx + 1] as Phase;

      sprint.phase = newPhase;
      writeSprint(projectRoot, version, sprint);

      globalStream.emit({
        type: 'sprint_event',
        category: 'sprint',
        message: `Sprint v${version} advanced: ${previousPhase} → ${newPhase}`,
        data: { type: 'phase_advanced', version, previousPhase, newPhase },
      });

      return reply.send({ data: sprint });
    },
  );

  // ── PATCH /api/v5/sprints/:version/items/:itemId — Update a sprint item ──

  app.patch<{
    Params: { version: string; itemId: string };
    Body: UpdateItemBody;
  }>('/api/v5/sprints/:version/items/:itemId', async (req, reply) => {
    const { version, itemId } = req.params;
    const body = req.body ?? {};

    const sprint = readSprint(projectRoot, version);
    if (!sprint) {
      return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
    }

    const item = sprint.items.find((i) => i.id === itemId);
    if (!item) {
      return reply.status(404).send({ error: 'Item not found', code: 'ITEM_NOT_FOUND' });
    }

    const previousStatus = item.status;

    if (body.status !== undefined) item.status = body.status;
    if (body.assignee !== undefined) item.assignee = body.assignee;

    // Record completion timestamp when transitioning to completed
    if (body.status === 'completed' && previousStatus !== 'completed') {
      item.completedAt = nowIso();
    }

    writeSprint(projectRoot, version, sprint);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${version} item "${item.title}" updated`,
      data: {
        type: 'item_updated',
        version,
        itemId,
        previousStatus,
        status: item.status,
        assignee: item.assignee,
      },
    });

    return reply.send({ data: item });
  });

  // ── GET /api/v5/sprints/:version/status — Get sprint execution status ────

  app.get<{ Params: { version: string } }>(
    '/api/v5/sprints/:version/status',
    async (req, reply) => {
      const { version } = req.params;
      const sprint = readSprint(projectRoot, version);

      if (!sprint) {
        return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
      }

      // Tally items by status
      const byStatus: Record<string, number> = {
        planned: 0,
        in_progress: 0,
        completed: 0,
        blocked: 0,
        deferred: 0,
      };
      for (const item of sprint.items) {
        byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      }

      // Derive unique agents involved (both from items and the stored list)
      const agentsFromItems = sprint.items
        .map((i) => i.assignee)
        .filter(Boolean);
      const agentsInvolved = Array.from(
        new Set([...(sprint.agentsInvolved ?? []), ...agentsFromItems]),
      );

      return reply.send({
        data: {
          sprintId: sprint.sprintId,
          version: sprint.version,
          title: sprint.title,
          currentPhase: sprint.phase,
          items: {
            total: sprint.items.length,
            byStatus,
          },
          budgetTotal: sprint.budget,
          budgetUsed: sprint.budgetUsed ?? 0,
          agentsInvolved,
          createdAt: sprint.createdAt,
          phaseResults: sprint.phaseResults ?? [],
        },
      });
    },
  );

  // ── POST /api/v5/sprints/:version/execute — Trigger execution of items ───
  //
  // This route has a unique response shape (started/skipped/totalInProgress
  // counts) and dispatches per-item agent runs in fire-and-forget background
  // tasks. It is NOT covered by `runExecutePhase` in phase-handlers.ts —
  // that handler is the simpler /run-phase variant which only flips planned
  // items to in_progress. The per-item dispatch logic stays inline here.

  app.post<{ Params: { version: string } }>(
    '/api/v5/sprints/:version/execute',
    async (req, reply) => {
      const { version } = req.params;
      const sprint = readSprint(projectRoot, version);

      if (!sprint) {
        return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
      }

      // Advance phase to execute if not already there or past it
      const currentIdx = PHASE_ORDER.indexOf(sprint.phase as Phase);
      const executeIdx = PHASE_ORDER.indexOf('execute');
      if (currentIdx < executeIdx) {
        sprint.phase = 'execute';
      }

      // Mark all planned items as in_progress
      const plannedItems = sprint.items.filter((i) => i.status === 'planned');
      for (const item of plannedItems) {
        item.status = 'in_progress';
      }

      writeSprint(projectRoot, version, sprint);

      globalStream.emit({
        type: 'sprint_event',
        category: 'sprint',
        message: `Sprint v${version} execution started — ${plannedItems.length} items dispatched`,
        data: {
          type: 'execution_started',
          version,
          itemCount: plannedItems.length,
        },
      });

      // Return immediately — fire-and-forget per item
      const inProgressItems = sprint.items.filter((i) => i.status === 'in_progress');

      // Reply before launching background work so HTTP response is immediate
      reply.status(202).send({
        data: {
          started: plannedItems.length,
          skipped: sprint.items.length - plannedItems.length,
          totalInProgress: inProgressItems.length,
        },
      });

      // Background: dispatch each in-progress item to its assigned agent
      for (const item of inProgressItems) {
        if (!item.assignee) {
          continue;
        }

        // Fire and forget — do not await
        void (async () => {
          const itemStartedAt = Date.now();

          try {
            const config = await loadAgentConfig(item.assignee, agentforgeDir);
            if (!config) {
              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} item "${item.title}" skipped — agent "${item.assignee}" not found`,
                data: {
                  type: 'item_skipped',
                  version,
                  itemId: item.id,
                  assignee: item.assignee,
                  reason: 'agent_not_found',
                },
              });
              return;
            }

            config.workspaceId = 'default';
            const runtime = new AgentRuntime(config);
            const sessionId = `sprint-${version}-${item.id}-${generateId()}`;

            // Emit item_started event
            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} item "${item.title}" started → ${item.assignee}`,
              data: {
                type: 'item_started',
                version,
                itemId: item.id,
                title: item.title,
                assignee: item.assignee,
                sessionId,
              },
            });

            const result = await runtime.runStreaming({
              task: `Sprint v${version} — ${item.title}\n\n${item.description}`,
              onEvent: (event) => {
                if (event.type === 'chunk') {
                  const chunkData = event.data as { text?: string; index?: number };
                  // Emit item_chunk event for streaming tokens
                  globalStream.emit({
                    type: 'agent_activity',
                    category: 'sprint',
                    message: `[${item.assignee}] chunk`,
                    data: {
                      type: 'item_chunk',
                      version,
                      itemId: item.id,
                      assignee: item.assignee,
                      sessionId,
                      text: chunkData.text ?? '',
                      index: chunkData.index ?? 0,
                    },
                  });
                }
              },
            });

            const durationMs = Date.now() - itemStartedAt;

            // Post-task career hook
            try {
              careerHook.postTaskHook(item.assignee, {
                taskId: result.sessionId || generateId(),
                success: result.status === 'completed',
                summary: `Sprint v${version}: ${item.title}`,
                tokensUsed: result.inputTokens + result.outputTokens,
              });
            } catch {
              // Career hook errors are non-fatal
            }

            // Update item status on disk once the agent finishes
            const freshSprint = readSprint(projectRoot, version);
            if (freshSprint) {
              const freshItem = freshSprint.items.find((i) => i.id === item.id);
              if (freshItem) {
                freshItem.status = result.status === 'completed' ? 'completed' : 'blocked';
                if (result.status === 'completed') freshItem.completedAt = nowIso();

                // Track cumulative cost
                freshSprint.budgetUsed = (freshSprint.budgetUsed ?? 0) + result.costUsd;

                // Track agent
                if (!freshSprint.agentsInvolved) freshSprint.agentsInvolved = [];
                if (!freshSprint.agentsInvolved.includes(item.assignee)) {
                  freshSprint.agentsInvolved.push(item.assignee);
                }

                writeSprint(projectRoot, version, freshSprint);
              }
            }

            if (result.status === 'completed') {
              // Emit item_completed event
              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} item "${item.title}" completed (cost: $${result.costUsd.toFixed(4)})`,
                data: {
                  type: 'item_completed',
                  version,
                  itemId: item.id,
                  title: item.title,
                  assignee: item.assignee,
                  sessionId: result.sessionId,
                  status: result.status,
                  costUsd: result.costUsd,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  durationMs,
                },
              });
            } else {
              // Emit item_failed event
              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} item "${item.title}" failed: ${result.error ?? 'unknown error'}`,
                data: {
                  type: 'item_failed',
                  version,
                  itemId: item.id,
                  title: item.title,
                  assignee: item.assignee,
                  sessionId: result.sessionId,
                  status: result.status,
                  costUsd: result.costUsd,
                  error: result.error,
                  durationMs,
                },
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Mark item as blocked on disk
            const freshSprint = readSprint(projectRoot, version);
            if (freshSprint) {
              const freshItem = freshSprint.items.find((i) => i.id === item.id);
              if (freshItem && freshItem.status === 'in_progress') {
                freshItem.status = 'blocked';
                writeSprint(projectRoot, version, freshSprint);
              }
            }

            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} item "${item.title}" failed: ${message.slice(0, 200)}`,
              data: {
                type: 'item_failed',
                version,
                itemId: item.id,
                title: item.title,
                assignee: item.assignee,
                error: message,
              },
            });
          }
        })();
      }
    },
  );

  // ── POST /api/v5/sprints/:version/run-phase — Execute the current phase ──
  //
  // Thin wrapper around PHASE_HANDLERS. The route validates the sprint and
  // current phase, then either:
  //   - awaits the handler (release/learn — synchronous disk side-effects
  //     must be visible before the 202 reply)
  //   - fires the handler in a `void` background block (audit/plan/test/
  //     review/gate/assign/execute — these were `void (async () => {})()`
  //     in v6.3 and the handler now performs that same background work).
  // Response shapes are unchanged from v6.3 to keep the regression test
  // green.

  app.post<{ Params: { version: string } }>(
    '/api/v5/sprints/:version/run-phase',
    async (req, reply) => {
      const { version } = req.params;
      const sprint = readSprint(projectRoot, version);

      if (!sprint) {
        return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
      }

      const currentPhase = (sprint.phase ?? 'planned') as Phase;
      const currentIdx = PHASE_ORDER.indexOf(currentPhase);

      if (currentIdx === -1) {
        return reply.status(422).send({
          error: `Unknown phase "${currentPhase}"`,
          code: 'UNKNOWN_PHASE',
        });
      }

      if (currentPhase === 'completed') {
        return reply.status(409).send({
          error: `Sprint v${version} is already completed`,
          code: 'SPRINT_COMPLETED',
        });
      }

      // Determine agent for this phase. For phases that need an LLM agent
      // and don't have one mapped (e.g. "planned"), the route returns 422.
      const agentId = PHASE_AGENT_MAP[currentPhase];

      const ctx = buildPhaseContext({ sprint, projectRoot, agentforgeDir });
      const phaseName = currentPhase as PhaseName;
      const handler = PHASE_HANDLERS[phaseName];

      // Phases handled inline without an LLM agent (assign, execute, release, learn)
      if (currentPhase === 'assign') {
        reply.status(202).send({
          data: {
            phase: currentPhase,
            message: 'Auto-delegation running in background',
          },
        });

        void handler(ctx).catch(() => {
          // Errors are already published on the bus and globalStream from
          // inside the handler; swallow here so the unhandled rejection
          // logger doesn't fire.
        });

        return;
      }

      if (currentPhase === 'execute') {
        reply.status(202).send({
          data: {
            phase: currentPhase,
            message: 'Execute phase delegated — use /execute endpoint or poll /status',
          },
        });

        void handler(ctx).catch(() => {
          // Errors are already published on the bus and globalStream from
          // inside the handler; swallow here.
        });

        return;
      }

      if (currentPhase === 'release') {
        // Release writes to disk synchronously, then advances to learn.
        // The regression test asserts the disk side-effect is visible
        // before the 202 reply, so we await the handler here.
        try {
          await handler(ctx);
        } catch {
          // Errors are already published from inside the handler; we still
          // need to send a reply to the client.
        }

        return reply.status(202).send({
          data: {
            phase: currentPhase,
            message: `Sprint v${version} released`,
            nextPhase: PHASE_ORDER[currentIdx + 1],
          },
        });
      }

      if (currentPhase === 'learn') {
        // Learn writes to disk synchronously, then marks completed.
        try {
          await handler(ctx);
        } catch {
          // Errors are already published from inside the handler.
        }

        return reply.status(202).send({
          data: { phase: currentPhase, message: `Sprint v${version} marked completed` },
        });
      }

      // Phases that require an LLM agent: audit, plan, test, review, gate
      if (!agentId) {
        return reply.status(422).send({
          error: `No agent configured for phase "${currentPhase}"`,
          code: 'NO_PHASE_AGENT',
        });
      }

      // Reply 202 immediately, run agent in background
      reply.status(202).send({
        data: {
          phase: currentPhase,
          agentId,
          message: `Phase "${currentPhase}" agent "${agentId}" running in background`,
        },
      });

      void handler(ctx).catch(() => {
        // Errors are already published on the bus and globalStream from
        // inside the handler; swallow here so the unhandled rejection
        // logger doesn't fire.
      });
    },
  );
}
