/**
 * Demo Fastify server — entry point for the demo-users-api fixture project.
 */

import Fastify from 'fastify';
import { usersRoutes } from './handlers/users.js';

const server = Fastify({ logger: true });

// Register routes
server.register(usersRoutes, { prefix: '/api/users' });

// Health check
server.get('/health', async (_req, _reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Start server
const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = process.env['HOST'] ?? '127.0.0.1';

server.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  server.log.info(`Server listening at ${address}`);
});

export { server };
