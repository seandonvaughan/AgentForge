import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { MessageBusV2 } from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { WEBSOCKET_EVENTS, generateId } from '@agentforge/shared';

export interface WebSocketServerOptions {
  bus: MessageBusV2;
  adapter: WorkspaceAdapter;
}

interface WsClient {
  id: string;
  ws: WebSocket;
  workspaceId: string;
  subscribedTopics: Set<string>;
  connectedAt: string;
}

/** Active WebSocket clients keyed by client ID. */
const clients = new Map<string, WsClient>();

/**
 * Send a structured event to a single client.
 * Silently skips if the socket is not in OPEN state.
 */
export function sendToClient(client: WsClient, event: string, data: unknown): void {
  if (client.ws.readyState === 1 /* WebSocket.OPEN */) {
    client.ws.send(
      JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    );
  }
}

/**
 * Broadcast an event to all connected clients, optionally filtered by workspace.
 */
export function broadcast(event: string, data: unknown, workspaceId?: string): void {
  for (const client of clients.values()) {
    if (!workspaceId || client.workspaceId === workspaceId) {
      sendToClient(client, event, data);
    }
  }
}

/**
 * Get the current number of connected WebSocket clients.
 */
export function getConnectedClientCount(): number {
  return clients.size;
}

/**
 * Register the WebSocket plugin and all /api/v5/ws routes on the Fastify instance.
 *
 * Bus events are bridged to WebSocket broadcasts so browser dashboards receive
 * live updates without polling.
 */
export async function registerWebSocketRoutes(
  app: FastifyInstance,
  opts: WebSocketServerOptions,
): Promise<void> {
  // @fastify/websocket is registered exactly once by createServerV5 before
  // any WebSocket routes are wired. Do not register it here.

  // ── Bus → WebSocket bridge ───────────────────────────────────────────────────

  // Task events (agent.task.*)
  opts.bus.subscribe('agent.task.*', (envelope) => {
    broadcast(WEBSOCKET_EVENTS.AGENT_MESSAGE, envelope, envelope.workspaceId);
  });

  // Cost anomaly events
  opts.bus.subscribe('cost.anomaly.detected', (envelope) => {
    broadcast(WEBSOCKET_EVENTS.ANOMALY_DETECTED, envelope, envelope.workspaceId);
  });

  // Cost update events
  opts.bus.subscribe('cost.recorded', (envelope) => {
    broadcast(WEBSOCKET_EVENTS.COST_UPDATE, envelope, envelope.workspaceId);
  });

  // Lifecycle events
  opts.bus.subscribe('agent.lifecycle.*', (envelope) => {
    const event = envelope.topic.includes('completed')
      ? WEBSOCKET_EVENTS.SESSION_COMPLETED
      : envelope.topic.includes('failed')
        ? WEBSOCKET_EVENTS.SESSION_FAILED
        : WEBSOCKET_EVENTS.SESSION_STARTED;
    broadcast(event, envelope, envelope.workspaceId);
  });

  // Plugin events
  opts.bus.subscribe('plugin.event', (envelope) => {
    broadcast(WEBSOCKET_EVENTS.PLUGIN_EVENT, envelope, envelope.workspaceId);
  });

  // Generic bus relay — all events also forwarded as BUS_EVENT
  opts.bus.subscribeAll((envelope) => {
    broadcast(WEBSOCKET_EVENTS.BUS_EVENT, envelope, envelope.workspaceId);
  });

  // ── WebSocket endpoint ───────────────────────────────────────────────────────

  app.get('/api/v5/ws', { websocket: true }, (socket, req) => {
    const clientId = generateId();
    const workspaceId =
      (req.headers['x-workspace-id'] as string | undefined) ?? 'default';

    const client: WsClient = {
      id: clientId,
      ws: socket,
      workspaceId,
      subscribedTopics: new Set(['*']),
      connectedAt: new Date().toISOString(),
    };

    clients.set(clientId, client);

    // Acknowledge connection
    sendToClient(client, 'connected', {
      clientId,
      workspaceId,
      serverVersion: '5.0.0',
      availableEvents: Object.values(WEBSOCKET_EVENTS),
    });

    // ── Incoming message handler ────────────────────────────────────────────────

    socket.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type: string;
          topics?: string[];
          limit?: number;
        };

        switch (msg.type) {
          case 'subscribe':
            if (Array.isArray(msg.topics)) {
              msg.topics.forEach((t) => client.subscribedTopics.add(t));
              sendToClient(client, 'subscribed', { topics: msg.topics });
            }
            break;

          case 'unsubscribe':
            if (Array.isArray(msg.topics)) {
              msg.topics.forEach((t) => client.subscribedTopics.delete(t));
              sendToClient(client, 'unsubscribed', { topics: msg.topics });
            }
            break;

          case 'ping':
            sendToClient(client, 'pong', { timestamp: new Date().toISOString() });
            break;

          case 'get_history': {
            const limit = typeof msg.limit === 'number' ? Math.min(msg.limit, 500) : 50;
            const history = opts.bus.getHistory(limit);
            sendToClient(client, 'history', { events: history, count: history.length });
            break;
          }

          case 'get_stats':
            sendToClient(client, 'stats', {
              busStats: opts.bus.getStats(),
              connectedClients: clients.size,
            });
            break;

          default:
            sendToClient(client, 'error', {
              code: 'UNKNOWN_MESSAGE_TYPE',
              type: msg.type,
            });
        }
      } catch {
        // Ignore malformed JSON — do not crash the server
      }
    });

    socket.on('close', () => {
      clients.delete(clientId);
    });

    socket.on('error', () => {
      clients.delete(clientId);
    });
  });

  // ── REST companion endpoints ─────────────────────────────────────────────────

  /** Returns live WebSocket and bus stats. */
  app.get('/api/v5/ws/stats', async (_req, reply) => {
    return reply.send({
      data: {
        connectedClients: clients.size,
        busStats: opts.bus.getStats(),
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /** Returns recent message bus history as JSON (useful for SSR/initial load). */
  app.get('/api/v5/ws/history', async (req, reply) => {
    const q = req.query as { limit?: string; topic?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 500);
    const history = opts.bus.getHistory(limit);
    return reply.send({
      data: history,
      meta: { count: history.length, limit, timestamp: new Date().toISOString() },
    });
  });
}
