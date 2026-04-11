/**
 * Run routes — POST /api/v5/run, GET /api/v5/run/history
 *
 * Provides manual agent dispatch from the dashboard runner page.
 * POST /api/v5/run: Spawns a Claude CLI subprocess for the requested agent,
 *   broadcasts stdout chunks via SSE as `agent_activity` events, and returns
 *   a sessionId immediately so the already-open SSE client can correlate events.
 * GET /api/v5/run/history: Returns the most recent sessions from the DB in
 *   the RunHistory shape expected by the runner page.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import type { SseManager } from '../sse/sse-manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps model tier to Claude CLI model ID. */
const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-5-20251001',
};

/** Maps model tier to effort level. */
const EFFORT_MAP: Record<string, string> = {
  opus: 'high',
  sonnet: 'medium',
  haiku: 'low',
};

/** Maximum recent runs returned by GET /api/v5/run/history. */
const HISTORY_LIMIT = 20;

/** Project agents directory (resolved relative to cwd). */
const AGENTS_DIR = join(process.cwd(), '.agentforge', 'agents');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunRoutesOptions {
  adapter: SqliteAdapter;
  sseManager?: SseManager;
}

interface RunHistory {
  id: string;
  agentId: string;
  task: string;
  status: 'completed' | 'failed' | 'running';
  costUsd?: number;
  startedAt: string;
  output?: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the system prompt for a given agentId from the agents directory.
 * Returns an empty string if the YAML cannot be read (non-fatal).
 */
async function loadSystemPrompt(agentId: string): Promise<string> {
  try {
    const entries = await readdir(AGENTS_DIR);
    const match = entries.find(f =>
      (f === `${agentId}.yaml` || f === `${agentId}.yml`)
    );
    if (!match) return '';
    const raw = await readFile(join(AGENTS_DIR, match), 'utf-8');
    // Extract system_prompt or description field from YAML (minimal inline parse)
    const sysMatch = raw.match(/^system_prompt:\s*[|>-]?\s*\n?([\s\S]*?)(?=\n\w|\n*$)/m);
    if (sysMatch) return sysMatch[1].replace(/^  /gm, '').trim();
    const descMatch = raw.match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
    return '';
  } catch {
    return '';
  }
}

/**
 * Look up the model tier for an agent from its YAML file.
 * Defaults to 'sonnet' when the file is absent or the field is not set.
 */
async function loadAgentModel(agentId: string): Promise<string> {
  try {
    const entries = await readdir(AGENTS_DIR);
    const match = entries.find(f =>
      (f === `${agentId}.yaml` || f === `${agentId}.yml`)
    );
    if (!match) return 'sonnet';
    const raw = await readFile(join(AGENTS_DIR, match), 'utf-8');
    const modelMatch = raw.match(/^model:\s*(.+)$/m);
    if (!modelMatch) return 'sonnet';
    const tier = modelMatch[1].trim().toLowerCase();
    return MODEL_MAP[tier] ? tier : 'sonnet';
  } catch {
    return 'sonnet';
  }
}

/**
 * Parse a single stream-json line emitted by `claude --output-format stream-json`.
 * Returns text content and, on the final `result` line, cost data.
 */
function parseStreamLine(line: string): {
  text?: string;
  costUsd?: number;
  modelUsed?: string;
  isDone?: boolean;
} {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }

