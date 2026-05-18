import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../index.js';

describe('WorkspaceManager', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentforge-workspace-manager-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('quarantines a corrupt default workspace DB and recreates it', async () => {
    const firstManager = new WorkspaceManager({ dataDir });
    try {
      await firstManager.getOrCreateDefaultWorkspace();
    } finally {
      firstManager.close();
    }

    const dbPath = join(dataDir, 'workspace-default.db');
    writeFileSync(dbPath, 'not a sqlite database', 'utf8');
    writeFileSync(`${dbPath}-wal`, 'stale wal', 'utf8');

    const secondManager = new WorkspaceManager({ dataDir });
    try {
      const { adapter } = await secondManager.getOrCreateDefaultWorkspace();
      const session = adapter.createSession({
        agentId: 'tester',
        task: 'verify recovered DB is writable',
        model: 'sonnet',
      });

      expect(adapter.getSession(session.id)?.task).toBe('verify recovered DB is writable');
      expect(existsSync(join(dataDir, 'recovery'))).toBe(true);
      expect(readdirSync(join(dataDir, 'recovery')).some((file) => file.startsWith('workspace-default.db.corrupt-'))).toBe(true);
    } finally {
      secondManager.close();
    }
  });
});
