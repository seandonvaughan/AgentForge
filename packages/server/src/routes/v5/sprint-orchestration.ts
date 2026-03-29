import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { globalStream } from './stream.js';
import { careerHook } from '../../lib/career-hook.js';
import { AutoDelegationPipeline } from '../../lib/auto-delegation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default project root: up from packages/server/src/routes/v5/ → monorepo root
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Phase order — "planned" is the initial state before audit begins
// ---------------------------------------------------------------------------

const PHASE_ORDER = [
  'planned',
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
  'completed',
] as const;

type Phase = typeof PHASE_ORDER[number];

// ---------------------------------------------------------------------------
// Sprint item shape (matches SprintItem in sprint-framework.ts + status set)
// ---------------------------------------------------------------------------

interface SprintItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  completedAt?: string;
}

interface PhaseResult {
  phase: string;
  agentId: string;
  sessionId: string;
  response: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  status: 'completed' | 'failed';
  ranAt: string;
  error?: string;
}

interface SprintFile {
  sprintId: string;
  version: string;
  title: string;
  createdAt: string;
  phase: string;
  items: SprintItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
  auditFindings: string[];
  agentsInvolved?: string[];
  budgetUsed?: number;
  phaseResults?: PhaseResult[];
}

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
// File helpers
// ---------------------------------------------------------------------------

function sprintsDir(projectRoot: string): string {
  return join(projectRoot, '.agentforge/sprints');
}

function sprintPath(projectRoot: string, version: string): string {
  return join(sprintsDir(projectRoot), `v${version}.json`);
}

function readSprint(projectRoot: string, version: string): SprintFile | null {
  const file = sprintPath(projectRoot, version);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SprintFile;
  } catch {
    return null;
  }
}