  if (data['type'] === 'assistant') {
    const msg = data['message'] as Record<string, unknown> | undefined;
    const contentArr = msg?.['content'] as Array<Record<string, unknown>> | undefined;
    let text = '';
    if (Array.isArray(contentArr)) {
      for (const block of contentArr) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          text += block['text'];
        }
      }
    }
    return { text: text || undefined };
  }

  if (data['type'] === 'result') {
    const costUsd = (data['total_cost_usd'] as number | undefined) ?? 0;
    const modelUsage = data['modelUsage'] as Record<string, unknown> | undefined;
    const modelUsed = modelUsage ? Object.keys(modelUsage)[0] : undefined;
    return { costUsd, modelUsed, isDone: true };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function runRoutes(
  app: FastifyInstance,
  opts: RunRoutesOptions,
): Promise<void> {
  const { adapter, sseManager } = opts;

  // ── GET /api/v5/run/history ─────────────────────────────────────────────
  // Returns the 20 most recent sessions formatted as RunHistory entries.
  // Must be registered before /:id routes to avoid shadowing.
  app.get('/api/v5/run/history', async (_req, reply) => {
    const sessions = adapter.listSessions({ limit: HISTORY_LIMIT });

    const data: RunHistory[] = sessions.map(s => ({
      id: s.id,
      agentId: s.agent_id,
      task: s.task,
      status: s.status === 'failed' ? 'failed'
        : s.status === 'running' ? 'running'
        : 'completed',
      startedAt: s.started_at,
      output: s.response ?? undefined,
      sessionId: s.id,
    }));

    return reply.send({ data });
  });

  // ── POST /api/v5/run ────────────────────────────────────────────────────
  // Dispatches a Claude CLI agent subprocess for the requested agentId + task.
  // Returns sessionId immediately; streams progress via SSE agent_activity events.
  app.post('/api/v5/run', async (req, reply) => {
    const body = req.body as { agentId?: string; task?: string };
    const agentId = body?.agentId?.trim() ?? '';
    const task = body?.task?.trim() ?? '';

    if (!agentId || !task) {
      return reply.status(400).send({ error: 'agentId and task are required' });
    }

    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();

    // Resolve model tier and system prompt from agent YAML
    const [modelTier, systemPrompt] = await Promise.all([
      loadAgentModel(agentId),
      loadSystemPrompt(agentId),
    ]);

    const modelId = MODEL_MAP[modelTier] ?? MODEL_MAP['sonnet']!;
    const effort = EFFORT_MAP[modelTier] ?? 'medium';

    const args = [
      '-p', task,
      '--model', modelId,
      '--effort', effort,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Spawn non-blocking — reply returns immediately with the sessionId.
    // SSE broadcast carries the actual output stream.
    let fullOutput = '';
    let finalCost: number | undefined;
    let finalModel = modelId;

    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdoutBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      // Process complete newline-delimited JSON lines
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? ''; // last element may be incomplete
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseStreamLine(line);
        if (parsed.text) {
          fullOutput += parsed.text;
          if (sseManager) {
            sseManager.broadcast('agent_activity', {
              sessionId,
              agentId,
              content: parsed.text,
              timestamp: new Date().toISOString(),
            });
          }
        }
        if (parsed.isDone) {
          finalCost = parsed.costUsd;
          if (parsed.modelUsed) finalModel = parsed.modelUsed;
        }
      }
    });

    child.on('close', (code) => {
      // Flush any remaining partial line
      if (stdoutBuf.trim()) {
        const parsed = parseStreamLine(stdoutBuf);
        if (parsed.text) {
          fullOutput += parsed.text;
          if (sseManager) {
            sseManager.broadcast('agent_activity', {
              sessionId,
              agentId,
              content: parsed.text,
              timestamp: new Date().toISOString(),
            });
          }
        }
        if (parsed.isDone && parsed.costUsd !== undefined) {
          finalCost = parsed.costUsd;
        }
      }

      const status = code === 0 ? 'completed' : 'failed';

      if (sseManager) {
        sseManager.broadcast('workflow_event', {
          sessionId,
          agentId,
          status,
          costUsd: finalCost,
          timestamp: new Date().toISOString(),
        });
      }
    });

    child.on('error', () => {
      // Claude CLI not available — broadcast failure
      if (sseManager) {
        sseManager.broadcast('workflow_event', {
          sessionId,
          agentId,
          status: 'failed',
          error: 'claude CLI not available on this server',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Return immediately with the sessionId — client correlates via SSE
    return reply.status(202).send({
      data: {
        sessionId,
        agentId,
        model: finalModel,
        status: 'running',
        startedAt,
      },
    });
  });
}
