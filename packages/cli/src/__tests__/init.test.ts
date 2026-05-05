import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '@agentforge/core';
import { createCliProgram } from '../bin.js';

describe('agentforge init', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-init-cli-'));
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('initializes a package workspace idempotently', async () => {
    await runInit(projectRoot);

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(projectRoot, '.agentforge', 'agents'))).toBe(true);
    expect(existsSync(join(projectRoot, '.agentforge', 'sprints'))).toBe(true);
    expect(existsSync(join(projectRoot, '.agentforge', 'cycles'))).toBe(true);
    expect(existsSync(join(projectRoot, '.agentforge', 'v5', 'agentforge-master.db'))).toBe(true);
    expect(existsSync(join(projectRoot, '.agentforge', 'v5', 'workspace-default.db'))).toBe(true);

    let manager = new WorkspaceManager({ dataDir: join(projectRoot, '.agentforge', 'v5') });
    const firstWorkspace = manager.listWorkspaces()[0];
    manager.close();

    expect(firstWorkspace?.name).toBe('default');
    expect(output()).toContain('Created:      yes');
    consoleLog.mockClear();

    await runInit(projectRoot);

    manager = new WorkspaceManager({ dataDir: join(projectRoot, '.agentforge', 'v5') });
    const workspaces = manager.listWorkspaces();
    manager.close();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.id).toBe(firstWorkspace?.id);
    expect(output()).toContain('Created:      no');
  });

  async function runInit(root: string): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(['init', '--project-root', root], { from: 'user' });
  }

  function output(): string {
    return consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }
});
