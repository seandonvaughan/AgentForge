import type { FastifyInstance } from 'fastify';
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Sqlite from 'better-sqlite3';
import { globalStream } from './stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Monorepo root: packages/server/src/routes/v5/ -> up 5 levels
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// DB access — standalone SQLite connection to audit.db
// ---------------------------------------------------------------------------

let _db: Sqlite.Database | null = null;

function getChatDb(projectRoot: string = DEFAULT_PROJECT_ROOT): Sqlite.Database {
  if (_db) return _db;
  const dbPath = join(projectRoot, '.agentforge/audit.db');
  _db = new Sqlite(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // Ensure the table + indexes exist (idempotent)
  _db.prepare(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0.0
    )
  `).run();
  _db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_id ON chat_messages(agent_id)`).run();
  _db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id)`).run();
  _db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp)`).run();
  return _db;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ChatMessageRow {
  id: string;
  agent_id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  tokens_used: number;
  cost_usd: number;
}

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface ChatMessageBody {
  message: string;
  sessionId?: string;
  projectRoot?: string;
}

interface ChatRoomBody {
  agentIds: string[];
  message: string;
  sessionId?: string;
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function chatRoutes(app: FastifyInstance): Promise<void> {

  // POST /api/v5/chat/:agentId — Send a message to an agent
  app.post<{ Params: { agentId: string }; Body: ChatMessageBody }>(
    '/api/v5/chat/:agentId',
    async (req, reply) => {
      const { agentId } = req.params;
      const { message, sessionId: reqSessionId, projectRoot } = req.body ?? {};

      if (!message) {
        return reply.status(400).send({ error: 'message is required' });
      }

      const root = projectRoot ?? DEFAULT_PROJECT_ROOT;
      const agentforgeDir = join(root, '.agentforge');
      const db = getChatDb(root);

      // Resolve or create session
      const sessionId = reqSessionId ?? `chat-${generateId()}`;

      // Persist user message
      const userMsgId = `msg-${generateId()}`;
      const userTimestamp = nowIso();
      db.prepare<[string, string, string, string, string, string]>(`
        INSERT INTO chat_messages (id, agent_id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userMsgId, agentId, sessionId, 'user', message, userTimestamp);

      // Load agent config
      const config = await loadAgentConfig(agentId, agentforgeDir);
      if (!config) {
        return reply.status(404).send({ error: `Agent '${agentId}' not found` });
      }
      config.workspaceId = 'default';

      // Build conversation context from recent history (last 20 messages)
      const history = db
        .prepare<[string, string], ChatMessageRow>(`
          SELECT * FROM chat_messages
          WHERE agent_id = ? AND session_id = ?
          ORDER BY timestamp ASC
          LIMIT 20
        `)
        .all(agentId, sessionId);

      // Format history as context block (exclude the message we just inserted)
      const priorMessages = history.filter(m => m.id !== userMsgId);
      const contextLines: string[] = priorMessages.map(
        m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      );
      const context = contextLines.length > 0
        ? `Conversation history:\n${contextLines.join('\n')}`
        : undefined;

      // Emit start event on SSE
      globalStream.emit({
        type: 'agent_activity',
        category: 'chat',
        message: `[${agentId}] chat message received`,
        data: { sessionId, agentId, messageLength: message.length },
      });

      // Execute via AgentRuntime streaming
      const runtime = new AgentRuntime(config);

      let result;
      try {
        result = await runtime.runStreaming({
          task: message,
          ...(context !== undefined ? { context } : {}),
          onEvent: (event) => {
            globalStream.emit({
              type: 'agent_activity',
              category: 'chat',
              message: event.type === 'chunk'
                ? `[${agentId}] chat chunk`
                : `[${agentId}] chat ${event.type}`,
              data: {
                ...(event.data as Record<string, unknown>),
                sessionId,
                agentId,
              },
            });
          },
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: errMsg });
      }

      // Persist assistant response
      const assistantMsgId = `msg-${generateId()}`;
      const assistantTimestamp = nowIso();
      const tokensUsed = result.inputTokens + result.outputTokens;
      db.prepare<[string, string, string, string, string, string, number, number]>(`
        INSERT INTO chat_messages
          (id, agent_id, session_id, role, content, timestamp, tokens_used, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assistantMsgId,
        agentId,
        sessionId,
        'assistant',
        result.response,
        assistantTimestamp,
        tokensUsed,
        result.costUsd,
      );

      // Emit cost event if applicable
      if (result.costUsd > 0) {
        globalStream.emit({
          type: 'cost_event',
          category: 'chat',
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
        data: {
          sessionId,
          agentId,
          response: result.response,
          tokensUsed,
          costUsd: result.costUsd,
          model: result.model,
          messageId: assistantMsgId,
          timestamp: assistantTimestamp,
        },
      });
    },
  );

  // GET /api/v5/chat/:agentId/sessions — List sessions for an agent
  app.get<{ Params: { agentId: string } }>(
    '/api/v5/chat/:agentId/sessions',
    async (req, reply) => {
      const { agentId } = req.params;
      const projectRoot = (req.query as { projectRoot?: string }).projectRoot;
      const db = getChatDb(projectRoot);

      interface SessionSummaryRow {
        sessionId: string;
        messageCount: number;
        firstMessageAt: string;
        lastMessageAt: string;
      }

      const sessions = db
        .prepare<[string], SessionSummaryRow>(`
          SELECT
            session_id AS sessionId,
            COUNT(*) AS messageCount,
            MIN(timestamp) AS firstMessageAt,
            MAX(timestamp) AS lastMessageAt
          FROM chat_messages
          WHERE agent_id = ?
          GROUP BY session_id
          ORDER BY lastMessageAt DESC
        `)
        .all(agentId);

      return reply.send({
        data: sessions,
        meta: { total: sessions.length, agentId, timestamp: nowIso() },
      });
    },
  );

  // GET /api/v5/chat/:agentId/sessions/:sessionId — Full chat history
  app.get<{ Params: { agentId: string; sessionId: string } }>(
    '/api/v5/chat/:agentId/sessions/:sessionId',
    async (req, reply) => {
      const { agentId, sessionId } = req.params;
      const projectRoot = (req.query as { projectRoot?: string }).projectRoot;
      const db = getChatDb(projectRoot);

      const messages = db
        .prepare<[string, string], ChatMessageRow>(`
          SELECT * FROM chat_messages
          WHERE agent_id = ? AND session_id = ?
          ORDER BY timestamp ASC
        `)
        .all(agentId, sessionId);

      if (messages.length === 0) {
        return reply.status(404).send({
          error: 'Session not found or has no messages',
          code: 'SESSION_NOT_FOUND',
        });
      }

      return reply.send({
        data: {
          sessionId,
          agentId,
          messages: messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            tokensUsed: m.tokens_used,
            costUsd: m.cost_usd,
          })),
        },
        meta: { total: messages.length, timestamp: nowIso() },
      });
    },
  );

