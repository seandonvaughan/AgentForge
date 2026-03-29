/**
 * WebSocket Handler — /ws endpoint
 *
 * Features:
 *  - Welcome message on connect with connected client count
 *  - JSON message routing: { type: "chat", agentId, message } → agent dispatch
 *  - Broadcast API for pushing events to all connected clients (complements SSE)
 *  - Heartbeat ping/pong every 30 seconds, stale client disconnection
 *  - Replay support: { type: "replay", since: ISO_timestamp } → missed events
 *
 * Uses @fastify/websocket (already a dep in packages/server/package.json).
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { generateId, nowIso } from '@agentforge/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WsClientRecord {
  id: string;
  ws: WebSocket;
  connectedAt: string;
  lastPongAt: string;
  isAlive: boolean;
}

export interface WsEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: string;
}

// Incoming message shapes
interface ChatMessage {
  type: 'chat';
  agentId: string;
  message: string;
}

interface ReplayMessage {
  type: 'replay';
  since: string; // ISO 8601
}

interface PingMessage {
  type: 'ping';
}

type IncomingMessage = ChatMessage | ReplayMessage | PingMessage | { type: string };

// ── Module-level state ────────────────────────────────────────────────────────

/** All currently connected WebSocket clients. */
const clients = new Map<string, WsClientRecord>();

/** Bounded ring-buffer of recent broadcast events for replay support. */
const MAX_EVENT_HISTORY = 500;
const eventHistory: WsEvent[] = [];

/** Heartbeat interval handle — stored so tests can clear it. */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// ── Helper utilities ──────────────────────────────────────────────────────────

