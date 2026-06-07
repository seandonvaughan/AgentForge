import type { FastifyInstance } from 'fastify';
import { registerCycleArtifactRoutes } from './server.js';
import type { V5RouteOptions } from './routes/v5/index.js';
import { registerV5Routes as registerWorkspaceV5Routes } from './routes/v5/index.js';

export * from './server.js';
export * from './main.js';
export * from './websocket/index.js';
export * from './routes/v5/index.js';

export async function registerV5Routes(
  app: FastifyInstance,
  opts: V5RouteOptions,
): Promise<void> {
  await registerWorkspaceV5Routes(app, opts);
  await registerCycleArtifactRoutes(app, {
    projectRoot: opts.projectRoot ?? process.cwd(),
    workspaceId: opts.adapter.workspaceId,
  });
}