  // DELETE /api/v5/chat/:agentId/sessions/:sessionId — Delete a chat session
  app.delete<{ Params: { agentId: string; sessionId: string } }>(
    '/api/v5/chat/:agentId/sessions/:sessionId',
    async (req, reply) => {
      const { agentId, sessionId } = req.params;
      const projectRoot = (req.query as { projectRoot?: string }).projectRoot;
      const db = getChatDb(projectRoot);

      const result = db
        .prepare<[string, string]>(`
          DELETE FROM chat_messages
          WHERE agent_id = ? AND session_id = ?
        `)
        .run(agentId, sessionId);

      if (result.changes === 0) {
        return reply.status(404).send({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
        });
      }

      return reply.send({
        data: { deleted: true, sessionId, agentId, deletedCount: result.changes },
        meta: { timestamp: nowIso() },
      });
    },
  );

  // POST /api/v5/chat/room — Multi-agent chat room (stretch goal)
  app.post<{ Body: ChatRoomBody }>(
    '/api/v5/chat/room',
    async (req, reply) => {
      const { agentIds, message, sessionId: reqSessionId, projectRoot } = req.body ?? {};

      if (!message) {
        return reply.status(400).send({ error: 'message is required' });
      }
      if (!agentIds || agentIds.length === 0) {
        return reply.status(400).send({ error: 'agentIds must be a non-empty array' });
      }

      const root = projectRoot ?? DEFAULT_PROJECT_ROOT;
      const agentforgeDir = join(root, '.agentforge');
      const db = getChatDb(root);

      const sessionId = reqSessionId ?? `room-${generateId()}`;
      const responses: Array<{
        agentId: string;
        response: string;
        tokensUsed: number;
        costUsd: number;
        messageId: string;
        timestamp: string;
      }> = [];

      // Persist the initial user message once (tagged to 'room')
      const userMsgId = `msg-${generateId()}`;
      const userTimestamp = nowIso();
      db.prepare<[string, string, string, string, string, string]>(`
        INSERT INTO chat_messages (id, agent_id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userMsgId, 'room', sessionId, 'user', message, userTimestamp);

      // Run each agent sequentially — each sees previous agents' responses
      let accumulatedContext = `User: ${message}`;

      for (const agentId of agentIds) {
        const config = await loadAgentConfig(agentId, agentforgeDir);
        if (!config) {
          responses.push({
            agentId,
            response: `Agent '${agentId}' not found`,
            tokensUsed: 0,
            costUsd: 0,
            messageId: '',
            timestamp: nowIso(),
          });
          continue;
        }
        config.workspaceId = 'default';

        globalStream.emit({
          type: 'agent_activity',
          category: 'chat_room',
          message: `[${agentId}] room message`,
          data: { sessionId, agentId },
        });

        const runtime = new AgentRuntime(config);
        let result;
        try {
          result = await runtime.runStreaming({
            task: message,
            context: accumulatedContext,
            onEvent: (event) => {
              globalStream.emit({
                type: 'agent_activity',
                category: 'chat_room',
                message: event.type === 'chunk'
                  ? `[${agentId}] room chunk`
                  : `[${agentId}] room ${event.type}`,
                data: {
                  ...(event.data as Record<string, unknown>),
                  sessionId,
                  agentId,
                },
              });
            },
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          responses.push({
            agentId,
            response: errMsg,
            tokensUsed: 0,
            costUsd: 0,
            messageId: '',
            timestamp: nowIso(),
          });
          continue;
        }

        // Persist agent response
        const assistantMsgId = `msg-${generateId()}`;
        const assistantTimestamp = nowIso();
        const tokensUsed = result.inputTokens + result.outputTokens;
        db.prepare<[string, string, string, string, string, string, number, number]>(`
          INSERT INTO chat_messages
            (id, agent_id, session_id, role, content, timestamp, tokens_used, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assistantMsgId,
          agentId,
          sessionId,
          'assistant',
          result.response,
          assistantTimestamp,
          tokensUsed,
          result.costUsd,
        );

        // Extend context so next agent sees this response
        accumulatedContext += `\n${agentId}: ${result.response}`;

        responses.push({
          agentId,
          response: result.response,
          tokensUsed,
          costUsd: result.costUsd,
          messageId: assistantMsgId,
          timestamp: assistantTimestamp,
        });

        if (result.costUsd > 0) {
          globalStream.emit({
            type: 'cost_event',
            category: 'chat_room',
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
      }

      const totalCost = responses.reduce((sum, r) => sum + r.costUsd, 0);
      const totalTokens = responses.reduce((sum, r) => sum + r.tokensUsed, 0);

      return reply.status(200).send({
        data: {
          sessionId,
          agentIds,
          responses,
          totalCostUsd: totalCost,
          totalTokensUsed: totalTokens,
        },
        meta: { timestamp: nowIso() },
      });
    },
  );
}
