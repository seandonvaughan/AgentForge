import type { FastifyInstance } from 'fastify';
import type { SessionRow, WorkspaceAdapter } from '@agentforge/db';
import {
  AgentRuntime,
  RuntimeJobSupervisor,
  loadAgentConfig,
  type ExecutionProviderKind,
  type RuntimeEventInput,
  type RunResult,
  type RuntimeMode,
} from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { globalStream } from './stream.js';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { careerHook } from '../../lib/career-hook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default project root: up from packages/server/src/routes/v5/ → monorepo root
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

interface RunRequestBody {
  agentId: string;
  task: string;
  projectRoot?: string;
  runtimeMode?: RuntimeMode;
  allowedTools?: string[];
}

interface RunQuerystring {
  wait?: string | boolean;
}

// careerHook singleton is imported from lib/career-hook.ts

interface RunLogEntry {
  sessionId: string;
  jobId?: string;
  traceId?: string;
  agentId: string;
  task: string;
  model: string;
  status: 'completed' | 'failed' | 'running';
  response: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt?: string;
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
  error?: string;
}

/** In-memory run log — stores completed/failed runs for session replay. */
const runLog = new Map<string, RunLogEntry>();

type RunCompletion =
  | { ok: true; result: RunResult; completedSessionId: string }
  | { ok: false; error: string; sessionId: string };

export function getRunLog() {
  return runLog;
}

function parseRuntimeMetadata(
  adapter: WorkspaceAdapter,
  sessionId: string,
): Pick<RunLogEntry, 'providerKind' | 'runtimeModeResolved'> {
  const event = adapter.listDecisionEvents({
    sessionId,
    decisionType: 'runtime_transport',
    limit: 1,
  })[0];

  if (!event?.payload_json) return {};

  try {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    return {
      ...(typeof payload.providerKind === 'string'
        ? { providerKind: payload.providerKind as ExecutionProviderKind }
        : {}),
      ...(typeof payload.runtimeModeResolved === 'string'
        ? { runtimeModeResolved: payload.runtimeModeResolved as RuntimeMode }
        : {}),
    };
  } catch {
    return {};
  }
}

function hydrateRunEntry(
  session: SessionRow,
  adapter?: WorkspaceAdapter,
  existing?: RunLogEntry,
): RunLogEntry {
  const runtimeMetadata = adapter ? parseRuntimeMetadata(adapter, session.id) : {};
  const completedAt = existing?.completedAt ?? session.completed_at ?? undefined;

  return {
    sessionId: session.id,
    agentId: session.agent_id,
    task: session.task,
    model: existing?.model ?? session.model ?? 'unknown',
    status: normalizeRunStatus(existing?.status ?? session.status),
    response: existing?.response ?? '',
    costUsd: existing?.costUsd ?? session.cost_usd ?? 0,
    inputTokens: existing?.inputTokens ?? session.input_tokens ?? 0,
    outputTokens: existing?.outputTokens ?? session.output_tokens ?? 0,
    startedAt: existing?.startedAt ?? session.started_at,
    ...(completedAt ? { completedAt } : {}),
    ...(existing?.providerKind ?? runtimeMetadata.providerKind
      ? { providerKind: existing?.providerKind ?? runtimeMetadata.providerKind }
      : {}),
    ...(existing?.runtimeModeResolved ?? runtimeMetadata.runtimeModeResolved
      ? { runtimeModeResolved: existing?.runtimeModeResolved ?? runtimeMetadata.runtimeModeResolved }
      : {}),
    ...(existing?.error ? { error: existing.error } : {}),
  };
}

function normalizeRunStatus(status: string): RunLogEntry['status'] {
  if (status === 'running' || status === 'failed') return status;
  return 'completed';
}

function shouldWaitForCompletion(wait: string | boolean | undefined): boolean {
  return wait === true || wait === 'true' || wait === '1';
}

