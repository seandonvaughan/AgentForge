import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'executed';

interface ReforgeProposal {
  id: string;
  filename: string;
  title: string;
  status: ProposalStatus;
  createdAt: string;
}

function parseStatus(filename: string): ProposalStatus {
  const lower = filename.toLowerCase();
  if (lower.includes('executed')) return 'executed';
  if (lower.includes('approved')) return 'approved';
  if (lower.includes('rejected')) return 'rejected';
  return 'proposed';
}

function extractTitle(content: string, fallback: string): string {
  // Try to find a markdown heading
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return fallback;
}

export async function reforgeRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  app.get('/api/v1/reforge', async (_req, reply) => {
    try {
      const reviewsDir = join(PROJECT_ROOT, '.agentforge/reviews');
      if (!existsSync(reviewsDir)) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const files = readdirSync(reviewsDir).filter(f => f.endsWith('.md'));
      const data: ReforgeProposal[] = [];

      for (const filename of files) {
        try {
          const filePath = join(reviewsDir, filename);
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const title = extractTitle(content, filename.replace('.md', ''));
          const status = parseStatus(filename);

          data.push({
            id: filename.replace('.md', ''),
            filename,
            title,
            status,
            createdAt: stat.birthtime.toISOString(),
          });
        } catch {
          // skip unreadable files
        }
      }

      // Sort descending by filename
      data.sort((a, b) => b.filename.localeCompare(a.filename));

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });
}
