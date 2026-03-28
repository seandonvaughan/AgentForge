import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';

export interface StreamEvent {
  id: string;
  type: 'agent_activity' | 'sprint_event' | 'cost_event' | 'workflow_event' | 'branch_event' | 'system' | 'refresh_signal';
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

/** In-memory event bus for SSE clients. */
export class EventStream {
  private clients = new Map<string, (event: StreamEvent) => void>();

  subscribe(clientId: string, handler: (event: StreamEvent) => void): () => void {
    this.clients.set(clientId, handler);
    return () => this.clients.delete(clientId);
  }

  emit(event: Omit<StreamEvent, 'id' | 'timestamp'>): void {
    const full: StreamEvent = {
      id: generateId(),
      timestamp: nowIso(),
      ...event,
    };
    for (const handler of this.clients.values()) {
      try { handler(full); } catch { /* client gone */ }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}

/** Singleton stream — imported by other routes to emit events. */
export const globalStream = new EventStream();

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/stream — SSE endpoint, clients connect and receive all events
  app.get('/api/v5/stream', async (req, reply) => {
    const clientId = `client-${generateId()}`;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    // Send connected event
    reply.raw.write(`data: ${JSON.stringify({ type: 'system', message: 'connected', clientId, timestamp: nowIso() })}\n\n`);

    // Send heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: 'system', message: 'heartbeat', timestamp: nowIso() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const unsub = globalStream.subscribe(clientId, (event) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client disconnected */
      }
    });

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });

    // Keep the connection open
    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
    });
  });

  // GET /api/v5/stream/status — how many clients connected, last events
  app.get('/api/v5/stream/status', async (_req, reply) => {
    return reply.send({
      data: {
        connectedClients: globalStream.clientCount(),
        timestamp: nowIso(),
      }
    });
  });

  // POST /api/v5/stream/emit — emit a custom event (for testing / external triggers)
  app.post('/api/v5/stream/emit', async (req, reply) => {
    const { type, category, message, data } = req.body as Partial<StreamEvent>;
    if (!message) return reply.status(400).send({ error: 'message required' });
    globalStream.emit({
      type: type ?? 'system',
      category: category ?? 'system',
      message,
      data,
    });
    return reply.status(201).send({ ok: true });
  });

  // POST /api/v5/dashboard/refresh-signal — Playwright monitor calls this to signal stale UI
  app.post('/api/v5/dashboard/refresh-signal', async (req, reply) => {
    const { reason } = req.body as { reason?: string };
    globalStream.emit({
      type: 'refresh_signal',
      category: 'dashboard',
      message: reason ?? 'Dashboard state is stale — refreshing',
    });
    return reply.status(200).send({ ok: true, message: 'Refresh signal sent to all clients' });
  });
}
