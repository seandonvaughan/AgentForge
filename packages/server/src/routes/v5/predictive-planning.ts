import type { FastifyInstance } from 'fastify';
import { SprintPredictor, HistoryAnalyzer } from '@agentforge/core';
import type { SprintHistoryRecord, BacklogItem } from '@agentforge/core';

const predictor = new SprintPredictor();
const analyzer = new HistoryAnalyzer();

// In-memory history store
const sprintHistory: SprintHistoryRecord[] = [];

export async function predictivePlanningRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v5/planning/predict
  app.post('/api/v5/planning/predict', async (req, reply) => {
    const body = req.body as {
      backlogItems?: BacklogItem[];
      budgetUsd?: number;
    };

    if (!body?.backlogItems || !Array.isArray(body.backlogItems)) {
      return reply.status(400).send({ error: 'backlogItems array is required', code: 'MISSING_FIELD' });
    }

    const prediction = predictor.predict(body.backlogItems, sprintHistory, body.budgetUsd);

    return reply.send({
      data: prediction,
      meta: {
        historyLength: sprintHistory.length,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // POST /api/v5/planning/history — record a sprint outcome
  app.post('/api/v5/planning/history', async (req, reply) => {
    const body = req.body as SprintHistoryRecord;

    if (!body?.sprintId) {
      return reply.status(400).send({ error: 'sprintId is required', code: 'MISSING_FIELD' });
    }

    sprintHistory.push(body);

    return reply.status(201).send({
      data: body,
      meta: {
        totalRecords: sprintHistory.length,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // GET /api/v5/planning/history
  app.get('/api/v5/planning/history', async (_req, reply) => {
    const analysis = analyzer.analyze(sprintHistory);
    return reply.send({
      data: sprintHistory,
      analysis,
      meta: {
        total: sprintHistory.length,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