function isSendable(ws: WebSocket): boolean {
  // readyState 1 === OPEN
  return ws.readyState === 1;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (isSendable(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

function recordEvent(type: string, data: unknown): WsEvent {
  const event: WsEvent = {
    id: generateId(),
    type,
    data,
    timestamp: nowIso(),
  };
  eventHistory.push(event);
  // Trim to max history
  if (eventHistory.length > MAX_EVENT_HISTORY) {
    eventHistory.splice(0, eventHistory.length - MAX_EVENT_HISTORY);
  }
  return event;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Broadcast an event to all connected clients.
 * Optionally filter by a predicate — useful for workspace-scoped messages.
 */
export function broadcastWs(
  type: string,
  data: unknown,
  filter?: (client: WsClientRecord) => boolean,
): void {
  const event = recordEvent(type, data);
  for (const client of clients.values()) {
    if (!filter || filter(client)) {
      sendJson(client.ws, event);
    }
  }
}

/** Return a snapshot of event history optionally filtered by timestamp. */
export function getEventsSince(since: Date): WsEvent[] {
  return eventHistory.filter((e) => new Date(e.timestamp) >= since);
}

/** Return the number of currently connected clients. */
export function getConnectedCount(): number {
  return clients.size;
}

/** Disconnect all clients and clear the heartbeat — useful in tests. */
export function teardown(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  for (const client of clients.values()) {
    try { client.ws.close(); } catch { /* already closed */ }
  }
  clients.clear();
}

// ── Agent dispatch (minimal stub — wire to AgentRuntime as needed) ────────────

async function dispatchToAgent(
  agentId: string,
  message: string,
  clientId: string,
): Promise<void> {
  // Broadcast a typing indicator immediately
  broadcastWs('agent.typing', { agentId, clientId }, (c) => c.id === clientId);

  // TODO: replace this stub with a real AgentRuntime dispatch.
  // For now, echo the message back as a simple acknowledgement so the
  // WebSocket infrastructure is testable end-to-end without requiring a
  // running agent process.
  const reply = {
    agentId,
    clientId,
    content: `[${agentId}] received: "${message}"`,
    model: 'stub',
  };

  // Small artificial delay to simulate async processing
  await new Promise((resolve) => setTimeout(resolve, 50));

  broadcastWs('agent.reply', reply, (c) => c.id === clientId);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(): void {
  if (heartbeatInterval) return; // already running

  heartbeatInterval = setInterval(() => {
    const now = nowIso();
    for (const [id, client] of clients.entries()) {
      if (!client.isAlive) {
        // Did not respond to last ping — terminate
        try { client.ws.terminate(); } catch { /* already gone */ }
        clients.delete(id);
        continue;
      }
      // Mark as pending — will be reset on pong
      client.isAlive = false;
      if (isSendable(client.ws)) {
        sendJson(client.ws, { type: 'ping', timestamp: now });
      }
    }
  }, 30_000);
}

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Register the /ws WebSocket endpoint on the given Fastify instance.
 *
 * The caller must have already registered @fastify/websocket — this function
 * is safe to call multiple times because Fastify deduplicates plugins.
 */
export async function registerWsHandler(app: FastifyInstance): Promise<void> {
  // Ensure @fastify/websocket is registered (idempotent)
  await app.register(import('@fastify/websocket'));

  startHeartbeat();

  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const clientId = generateId();
    const connectedAt = nowIso();

    const client: WsClientRecord = {
      id: clientId,
      ws: socket,
      connectedAt,
      lastPongAt: connectedAt,
      isAlive: true,
    };

    clients.set(clientId, client);

    // ── Welcome message ─────────────────────────────────────────────────────
    sendJson(socket, {
      type: 'connected',
      clientId,
      connectedClients: clients.size,
      serverVersion: '6.2.0',
      timestamp: connectedAt,
      protocol: {
        chat: '{ type:"chat", agentId:string, message:string }',
        replay: '{ type:"replay", since:ISO_timestamp }',
        ping: '{ type:"ping" }',
        pong: '{ type:"pong" } — respond to server pings to stay alive',
      },
    });

    req.log?.info?.({ clientId, connectedClients: clients.size }, 'ws client connected');

    // ── Message handler ──────────────────────────────────────────────────────
    socket.on('message', (raw: Buffer | string) => {
      let msg: IncomingMessage;

      try {
        msg = JSON.parse(raw.toString()) as IncomingMessage;
      } catch {
        sendJson(socket, {
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Message must be valid JSON.',
        });
        return;
      }

      switch (msg.type) {
        case 'chat': {
          const { agentId, message } = msg as ChatMessage;
          if (!agentId || typeof agentId !== 'string') {
            sendJson(socket, { type: 'error', code: 'MISSING_AGENT_ID' });
            break;
          }
          if (!message || typeof message !== 'string') {
            sendJson(socket, { type: 'error', code: 'MISSING_MESSAGE' });
            break;
          }
          dispatchToAgent(agentId, message, clientId).catch((err) => {
            sendJson(socket, {
              type: 'error',
              code: 'AGENT_DISPATCH_FAILED',
              message: err instanceof Error ? err.message : String(err),
            });
          });
          break;
        }

        case 'replay': {
          const { since } = msg as ReplayMessage;
          let sinceDate: Date;
          try {
            sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) throw new Error('bad date');
          } catch {
            sendJson(socket, {
              type: 'error',
              code: 'INVALID_TIMESTAMP',
              message: 'since must be a valid ISO 8601 timestamp.',
            });
            break;
          }
          const missed = getEventsSince(sinceDate);
          sendJson(socket, {
            type: 'replay',
            events: missed,
            count: missed.length,
            since,
          });
          break;
        }

        case 'pong': {
          // Client acknowledging our heartbeat ping
          client.isAlive = true;
          client.lastPongAt = nowIso();
          break;
        }

        case 'ping': {
          sendJson(socket, { type: 'pong', timestamp: nowIso() });
          break;
        }

        default: {
          sendJson(socket, {
            type: 'error',
            code: 'UNKNOWN_MESSAGE_TYPE',
            received: msg.type,
            supported: ['chat', 'replay', 'ping', 'pong'],
          });
        }
      }
    });

    // ── Close / error handlers ───────────────────────────────────────────────
    socket.on('close', () => {
      clients.delete(clientId);
      req.log?.info?.({ clientId, connectedClients: clients.size }, 'ws client disconnected');
    });

    socket.on('error', () => {
      clients.delete(clientId);
    });
  });

  // ── REST companion: live WS stats ─────────────────────────────────────────
  app.get('/api/v6/ws/stats', async (_req, reply) => {
    return reply.send({
      data: {
        connectedClients: clients.size,
        eventHistorySize: eventHistory.length,
      },
      meta: { timestamp: nowIso() },
    });
  });
}
