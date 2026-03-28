import type { FastifyInstance } from 'fastify';
import { TraceCollector } from '@agentforge/core';

const collector = new TraceCollector({ serviceName: 'agentforge', maxTraces: 1000 });

export async function tracingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/traces — list traces with optional filters
  app.get('/api/v5/traces', async (req, reply) => {
    const q = req.query as { serviceName?: string; status?: string; since?: string; limit?: string };
    const traces = collector.listTraces({
      serviceName: q.serviceName,
      status: q.status as any,
      since: q.since,
      limit: q.limit ? parseInt(q.limit) : 100,
    });
    return reply.send({
      data: traces,
      meta: {
        total: collector.traceCount(),
        returned: traces.length,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // GET /api/v5/traces/:traceId — get a specific trace
  app.get<{ Params: { traceId: string } }>('/api/v5/traces/:traceId', async (req, reply) => {
    const trace = collector.getTrace(req.params.traceId);
    if (!trace) return reply.status(404).send({ error: 'Trace not found', code: 'TRACE_NOT_FOUND' });
    return reply.send({ data: trace });
  });

  // POST /api/v5/traces — start a new root span / ingest a span
  app.post('/api/v5/traces', async (req, reply) => {
    const body = req.body as any;
    if (!body?.name) {
      return reply.status(400).send({ error: 'name is required', code: 'MISSING_FIELD' });
    }
    const span = body.parentContext
      ? collector.startSpan({
          name: body.name,
          kind: body.kind,
          parentContext: body.parentContext,
          attributes: body.attributes,
          serviceName: body.serviceName,
        })
      : collector.startRootSpan({
          name: body.name,
          kind: body.kind,
          attributes: body.attributes,
          serviceName: body.serviceName,
        });

    // Immediately end the span if endTime is provided in body
    if (body.end) {
      collector.endSpan(span);
    }

    return reply.status(201).send({
      data: {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        started: true,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v5/traces/stats/summary — tracing statistics
  app.get('/api/v5/traces/stats/summary', async (_req, reply) => {
    const stats = collector.stats();
    return reply.send({ data: stats, meta: { timestamp: new Date().toISOString() } });
  });
}
