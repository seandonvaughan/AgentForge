import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

interface AgentCapability {
  agentId: string;
  name: string;
  model: string;
  skills: string[];
  team?: string;
}

interface AgentYaml {
  name?: string;
  model?: string;
  team?: string;
  skills?: string[];
}

export async function capabilitiesRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  app.get('/api/v1/capabilities', async (_req, reply) => {
    try {
      const agentsDir = join(PROJECT_ROOT, '.agentforge/agents');
      if (!existsSync(agentsDir)) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
      const data: AgentCapability[] = [];

      for (const filename of files) {
        try {
          const agentId = filename.replace('.yaml', '');
          const content = readFileSync(join(agentsDir, filename), 'utf-8');
          const parsed = yaml.load(content) as AgentYaml;

          if (!parsed || typeof parsed !== 'object') continue;

          data.push({
            agentId,
            name: parsed.name ?? agentId,
            model: parsed.model ?? 'sonnet',
            skills: Array.isArray(parsed.skills) ? parsed.skills : [],
            team: parsed.team,
          });
        } catch {
          // skip unparseable agent files
        }
      }

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });
}
