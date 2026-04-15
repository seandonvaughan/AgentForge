#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkspaceAdapter } from '@agentforge/db';
import { MessageBusV2, WorkspaceManager } from '@agentforge/core';
import { createServerV5 } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../');

export interface PackageServerStartOptions {
  port?: number;
  host?: string;
  projectRoot?: string;
  dataDir?: string;
}

export async function startPackageServer(
  options: PackageServerStartOptions = {},
) {
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const port = options.port ?? parseInt(process.env['PORT'] ?? '4750', 10);
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1';
  const dataDir = options.dataDir ?? process.env['DATA_DIR'] ?? join(projectRoot, '.agentforge/v5');

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const bus = new MessageBusV2();
  const manager = new WorkspaceManager({ dataDir });
  const { workspace: defaultWorkspace, adapter } = await manager.getOrCreateDefaultWorkspace();
  const registry = manager.getRegistry();

  console.log(`\nAgentForge ${readRootPackageVersion(projectRoot)}`);
  console.log(`  Workspace: ${defaultWorkspace.name} (${defaultWorkspace.id})`);
  console.log(`  Data dir:  ${dataDir}`);
  console.log(`  Host:      ${host}:${port}`);
  console.log('  Bus:       MessageBusV2');

  seedSessionsFromFiles(adapter, projectRoot);

  const server = await createServerV5({
    port,
    host,
    bus,
    adapter,
    registry,
    dataDir,
    projectRoot,
  });

  (bus.publish as any)({
    topic: 'system.started',
    category: 'system',
    payload: {
      workspaceId: defaultWorkspace.id,
      timestamp: new Date().toISOString(),
    },
  });

  return {
    ...server,
    manager,
    adapter,
    registry,
    projectRoot,
    dataDir,
  };
}

function seedSessionsFromFiles(adapter: WorkspaceAdapter, projectRoot: string): void {
  try {
    const existing = adapter.listSessions({ limit: 1 });
    if (existing.length > 0) return;

    const sessionsDir = join(projectRoot, '.agentforge/sessions');
    if (!existsSync(sessionsDir)) return;

    const files = readdirSync(sessionsDir).filter(
      (file) => file.endsWith('.json') && !file.startsWith('cost-entry') && file !== 'index.json',
    );

    let seeded = 0;
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
        const agentId = raw.agentId ?? raw.agentName ?? raw.task_id?.split('-')[0] ?? 'unknown';
        const task = raw.task ?? raw.objective ?? 'Imported session';
        const model = raw.model ?? 'claude-sonnet-4-6';

        const session = adapter.createSession({ agentId, task, model });
        const tokens =
          raw.estimatedTokens ??
          Math.round((String(raw.response ?? '').length + String(raw.objective ?? '').length) / 4);
        const costUsd = tokens > 0 ? tokens * 0.000003 : 0.01;
        const inputTokens = raw.estimatedTokens ?? Math.round(tokens * 0.6);
        const outputTokens = raw.estimatedTokens
          ? Math.round(raw.estimatedTokens * 0.4)
          : Math.round(tokens * 0.4);

        adapter.completeSession(session.id, 'completed', costUsd);
        adapter.recordCost({
          sessionId: session.id,
          agentId,
          model,
          inputTokens,
          outputTokens,
          costUsd,
        });
        seeded += 1;
      } catch {
        // Skip malformed files.
      }
    }

    const indexPath = join(sessionsDir, 'index.json');
    if (existsSync(indexPath)) {
      try {
        const entries = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{
          sessionId?: string;
          agentId?: string;
          model?: string;
          task?: string;
          status?: string;
        }>;
        for (const entry of entries) {
          if (!entry.agentId) continue;
          const model = entry.model ?? 'claude-sonnet-4-6';
          const session = adapter.createSession({
            agentId: entry.agentId,
            task: entry.task ?? 'Indexed session',
            model,
          });
          adapter.completeSession(
            session.id,
            (entry.status as 'completed' | 'failed') ?? 'completed',
            0.15,
          );
          adapter.recordCost({
            sessionId: session.id,
            agentId: entry.agentId,
            model,
            inputTokens: 5000,
            outputTokens: 3000,
            costUsd: 0.15,
          });
          seeded += 1;
        }
      } catch {
        // Skip malformed index file.
      }
    }

    if (seeded > 0) {
      console.log(`  Seeded ${seeded} session(s) from .agentforge/sessions/`);
    }
  } catch {
    // Non-fatal boot seeding.
  }
}

function readRootPackageVersion(projectRoot: string): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { version?: string };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  await startPackageServer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Failed to start package server:', err);
    process.exit(1);
  });
}
