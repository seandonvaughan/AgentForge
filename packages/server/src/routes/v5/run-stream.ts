/**
 * run-stream.ts — GET /api/v5/run/:runId/stream
 *
 * Per-run SSE endpoint: connects a dashboard client to the global event stream
 * filtered by `sessionId == runId`.  Also forwards generic workflow events so
 * the caller learns about run start/complete/failed without polling.
 *
 * Wire format (text/event-stream):
 *   data: {"type":"system","message":"connected","runId":"<id>",...}\n\n
 *   data: {"type":"agent_activity","category":"run","data":{"content":"<chunk>",...}}\n\n
 *   data: {"type":"workflow_event","category":"run","data":{"status":"completed",...}}\n\n
 *   : heartbeat\n\n
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nowIso } from '@agentforge/shared';
import { globalStream, type StreamEvent } from './stream.js';

// Event types that a run-stream subscriber cares about.
const RUN_EVENT_TYPES = new Set<string>([
  'agent_activity',
  'workflow_event',
  'cost_event',
]);

/** True when the event contains a `sessionId` that matches the target run. */
function eventBelongsToRun(event: StreamEvent, runId: string): boolean {
  // Prefer the top-level sessionId field; fall back to payload / data.
  if (event.sessionId === runId) return true;
  const bag = event.payload ?? event.data;
  if (bag && typeof bag === 'object') {
    const p = bag as Record<string, unknown>;
    if (p['sessionId'] === runId) return true;
  }
  return false;
}

export async function runStreamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v5/run/:runId/stream
   *
   * Streams SSE events for the given `runId` (which equals the session ID
   * returned by POST /api/v5/run).  The client receives:
   *  - A `connected` system message immediately.
   *  - All `agent_activity`, `workflow_event`, and `cost_event` events whose
   *    `sessionId` matches the requested runId.
   *  - A heartbeat comment (`: heartbeat`) every 15 seconds.
   *
   * The connection is held open until the client disconnects.
   */
  app.get<{ Params: { runId: string } }>(
    '/api/v5/run/:runId/stream',
    async (req, reply) => {
      const { runId } = req.params;

      // CORS: scope to localhost origins to match the main SSE endpoints.
      const reqOrigin = req.headers['origin'];
      const isLocalhost =
        typeof reqOrigin === 'string' &&
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin);
      const corsOrigin = isLocalhost ? reqOrigin : 'http://localhost:4751';

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': corsOrigin,
        'X-Accel-Buffering': 'no',
      });

      const clientId = `run-stream-${randomUUID()}`;

      // Emit the initial connected event so the client knows the channel is live.
      reply.raw.write(
        `data: ${JSON.stringify({
          type: 'system',
          message: 'connected',
          runId,
          clientId,
          timestamp: nowIso(),
        })}\n\n`,
      );

      // Heartbeat keeps the TCP connection alive through proxies / ALBs.
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Subscribe to the global event bus and forward matching events.
      const unsub = globalStream.subscribe(clientId, (event: StreamEvent) => {
        // Only forward event types the run-stream cares about.
        if (!RUN_EVENT_TYPES.has(event.type)) return;
        // Only forward events that belong to this run.
        if (!eventBelongsToRun(event, runId)) return;

        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          /* client disconnected — subscription will be cleaned up on close */
        }
      });

      // Clean up when the client disconnects.
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });

      // Hold the SSE connection open until the client goes away.
      await new Promise<void>((resolve) => {
        req.raw.on('close', resolve);
      });
    },
  );
}