function eventDataWithSession(data: unknown, sessionId: string): Record<string, unknown> {
  return {
    ...(isRecord(data) ? data : { value: data }),
    sessionId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function runRoutes(
  app: FastifyInstance,
  opts?: { adapter?: WorkspaceAdapter; supervisor?: RuntimeJobSupervisor },
): Promise<void> {
  const adapter = opts?.adapter;
  const supervisor = opts?.supervisor ?? (adapter ? new RuntimeJobSupervisor({ adapter }) : undefined);

  // POST /api/v5/run — start an agent run and stream progress over SSE.
  app.post<{ Body: RunRequestBody; Querystring: RunQuerystring }>('/api/v5/run', async (req, reply) => {
    const { agentId, task, projectRoot, runtimeMode, allowedTools } = req.body ?? {};

    if (!agentId) return reply.status(400).send({ error: 'agentId is required' });
    if (!task) return reply.status(400).send({ error: 'task is required' });

    const root = projectRoot ?? DEFAULT_PROJECT_ROOT;
    const agentforgeDir = join(root, '.agentforge');

    const config = await loadAgentConfig(agentId, agentforgeDir);
    if (!config) return reply.status(404).send({ error: 'Agent not found' });

    config.workspaceId = 'default';
    const runtime = new AgentRuntime(config, adapter);

    if (supervisor) {
      const job = supervisor.createJob({
        agentId,
        task,
        model: config.model,
        ...(runtimeMode ? { runtimeMode } : {}),
      });
      const sessionId = job.session_id;
      const startedAt = job.created_at;

      runLog.set(sessionId, {
        sessionId,
        jobId: job.id,
        traceId: job.trace_id,
        agentId,
        task,
        model: config.model,
        status: 'running',
        response: '',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        startedAt,
      });

      const executeJob = async (): Promise<RunCompletion> => {
        const result = await supervisor.startJob(job.id, async ({ signal, emit }) => {
          const emitRuntime = (event: RuntimeEventInput) => emit(event);
          const runResult = await runtime.runStreaming({
            task,
            sessionId,
            ...(runtimeMode ? { runtimeMode } : {}),
            ...(allowedTools?.length ? { allowedTools } : {}),
            signal,
            onChunk: (text: string, index: number) => {
              emitRuntime({
                type: 'chunk',
                message: `[${agentId}] chunk`,
                data: { content: text, text, index },
              });
            },
            onEvent: (event) => {
              if (event.type === 'chunk' || event.type === 'text_delta') return;
              emitRuntime({
                type: event.type,
                message: `[${agentId}] ${event.type}`,
                data: eventDataWithSession(event.data, sessionId),
              });
            },
          });

          const completedSessionId = runResult.sessionId || sessionId;
          if (completedSessionId !== sessionId) {
            runLog.delete(sessionId);
          }
          runLog.set(completedSessionId, {
            sessionId: completedSessionId,
            jobId: job.id,
            traceId: job.trace_id,
            agentId,
            task,
            model: runResult.model,
            status: runResult.status,
            response: runResult.response,
            costUsd: runResult.costUsd,
            inputTokens: runResult.inputTokens,
            outputTokens: runResult.outputTokens,
            startedAt,
            ...(runResult.completedAt !== undefined ? { completedAt: runResult.completedAt } : {}),
            ...(runResult.providerKind ? { providerKind: runResult.providerKind } : {}),
            ...(runResult.runtimeModeResolved ? { runtimeModeResolved: runResult.runtimeModeResolved } : {}),
            ...(runResult.error !== undefined ? { error: runResult.error } : {}),
          });

          try {
            const agentSkills: string[] = agentId.toLowerCase().split(/[-_]/);
            const durationMs = runResult.completedAt
              ? new Date(runResult.completedAt).getTime() - new Date(startedAt).getTime()
              : undefined;
            const { skillLevelUps } = careerHook.postTaskHook(agentId, {
              taskId: sessionId,
              success: runResult.status === 'completed',
              summary: task.slice(0, 200),
              tokensUsed: (runResult.inputTokens ?? 0) + (runResult.outputTokens ?? 0),
              ...(durationMs !== undefined ? { durationMs } : {}),
              skills: agentSkills,
            });

            for (const levelUp of skillLevelUps) {
              globalStream.emit({
                type: 'agent_activity',
                category: 'skill_levelup',
                message: `[${agentId}] skill "${levelUp.skill}" leveled up to ${levelUp.newLevel}`,
                data: { agentId, skill: levelUp.skill, newLevel: levelUp.newLevel, sessionId: completedSessionId },
              });
            }
          } catch {
            // Career hook failures must never break the run response
          }

          return runResult;
        });

        if (!result) {
          const latest = supervisor.getJob(job.id);
          const message = latest?.error ?? 'Run did not complete';
          return { ok: false, error: message, sessionId };
        }

        return { ok: true, result, completedSessionId: result.sessionId || sessionId };
      };

      if (shouldWaitForCompletion(req.query?.wait)) {
        const completion = await executeJob();
        if (!completion.ok) {
          return reply.status(500).send({ error: completion.error, sessionId: completion.sessionId, jobId: job.id, traceId: job.trace_id });
        }

        return reply.status(200).send({
          data: { ...completion.result, sessionId: completion.completedSessionId, jobId: job.id, traceId: job.trace_id },
        });
      }

      void executeJob();

      return reply.status(202).send({
        data: {
          jobId: job.id,
          sessionId,
          traceId: job.trace_id,
          status: 'running',
          agentId,
          task,
          model: config.model,
          startedAt,
        },
      });
    }

    const sessionId = `run-${generateId()}`;
    const startedAt = nowIso();

    // Track in run log immediately as "running"
    runLog.set(sessionId, {
      sessionId,
      agentId,
      task,
      model: config.model,
      status: 'running',
      response: '',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt,
    });

    // Emit start event on SSE
    globalStream.emit({
      type: 'agent_activity',
      category: 'run',
      message: `[${agentId}] run started`,
      data: { sessionId, agentId, task: task.slice(0, 100), model: config.model },
    });

    const executeRun = async (): Promise<RunCompletion> => {
      try {
        const result = await runtime.runStreaming({
          task,
          sessionId,
          ...(runtimeMode ? { runtimeMode } : {}),
          ...(allowedTools?.length ? { allowedTools } : {}),
          // The dashboard SSE handler reads event.data.content, so emit exactly that.
          onChunk: (text: string, index: number) => {
            globalStream.emit({
              type: 'agent_activity',
              category: 'run',
              message: `[${agentId}] chunk`,
              data: { content: text, index, sessionId },
            });
          },
          onEvent: (event) => {
            if (event.type === 'chunk' || event.type === 'text_delta') return;
            // Content chunks are delivered by onChunk to avoid double-appending.
            globalStream.emit({
              type: 'agent_activity',
              category: 'run',
              message: `[${agentId}] ${event.type}`,
              data: eventDataWithSession(event.data, sessionId),
            });
          },
        });

        // Persist to in-memory run log
        const completedSessionId = result.sessionId || sessionId;
        if (completedSessionId !== sessionId) {
          runLog.delete(sessionId);
        }
        runLog.set(completedSessionId, {
          sessionId: completedSessionId,
          agentId,
          task,
          model: result.model,
          status: result.status,
          response: result.response,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          startedAt,
          ...(result.completedAt !== undefined ? { completedAt: result.completedAt } : {}),
          ...(result.providerKind ? { providerKind: result.providerKind } : {}),
          ...(result.runtimeModeResolved ? { runtimeModeResolved: result.runtimeModeResolved } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        });

        // Post-task lifecycle hook: record task memory, update skills, check level-ups
        try {
          // AgentRuntimeConfig has no skills field; derive from agentId for now
          const agentSkills: string[] = agentId.toLowerCase().split(/[-_]/);

          const durationMs = result.completedAt
            ? new Date(result.completedAt).getTime() - new Date(startedAt).getTime()
            : undefined;

          const { skillLevelUps } = careerHook.postTaskHook(agentId, {
            taskId: sessionId,
            success: result.status === 'completed',
            summary: task.slice(0, 200),
            tokensUsed: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
            ...(durationMs !== undefined ? { durationMs } : {}),
            skills: agentSkills,
          });

          // Emit SSE events for any skill level-ups
          for (const levelUp of skillLevelUps) {
            globalStream.emit({
              type: 'agent_activity',
              category: 'skill_levelup',
              message: `[${agentId}] skill "${levelUp.skill}" leveled up to ${levelUp.newLevel}`,
              data: { agentId, skill: levelUp.skill, newLevel: levelUp.newLevel, sessionId: completedSessionId },
            });
          }
        } catch {
          // Career hook failures must never break the run response
        }

        // Emit completion event
        globalStream.emit({
          type: 'workflow_event',
          category: 'run',
          message: `[${agentId}] run ${result.status}`,
          data: {
            sessionId: completedSessionId,
            status: result.status,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            ...(result.providerKind ? { providerKind: result.providerKind } : {}),
            ...(result.runtimeModeResolved ? { runtimeModeResolved: result.runtimeModeResolved } : {}),
          },
        });

        // Emit cost event for the cost analytics page
        if (result.costUsd > 0) {
          globalStream.emit({
            type: 'cost_event',
            category: 'run',
            message: `[${agentId}] $${result.costUsd.toFixed(4)} (${result.model})`,
            data: {
              sessionId: completedSessionId,
              agentId,
              model: result.model,
              costUsd: result.costUsd,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              ...(result.providerKind ? { providerKind: result.providerKind } : {}),
              ...(result.runtimeModeResolved ? { runtimeModeResolved: result.runtimeModeResolved } : {}),
            },
          });
        }

        return { ok: true, result, completedSessionId };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const completedAt = nowIso();

        // Persist failure to run log
        const existing = runLog.get(sessionId);
        if (existing) {
          existing.status = 'failed';
          existing.error = message;
          existing.completedAt = completedAt;
        }

        // Emit failure event
        globalStream.emit({
          type: 'workflow_event',
          category: 'run',
          message: `[${agentId}] run failed: ${message.slice(0, 200)}`,
          data: { sessionId, status: 'failed', error: message },
        });

        return { ok: false, error: message, sessionId };
      }
    };

    if (shouldWaitForCompletion(req.query?.wait)) {
      const completion = await executeRun();
      if (!completion.ok) {
        return reply.status(500).send({ error: completion.error, sessionId: completion.sessionId });
      }

      return reply.status(200).send({
        data: { ...completion.result, sessionId: completion.completedSessionId },
      });
    }

    void executeRun();

    return reply.status(202).send({
      data: runLog.get(sessionId),
    });
  });

  // GET /api/v5/run/history — list all runs from in-memory log
  app.get('/api/v5/run/history', async (_req, reply) => {
    const runsBySessionId = new Map<string, RunLogEntry>();

    for (const [sessionId, entry] of runLog.entries()) {
      runsBySessionId.set(sessionId, entry);
    }

    if (adapter) {
      for (const session of adapter.listSessions({ limit: 100 })) {
        const existing = runsBySessionId.get(session.id);
        runsBySessionId.set(session.id, hydrateRunEntry(session, adapter, existing));
      }
    }

    const runs = [...runsBySessionId.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
    return reply.send({
      data: runs,
      meta: { total: runsBySessionId.size, timestamp: nowIso() },
    });
  });

  // GET /api/v5/run/:sessionId — retrieve a specific run
  app.get<{ Params: { sessionId: string } }>('/api/v5/run/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;

    // Check in-memory run log first
    const run = runLog.get(sessionId);
    if (run) {
      return reply.send({ data: run });
    }

    // Fall back to adapter if available
    if (adapter) {
      const session = adapter.getSession(sessionId);
      if (session) {
        return reply.send({
          data: hydrateRunEntry(session, adapter, run),
        });
      }
    }

    return reply.status(404).send({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
    });
  });
}
