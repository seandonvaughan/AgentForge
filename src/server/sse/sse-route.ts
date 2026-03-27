/**
 * sseRoute — P0-6: GET /api/v1/stream
 *
 * Fastify plugin that registers the SSE streaming endpoint. Each connected
 * client receives a unique clientId, a heartbeat every 30 s, and all events
 * broadcast through SseManager.broadcast().
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SseManager } from './sse-manager.js';

export interface SseRouteOptions {
  sseManager: SseManager;
}

export async function sseRoute(
  app: FastifyInstance,
  opts: SseRouteOptions
): Promise<void> {
  app.get('/api/v1/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // Nginx unbuffering

    const clientId = randomUUID();
    opts.sseManager.addClient(clientId, reply);

    // Send initial connected event
    reply.raw.write(
      `event: connected\ndata: ${JSON.stringify({
        clientId,
        timestamp: new Date().toISOString(),
      })}\n\n`
    );

    // Heartbeat every 30 s — SSE comment lines keep the connection alive
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // socket already gone; cleanup handled by the close handler below
      }
    }, 30_000);

    req.socket.on('close', () => {
      clearInterval(heartbeat);
      opts.sseManager.removeClient(clientId);
    });

    // Keep the connection open — never call reply.send()
    await new Promise<void>(() => {
      // This promise intentionally never resolves; the connection is held open
      // until the client disconnects and the socket close event fires above.
    });
  });
}
