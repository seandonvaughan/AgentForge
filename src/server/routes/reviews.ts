import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

interface ReviewEntry {
  id: string;
  filename: string;
  content: string;
  createdAt: string;
}

function readMarkdownFiles(dir: string, prefix: string): ReviewEntry[] {
  if (!existsSync(dir)) return [];

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    const entries: ReviewEntry[] = [];

    for (const filename of files) {
      try {
        const filePath = join(dir, filename);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');

        entries.push({
          id: `${prefix}:${filename}`,
          filename,
          content: content.slice(0, 500),
          createdAt: stat.birthtime.toISOString(),
        });
      } catch {
        // skip unreadable files
      }
    }

    return entries;
  } catch {
    return [];
  }
}

export async function reviewsRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  app.get('/api/v1/reviews', async (_req, reply) => {
    try {
      const reviewsDir = join(PROJECT_ROOT, '.agentforge/reviews');
      const feedbackDir = join(PROJECT_ROOT, '.agentforge/feedback');

      const reviewEntries = readMarkdownFiles(reviewsDir, 'reviews');
      const feedbackEntries = readMarkdownFiles(feedbackDir, 'feedback');

      const all = [...reviewEntries, ...feedbackEntries].sort((a, b) =>
        b.filename.localeCompare(a.filename)
      );

      return reply.send({ data: all, meta: { total: all.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });
}
