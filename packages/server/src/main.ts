#!/usr/bin/env node
import { createServerV5 } from './server.js';
import { MessageBusV2, WorkspaceManager } from '@agentforge/core';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import type { WorkspaceAdapter } from '@agentforge/db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

const PORT = parseInt(process.env['PORT'] ?? '4750', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const DATA_DIR = process.env['DATA_DIR'] ?? join(PROJECT_ROOT, '.agentforge/v5');

async function main() {
  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Initialize message bus
  const bus = new MessageBusV2();

  // Initialize workspace manager
  const manager = new WorkspaceManager({ dataDir: DATA_DIR });
  const { workspace: defaultWorkspace, adapter } = await manager.getOrCreateDefaultWorkspace();
  const registry = manager.getRegistry();

  console.log(`\nAgentForge v6.0`);
  console.log(`  Workspace: ${defaultWorkspace.name} (${defaultWorkspace.id})`);
  console.log(`  Data dir:  ${DATA_DIR}`);
  console.log(`  Bus:       MessageBusV2`);

  // Seed sessions from .agentforge/sessions/ JSON files if database is empty
  seedSessionsFromFiles(adapter, PROJECT_ROOT);

  const app = await createServerV5({
    port: PORT,
    host: HOST,
    bus,
    adapter,
    registry,
    dataDir: DATA_DIR,
  });

  // Publish startup event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bus.publish as any)({
    topic: 'system.started',
    category: 'system',
    payload: {
      workspaceId: defaultWorkspace.id,
      timestamp: new Date().toISOString(),
    },
  });

  return app;
}

function seedSessionsFromFiles(adapter: WorkspaceAdapter, projectRoot: string): void {
  try {
    // Check if DB already has sessions
    const existing = adapter.listSessions({ limit: 1 });
    if (existing.length > 0) return;

    const sessionsDir = join(projectRoot, '.agentforge/sessions');
    if (!existsSync(sessionsDir)) return;

    // Read session JSON files (not cost-entry, not index)
    const files = readdirSync(sessionsDir).filter(
      f => f.endsWith('.json') && !f.startsWith('cost-entry') && f !== 'index.json'
    );

    let seeded = 0;
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
        const agentId = raw.agentId ?? raw.agentName ?? raw.task_id?.split('-')[0] ?? 'unknown';
        const task = raw.task ?? raw.objective ?? 'Imported session';
        const model = raw.model ?? 'claude-sonnet-4-6';

        const session = adapter.createSession({ agentId, task, model });
        // Estimate cost from token count
        const tokens = raw.estimatedTokens ?? Math.round((String(raw.response ?? '').length + String(raw.objective ?? '').length) / 4);
        const costUsd = tokens > 0 ? tokens * 0.000003 : 0.01; // rough estimate
        adapter.completeSession(session.id, 'completed', costUsd);
        const inputTokens = raw.estimatedTokens ?? Math.round(tokens * 0.6);
        const outputTokens = raw.estimatedTokens ? Math.round(raw.estimatedTokens * 0.4) : Math.round(tokens * 0.4);
        adapter.recordCost({ sessionId: session.id, agentId, model, inputTokens, outputTokens, costUsd });
        seeded++;
      } catch { /* skip bad files */ }
    }

    // Also read index.json for additional entries
    const indexPath = join(sessionsDir, 'index.json');
    if (existsSync(indexPath)) {
      try {
        const entries = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{
          sessionId?: string; agentId?: string; model?: string; task?: string; status?: string;
        }>;
        for (const entry of entries) {
          if (!entry.agentId) continue;
          const model = entry.model ?? 'claude-sonnet-4-6';
          const session = adapter.createSession({
            agentId: entry.agentId,
            task: entry.task ?? 'Indexed session',
            model,
          });
          adapter.completeSession(session.id, (entry.status as 'completed' | 'failed') ?? 'completed', 0.15);
          adapter.recordCost({ sessionId: session.id, agentId: entry.agentId, model, inputTokens: 5000, outputTokens: 3000, costUsd: 0.15 });
          seeded++;
        }
      } catch { /* skip */ }
    }

    if (seeded > 0) {
      console.log(`  Seeded ${seeded} session(s) from .agentforge/sessions/`);
    }
  } catch { /* non-fatal */ }
}

main().catch(err => {
  console.error('Failed to start v5 server:', err);
  process.exit(1);
});
