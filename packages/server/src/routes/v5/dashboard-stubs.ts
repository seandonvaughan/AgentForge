import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stub endpoints for dashboard pages that need data but don't have full
 * backend implementations yet. These provide sensible defaults and read
 * from file-based data where available.
 */
export async function dashboardStubRoutes(
  app: FastifyInstance,
  opts: { projectRoot?: string } = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  // ── Flywheel metrics ──────────────────────────────────────────────────────
  app.get('/api/v5/flywheel', async (_req, reply) => {
    // Compute flywheel scores from real data where possible
    const sprintsDir = join(projectRoot, '.agentforge/sprints');
    let sprintCount = 0;
    let completedItems = 0;
    let totalItems = 0;
    if (existsSync(sprintsDir)) {
      const files = readdirSync(sprintsDir).filter(f => f.endsWith('.json') && !f.startsWith('v${'));
      sprintCount = files.length;
      for (const file of files) {
        try {
          const raw = JSON.parse(readFileSync(join(sprintsDir, file), 'utf-8'));
          const items = raw.items ?? [];
          totalItems += items.length;
          completedItems += items.filter((i: { status?: string }) => i.status === 'completed').length;
        } catch { /* skip */ }
      }
    }

    const sessionsDir = join(projectRoot, '.agentforge/sessions');
    let sessionCount = 0;
    if (existsSync(sessionsDir)) {
      sessionCount = readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.startsWith('cost-')).length;
    }

    const agentsDir = join(projectRoot, '.agentforge/agents');
    let agentCount = 0;
    if (existsSync(agentsDir)) {
      agentCount = readdirSync(agentsDir).filter(f => f.endsWith('.yaml')).length;
    }

    // Score each flywheel component 0-100
    const velocityScore = Math.min(100, Math.round((completedItems / Math.max(totalItems, 1)) * 100));
    const autonomyScore = Math.min(100, Math.round((sessionCount / Math.max(agentCount, 1)) * 50));
    const metaLearningScore = Math.min(100, sprintCount * 6);
    const inheritanceScore = Math.min(100, Math.round((agentCount / 134) * 100));

    return reply.send({
      data: {
        metrics: [
          { key: 'meta_learning', label: 'Meta-Learning', score: metaLearningScore, description: `${sprintCount} sprint iterations` },
          { key: 'autonomy', label: 'Autonomy', score: autonomyScore, description: `${sessionCount} autonomous sessions` },
          { key: 'inheritance', label: 'Inheritance', score: inheritanceScore, description: `${agentCount} agents inheriting patterns` },
          { key: 'velocity', label: 'Velocity', score: velocityScore, description: `${completedItems}/${totalItems} sprint items completed` },
        ],
        overallScore: Math.round((velocityScore + autonomyScore + metaLearningScore + inheritanceScore) / 4),
        updatedAt: new Date().toISOString(),
      },
    });
  });

  // ── Memory store ──────────────────────────────────────────────────────────
  app.get('/api/v5/memory', async (_req, reply) => {
    // Read memory files from .agentforge if they exist
    const memoryDir = join(projectRoot, '.agentforge/memory');
    const entries: Array<{ id: string; key: string; value: unknown; type: string; createdAt: string }> = [];
    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          entries.push({
            id: file.replace(/\.[^.]+$/, ''),
            key: file.replace(/\.[^.]+$/, ''),
            value: file.endsWith('.json') ? JSON.parse(content) : content.slice(0, 500),
            type: file.endsWith('.json') ? 'json' : 'text',
            createdAt: new Date().toISOString(),
          });
        } catch { /* skip */ }
      }
    }
    return reply.send({ data: entries, meta: { total: entries.length } });
  });

  app.delete('/api/v5/memory/:id', async (req, reply) => {
    return reply.send({ ok: true });
  });

}
