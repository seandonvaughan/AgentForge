import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { globalStream } from './stream.js';

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

      let started = 0;
      let skipped = 0;

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
          skipped++;
          continue;
        }

        // Fire and forget — do not await
        void (async () => {
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

            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} dispatching "${item.title}" → ${item.assignee}`,
              data: {
                type: 'item_dispatched',
                version,
                itemId: item.id,
                assignee: item.assignee,
                sessionId,
              },
            });

            const result = await runtime.run({
              task: `Sprint v${version} — ${item.title}\n\n${item.description}`,
            });

            started++;

            // Update item status on disk once the agent finishes
            const freshSprint = readSprint(projectRoot, version);
            if (freshSprint) {
              const freshItem = freshSprint.items.find((i) => i.id === item.id);
              if (freshItem) {
                freshItem.status = result.status === 'completed' ? 'completed' : 'blocked';
                if (result.status === 'completed') freshItem.completedAt = nowIso();

                // Track cost
                freshSprint.budgetUsed = (freshSprint.budgetUsed ?? 0) + result.costUsd;

                // Track agent
                if (!freshSprint.agentsInvolved) freshSprint.agentsInvolved = [];
                if (!freshSprint.agentsInvolved.includes(item.assignee)) {
                  freshSprint.agentsInvolved.push(item.assignee);
                }

                writeSprint(projectRoot, version, freshSprint);
              }
            }

            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} item "${item.title}" ${result.status} (cost: $${result.costUsd.toFixed(4)})`,
              data: {
                type: 'item_completed',
                version,
                itemId: item.id,
                assignee: item.assignee,
                sessionId: result.sessionId,
                status: result.status,
                costUsd: result.costUsd,
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            globalStream.emit({
              type: 'sprint_event',
              category: 'sprint',
              message: `Sprint v${version} item "${item.title}" failed: ${message.slice(0, 200)}`,
              data: {
                type: 'item_failed',
                version,
                itemId: item.id,
                assignee: item.assignee,
                error: message,
              },
            });
          }
        })();
      }

      // Note: `started` / `skipped` counts in reply body reflect planning-time counts.
      // The actual runtime counts are tracked via SSE events above.
      void started;
      void skipped;
    },
  );
}
