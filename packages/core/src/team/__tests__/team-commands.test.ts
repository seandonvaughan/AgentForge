import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTeamSession, listTeamSessions, showGeneratedTeam } from '../index.js';

describe('package-native team helpers', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-team-'));
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLog.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('shows the generated team from .agentforge/team.yaml', async () => {
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'team.yaml'),
      [
        'name: Demo Team',
        'forged_at: 2026-04-15T12:00:00.000Z',
        'project_hash: abc123',
        'agents:',
        '  strategic: []',
        '  implementation:',
        '    - Backend',
        '  quality: []',
        '  utility: []',
        'model_routing:',
        '  opus: []',
        '  sonnet:',
        '    - Backend',
        '  haiku: []',
        'delegation_graph:',
        '  Backend: []',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'backend.yaml'),
      [
        'name: Backend',
        'model: sonnet',
        'version: "1"',
        'description: API implementation agent',
        'skills:',
        '  - api',
        'collaboration:',
        '  can_delegate_to: []',
        '  reports_to: null',
      ].join('\n'),
    );

    const exitCode = await showGeneratedTeam(projectRoot, { verbose: true });

    expect(exitCode).toBe(0);
    const output = consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('Current Team Composition');
    expect(output).toContain('Demo Team');
    expect(output).toContain('Backend (sonnet)');
    expect(output).toContain('Detailed Agent Info');
    expect(output).toContain('Delegation Graph');
  });

  it('lists and deletes hibernated team sessions from compatibility directories', async () => {
    mkdirSync(join(projectRoot, '.agentforge', 'sessions'), { recursive: true });
    mkdirSync(join(projectRoot, '.agentforge', 'team-sessions'), { recursive: true });

    writeFileSync(
      join(projectRoot, '.agentforge', 'sessions', 'session-alpha-1.json'),
      JSON.stringify({
        sessionId: 'alpha',
        autonomyLevel: 'guided',
        hibernatedAt: '2026-04-15T10:00:00.000Z',
        projectRoot,
        teamManifest: { name: 'Alpha Team' },
        feedEntries: [{ id: 1 }],
        gitCommitAtHibernation: 'deadbeef',
        sessionBudgetUsd: 100,
        spentUsd: 25,
      }),
    );
    writeFileSync(
      join(projectRoot, '.agentforge', 'sessions', 'cost-entry-legacy.json'),
      JSON.stringify({ costUsd: 10 }),
    );
    writeFileSync(
      join(projectRoot, '.agentforge', 'team-sessions', 'session-beta-2.json'),
      JSON.stringify({
        sessionId: 'beta',
        autonomyLevel: 'supervised',
        hibernatedAt: '2026-04-15T11:00:00.000Z',
        projectRoot,
        teamManifest: { name: 'Beta Team' },
        feedEntries: [{ id: 1 }, { id: 2 }],
        gitCommitAtHibernation: 'cafebabe',
        sessionBudgetUsd: 200,
        spentUsd: 75,
      }),
    );

    const listExitCode = await listTeamSessions(projectRoot);

    expect(listExitCode).toBe(0);
    let output = consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('Hibernated Sessions');
    expect(output).toContain('Alpha Team');
    expect(output).toContain('Beta Team');

    consoleLog.mockClear();

    const deleteExitCode = await deleteTeamSession(projectRoot, 'alpha');

    expect(deleteExitCode).toBe(0);
    output = consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('Session alpha deleted');
    expect(
      existsSync(join(projectRoot, '.agentforge', 'sessions', 'session-alpha-1.json')),
    ).toBe(false);
  });
});
