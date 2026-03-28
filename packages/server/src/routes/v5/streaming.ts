import type { FastifyInstance } from 'fastify';
import { ResponseStreamer, StreamHandle } from '@agentforge/core';

const streamer = new ResponseStreamer();

/** Simulated task responses for demonstration */
const SIMULATED_RESPONSES: Record<string, string> = {
  default: 'AgentForge is processing your request. The agent runtime is streaming this response chunk by chunk to demonstrate real-time output delivery.',
};

export async function agentStreamingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v5/stream/response/:taskId
   * SSE endpoint that streams a simulated agent response in chunks.
   */
  app.get<{ Params: { taskId: string } }>(
    '/api/v5/stream/response/:taskId',
    async (req, reply) => {
      const { taskId } = req.params;
      const content = SIMULATED_RESPONSES[taskId] ?? SIMULATED_RESPONSES.default;
      const chunkSize = parseInt((req.query as { chunkSize?: string }).chunkSize ?? '20', 10);

      const handle: StreamHandle = {
        id: `stream_${Date.now()}`,
        taskId,
        totalLength: content.length,
        startedAt: new Date().toISOString(),
      };

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });

      // Send the handle metadata first
      reply.raw.write(`data: ${JSON.stringify({ type: 'handle', handle })}\n\n`);

      for await (const chunk of streamer.stream(content, { chunkSize })) {
        if (reply.raw.destroyed) break;
        reply.raw.write(streamer.toSSE(chunk));
      }

      reply.raw.end();
    },
  );

  /**
   * GET /api/v5/stream/response/:taskId/info
   * Returns metadata about a streaming task without starting the stream.
   */
  app.get<{ Params: { taskId: string } }>(
    '/api/v5/stream/response/:taskId/info',
    async (req, reply) => {
      const { taskId } = req.params;
      const content = SIMULATED_RESPONSES[taskId] ?? SIMULATED_RESPONSES.default;

      return reply.send({
        data: {
          taskId,
          contentLength: content.length,
          estimatedChunks: Math.ceil(content.length / 20),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  );
}
