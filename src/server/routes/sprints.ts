import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

export async function sprintsRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  // GET /api/v1/sprints — list all sprint JSON files
  app.get('/api/v1/sprints', async (_req, reply) => {
    try {
      const sprintsDir = join(PROJECT_ROOT, '.agentforge/sprints');
      if (!existsSync(sprintsDir)) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const files = readdirSync(sprintsDir).filter(f => f.endsWith('.json') && !f.includes('$'));
      if (files.length === 0) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const data = files.flatMap(filename => {
        try {
          const raw = readFileSync(join(sprintsDir, filename), 'utf-8');
          let parsed = JSON.parse(raw);
          // Handle double-encoded JSON (legacy files stored as string)
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          return [{ filename, ...parsed }];
        } catch {
          return [];
        }
      });

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v1/sprints/:version — get a specific sprint file (e.g., v4.8)
  app.get('/api/v1/sprints/:version', async (req, reply) => {
    const { version } = req.params as { version: string };
    try {
      const sprintsDir = join(PROJECT_ROOT, '.agentforge/sprints');
      const filePath = join(sprintsDir, `${version}.json`);

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'Sprint not found', version });
      }

      const content = readFileSync(filePath, 'utf-8');
      const data = { filename: `${version}.json`, ...JSON.parse(content) };

      return reply.send({ data, meta: { total: 1 } });
    } catch {
      return reply.status(404).send({ error: 'Sprint not found', version });
    }
  });
}