function writeSprint(projectRoot: string, version: string, sprint: SprintFile): void {
  const dir = sprintsDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sprintPath(projectRoot, version), JSON.stringify(sprint, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Phase agent mapping
// ---------------------------------------------------------------------------

const PHASE_AGENT_MAP: Partial<Record<Phase, string>> = {
  audit: 'researcher',
  plan: 'cto',
  test: 'backend-qa',
  review: 'code-reviewer',
  gate: 'ceo',
};

// ---------------------------------------------------------------------------
// Helper: run a phase agent via AgentRuntime.runStreaming() with SSE events
// ---------------------------------------------------------------------------

async function runPhaseAgent(opts: {
  agentId: string;
  task: string;
  version: string;
  phase: Phase;
  projectRoot: string;
  agentforgeDir: string;
}): Promise<{ result: import('@agentforge/core').RunResult; sessionId: string }> {
  const { agentId, task, version, phase, agentforgeDir } = opts;

  const config = await loadAgentConfig(agentId, agentforgeDir);
  if (!config) {
    throw new Error(`Agent "${agentId}" not found in ${agentforgeDir}/agents/`);
  }

  config.workspaceId = 'default';
  const runtime = new AgentRuntime(config);
  const sessionId = `phase-${version}-${phase}-${generateId()}`;

  globalStream.emit({
    type: 'sprint_event',
    category: 'sprint',
    message: `Sprint v${version} phase "${phase}" started — agent: ${agentId}`,
    data: {
      type: 'phase_started',
      version,
      phase,
      agentId,
      sessionId,
    },
  });

  const result = await runtime.runStreaming({
    task,
    onEvent: (event) => {
      if (event.type === 'chunk') {
        const chunkData = event.data as { text?: string; index?: number };
        globalStream.emit({
          type: 'agent_activity',
          category: 'sprint',
          message: `[${agentId}] chunk`,
          data: {
            type: 'phase_chunk',
            version,
            phase,
            agentId,
            sessionId,
            text: chunkData.text ?? '',
            index: chunkData.index ?? 0,
          },
        });
      }
    },
  });

  return { result, sessionId };
}

// ---------------------------------------------------------------------------
// Helper: post-task career hook
// ---------------------------------------------------------------------------

function fireCareerHook(
  agentId: string,
  result: import('@agentforge/core').RunResult,
  taskTitle: string,
): void {
  try {
    careerHook.postTaskHook(agentId, {
      taskId: result.sessionId || generateId(),
      success: result.status === 'completed',
      summary: taskTitle,
      tokensUsed: result.inputTokens + result.outputTokens,
    });
  } catch {
    // Career hook errors are non-fatal
  }
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
            fireCareerHook(item.assignee, result, `Sprint v${version}: ${item.title}`);

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

      // Determine agent and task for this phase
      const agentId = PHASE_AGENT_MAP[currentPhase];
      const itemTitles = sprint.items.map((i) => i.title).join(', ');

      // For phases that need special handling (assign, execute, release, learn)
      // we do the work inline without an LLM agent.
      if (currentPhase === 'assign') {
        // Run auto-delegation synchronously
        reply.status(202).send({
          data: {
            phase: currentPhase,
            message: 'Auto-delegation running in background',
          },
        });

        void (async () => {
          try {
            const pipeline = new AutoDelegationPipeline();
            const delegationResult = pipeline.delegateSprint(
              sprint.items.map((item) => ({
                id: item.id,
                title: item.title,
                description: item.description,
                priority: item.priority,
                assignee: item.assignee,
                status: item.status,
              })),
            );

            // Apply assignments back to sprint items
            const freshSprint = readSprint(projectRoot, version);
            if (freshSprint) {
              for (const [agentAssignee, itemIds] of delegationResult.assignments) {
                for (const itemId of itemIds) {
                  const freshItem = freshSprint.items.find((i) => i.id === itemId);
                  if (freshItem && !freshItem.assignee) {
                    freshItem.assignee = agentAssignee;
                  }
                }
              }

              // Store phase result
              if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
              freshSprint.phaseResults.push({
                phase: currentPhase,
                agentId: 'auto-delegation',
                sessionId: `phase-${version}-assign-${generateId()}`,
                response: JSON.stringify({
                  steps: delegationResult.steps.length,
                  assignments: Object.fromEntries(delegationResult.assignments),
                  unassigned: delegationResult.unassigned,
                }),
                costUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
                status: 'completed',
                ranAt: nowIso(),
              });

              // Advance to next phase
              const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase;
              freshSprint.phase = nextPhase;
              writeSprint(projectRoot, version, freshSprint);

              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} phase "assign" completed — auto-delegated ${delegationResult.assignments.size} assignments, advanced to "${nextPhase}"`,
                data: {
                  type: 'phase_completed',
                  version,
                  phase: currentPhase,
                  nextPhase,
                  assignmentCount: delegationResult.assignments.size,
                  unassignedCount: delegationResult.unassigned.length,
                },
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} phase "assign" failed: ${message.slice(0, 200)}`,
              data: {
                type: 'phase_failed',
                version,
                phase: currentPhase,
                error: message,
              },
            });
          }
        })();

        return;
      }

      if (currentPhase === 'execute') {
        // Delegate to the existing execute endpoint logic in background
        reply.status(202).send({
          data: {
            phase: currentPhase,
            message: 'Execute phase delegated — use /execute endpoint or poll /status',
          },
        });

        // Forward to execute logic: mark planned items as in_progress
        void (async () => {
          try {
            const freshSprint = readSprint(projectRoot, version);
            if (!freshSprint) return;

            const plannedItems = freshSprint.items.filter((i) => i.status === 'planned');
            for (const item of plannedItems) {
              item.status = 'in_progress';
            }
            writeSprint(projectRoot, version, freshSprint);

            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} execute phase — ${plannedItems.length} items moved to in_progress`,
              data: {
                type: 'phase_started',
                version,
                phase: currentPhase,
                itemCount: plannedItems.length,
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} execute phase setup failed: ${message.slice(0, 200)}`,
              data: { type: 'phase_failed', version, phase: currentPhase, error: message },
            });
          }
        })();

        return;
      }

      if (currentPhase === 'release') {
        // Update sprint status to released, advance to learn
        const freshSprint = readSprint(projectRoot, version);
        if (freshSprint) {
          if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
          freshSprint.phaseResults.push({
            phase: currentPhase,
            agentId: 'system',
            sessionId: `phase-${version}-release-${generateId()}`,
            response: `Sprint v${version} released at ${nowIso()}`,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            status: 'completed',
            ranAt: nowIso(),
          });

          const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase;
          freshSprint.phase = nextPhase;
          writeSprint(projectRoot, version, freshSprint);

          globalStream.emit({
            type: 'sprint_event',
            category: 'sprint',
            message: `Sprint v${version} released — advanced to "${nextPhase}"`,
            data: { type: 'phase_completed', version, phase: currentPhase, nextPhase },
          });
        }

        return reply.status(202).send({
          data: { phase: currentPhase, message: `Sprint v${version} released`, nextPhase: PHASE_ORDER[currentIdx + 1] },
        });
      }

      if (currentPhase === 'learn') {
        // Final phase: mark sprint as completed
        const freshSprint = readSprint(projectRoot, version);
        if (freshSprint) {
          const completedItems = freshSprint.items.filter((i) => i.status === 'completed').length;
          const totalItems = freshSprint.items.length;

          if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
          freshSprint.phaseResults.push({
            phase: currentPhase,
            agentId: 'system',
            sessionId: `phase-${version}-learn-${generateId()}`,
            response: `Sprint v${version} completed. ${completedItems}/${totalItems} items done. Total cost: $${(freshSprint.budgetUsed ?? 0).toFixed(4)}`,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            status: 'completed',
            ranAt: nowIso(),
          });

          freshSprint.phase = 'completed';
          writeSprint(projectRoot, version, freshSprint);

          globalStream.emit({
            type: 'sprint_event',
            category: 'sprint',
            message: `Sprint v${version} learn phase complete — sprint marked completed (${completedItems}/${totalItems} items)`,
            data: {
              type: 'phase_completed',
              version,
              phase: currentPhase,
              nextPhase: 'completed',
              completedItems,
              totalItems,
              totalCostUsd: freshSprint.budgetUsed ?? 0,
            },
          });
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

      // Build phase-specific task prompt
      let task: string;
      switch (currentPhase) {
        case 'audit':
          task = `Audit the codebase and identify issues for sprint "${sprint.title}" (v${version}). Focus on code quality, technical debt, security vulnerabilities, and performance bottlenecks. Provide a structured list of findings.`;
          break;
        case 'plan':
          task = `Create a technical plan for the following sprint items: ${itemTitles}. Sprint: "${sprint.title}" (v${version}). Provide implementation approach, dependencies, risks, and effort estimates for each item.`;
          break;
        case 'test':
          task = `Run the test suite and report results for sprint v${version}: "${sprint.title}". Check coverage, identify failing tests, and summarise overall quality gate status.`;
          break;
        case 'review':
          task = `Review all code changes from sprint v${version}: "${sprint.title}". Evaluate code quality, adherence to patterns, test coverage, and readiness for release.`;
          break;
        case 'gate':
          {
            const lastPhaseResults = sprint.phaseResults ?? [];
            const testResult = lastPhaseResults.filter((r) => r.phase === 'test').pop();
            const reviewResult = lastPhaseResults.filter((r) => r.phase === 'review').pop();
            const testSummary = testResult?.response?.slice(0, 500) ?? 'No test results available';
            const reviewSummary = reviewResult?.response?.slice(0, 500) ?? 'No review results available';
            task = `Approve or reject sprint v${version}: "${sprint.title}" based on the following results.\n\nTest results: ${testSummary}\n\nCode review: ${reviewSummary}\n\nProvide a clear APPROVE or REJECT decision with rationale.`;
          }
          break;
        default:
          task = `Execute phase "${currentPhase}" for sprint v${version}: "${sprint.title}".`;
      }

      // Reply 202 immediately, run agent in background
      reply.status(202).send({
        data: {
          phase: currentPhase,
          agentId,
          message: `Phase "${currentPhase}" agent "${agentId}" running in background`,
        },
      });

      // Background execution
      void (async () => {
        try {
          const { result, sessionId } = await runPhaseAgent({
            agentId,
            task,
            version,
            phase: currentPhase,
            projectRoot,
            agentforgeDir,
          });

          // Post-task career hook
          fireCareerHook(agentId, result, `Sprint v${version} phase ${currentPhase}`);

          // Store phase result in sprint file
          const freshSprint = readSprint(projectRoot, version);
          if (freshSprint) {
            if (!freshSprint.phaseResults) freshSprint.phaseResults = [];

            const phaseResult: PhaseResult = {
              phase: currentPhase,
              agentId,
              sessionId,
              response: result.response,
              costUsd: result.costUsd,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              status: result.status,
              ranAt: nowIso(),
              ...(result.error !== undefined ? { error: result.error } : {}),
            };
            freshSprint.phaseResults.push(phaseResult);

            // Update cumulative cost
            freshSprint.budgetUsed = (freshSprint.budgetUsed ?? 0) + result.costUsd;

            // Track agent
            if (!freshSprint.agentsInvolved) freshSprint.agentsInvolved = [];
            if (!freshSprint.agentsInvolved.includes(agentId)) {
              freshSprint.agentsInvolved.push(agentId);
            }

            // Advance to next phase on success
            if (result.status === 'completed') {
              const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase;
              freshSprint.phase = nextPhase;
            }

            writeSprint(projectRoot, version, freshSprint);

            if (result.status === 'completed') {
              const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase;
              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} phase "${currentPhase}" completed (cost: $${result.costUsd.toFixed(4)}) — advanced to "${nextPhase}"`,
                data: {
                  type: 'phase_completed',
                  version,
                  phase: currentPhase,
                  nextPhase,
                  agentId,
                  sessionId,
                  costUsd: result.costUsd,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                },
              });
            } else {
              globalStream.emit({
                type: 'sprint_event',
                category: 'sprint',
                message: `Sprint v${version} phase "${currentPhase}" failed: ${result.error ?? 'unknown error'}`,
                data: {
                  type: 'phase_failed',
                  version,
                  phase: currentPhase,
                  agentId,
                  sessionId,
                  error: result.error,
                },
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          globalStream.emit({
            type: 'sprint_event',
            category: 'sprint',
            message: `Sprint v${version} phase "${currentPhase}" failed: ${message.slice(0, 200)}`,
            data: {
              type: 'phase_failed',
              version,
              phase: currentPhase,
              agentId,
              error: message,
            },
          });
        }
      })();
    },
  );
}
