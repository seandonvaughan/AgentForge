import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { CanaryManager } from '@agentforge/core';
import { canaryRoutes } from '../canary.js';

describe('POST /api/v5/canary/metrics', () => {
  let manager: CanaryManager;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    manager = new CanaryManager();
    app = Fastify({ logger: false });
    await canaryRoutes(app, { manager });
  });

  it('requires a split-issued outcome token before recording metrics', async () => {
    const flag = manager.createFlag({ name: 'token-guarded', trafficPercent: 100 });
    manager.activateFlag(flag.id);

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/metrics',
      payload: {
        flagId: flag.id,
        requestId: 'req-without-split',
        outcomeToken: 'bad-token',
        outcome: 'behavior_error',
      },
    });

    expect(unauthorized.statusCode).toBe(403);
    expect(manager.getMetrics(flag.id)?.canaryRequests).toBe(0);

    const split = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/split',
      payload: { flagId: flag.id, requestId: 'req-authorized' },
    });
    const splitBody = split.json() as {
      data: { requestId: string; outcomeToken: string; variant: string };
    };
    expect(splitBody.data.variant).toBe('canary');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/metrics',
      payload: {
        flagId: flag.id,
        requestId: splitBody.data.requestId,
        outcomeToken: splitBody.data.outcomeToken,
        outcome: 'behavior_error',
      },
    });

    expect(accepted.statusCode).toBe(201);
    expect(manager.getMetrics(flag.id)?.canaryRequests).toBe(1);
    expect(manager.getMetrics(flag.id)?.canaryErrors).toBe(1);
  });

  it('rejects boolean-only error reports and ignores runtime failures for rollback metrics', async () => {
    const flag = manager.createFlag({ name: 'runtime-noise', trafficPercent: 100 });
    manager.activateFlag(flag.id);

    const split = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/split',
      payload: { flagId: flag.id, requestId: 'req-runtime-noise' },
    });
    const splitBody = split.json() as {
      data: { requestId: string; outcomeToken: string };
    };

    const booleanOnly = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/metrics',
      payload: {
        flagId: flag.id,
        requestId: splitBody.data.requestId,
        outcomeToken: splitBody.data.outcomeToken,
        isError: true,
      },
    });
    expect(booleanOnly.statusCode).toBe(400);

    const splitAgain = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/split',
      payload: { flagId: flag.id, requestId: 'req-runtime-noise-2' },
    });
    const splitAgainBody = splitAgain.json() as {
      data: { requestId: string; outcomeToken: string };
    };

    const runtimeFailure = await app.inject({
      method: 'POST',
      url: '/api/v5/canary/metrics',
      payload: {
        flagId: flag.id,
        requestId: splitAgainBody.data.requestId,
        outcomeToken: splitAgainBody.data.outcomeToken,
        outcome: 'runtime_error',
      },
    });

    expect(runtimeFailure.statusCode).toBe(202);
    expect(manager.getMetrics(flag.id)?.canaryRequests).toBe(0);
    expect(manager.getMetrics(flag.id)?.canaryErrors).toBe(0);
  });
});
