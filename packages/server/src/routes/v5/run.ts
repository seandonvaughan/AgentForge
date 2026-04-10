import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
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
}

// careerHook singleton is imported from lib/career-hook.ts

/** In-memory run log — stores completed/failed runs for session replay. */
const runLog = new Map<string, {
  sessionId: string;
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
  error?: string;
}>();

export function getRunLog() {
  return runLog;
}

export async function runRoutes(
  app: FastifyInstance,
  opts?: { adapter?: WorkspaceAdapter },
): Promise<void> {
  const adapter = opts?.adapter;

  // POST /api/v5/run — execute an agent with streaming SSE events
  app.post<{ Body: RunRequestBody }>('/api/v5/run', async (req, reply) => {
    const { agentId, task, projectRoot } = req.body ?? {};

    if (!agentId) return reply.status(400).send({ error: 'agentId is required' });
    if (!task) return reply.status(400).send({ error: 'task is required' });

    const root = projectRoot ?? DEFAULT_PROJECT_ROOT;
    const agentforgeDir = join(root, '.agentforge');

    const config = await loadAgentConfig(agentId, agentforgeDir);
    if (!config) return reply.status(404).send({ error: 'Agent not found' });

    config.workspaceId = 'default';
    const runtime = new AgentRuntime(config, adapter);
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

    try {
      const result = await runtime.runStreaming({
        task,
        // Wire onChunk so SSE clients see content arrive before the HTTP response.
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
          // The 'done' event signals completion — content already delivered via onChunk.
          // Do not add content here to avoid double-appending on the client side.
          globalStream.emit({
            type: 'agent_activity',
            category: 'run',
            message: event.type === 'chunk'
              ? `[${agentId}] chunk`
              : `[${agentId}] ${event.type}`,
            data: {
              ...(event.data as Record<string, unknown>),
              sessionId,
            },
          });
        },
      });

      // Persist to in-memory run log
      runLog.set(sessionId, {
        sessionId,
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
            data: { agentId, skill: levelUp.skill, newLevel: levelUp.newLevel, sessionId },
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
          sessionId,
          status: result.status,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      });

      // Emit cost event for the cost analytics page
      if (result.costUsd > 0) {
        globalStream.emit({
          type: 'cost_event',
          category: 'run',
          message: `[${agentId}] $${result.costUsd.toFixed(4)} (${result.model})`,
          data: {
            sessionId,
            agentId,
            model: result.model,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        });
      }

      return reply.status(200).send({
        data: { ...result, sessionId },
      });
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

      return reply.status(500).send({ error: message, sessionId });
    }
  });

  // GET /api/v5/run/history — list all runs from in-memory log
  app.get('/api/v5/run/history', async (_req, reply) => {
    const runs = [...runLog.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
    return reply.send({
      data: runs,
      meta: { total: runLog.size, timestamp: nowIso() },
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
        return reply.send({ data: session });
      }
    }

    return reply.status(404).send({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
    });
  });
}
