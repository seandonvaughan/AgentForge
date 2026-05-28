import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliProgram } from '../bin.js';

interface CompletedLedger {
  version: number;
  entries: Array<{
    itemId: string;
    completedAt: string;
    updatedAt: string;
    cycleId?: string;
    prNumber?: number;
    reason?: string;
  }>;
}

describe('agentforge backlog complete', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-backlog-complete-'));
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

  it('writes and then idempotently updates a completion entry across raw/canonical itemId variants', async () => {
    await runCli([
      'backlog',
      'complete',
      'dogfood 001',
      '--project-root',
      projectRoot,
      '--cycle',
      'cycle-1',
      '--pr',
      '101',
      '--reason',
      'Merged to main',
    ]);

    const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
    expect(existsSync(ledgerPath)).toBe(true);

    const first = readLedger(ledgerPath);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      itemId: 'backlog-dogfood-001',
      cycleId: 'cycle-1',
      prNumber: 101,
      reason: 'Merged to main',
    });
    const firstCompletedAt = first.entries[0]!.completedAt;

    await runCli([
      'backlog',
      'complete',
      ' Backlog Dogfood 001 ',
      '--project-root',
      projectRoot,
      '--cycle',
      'cycle-2',
      '--pr',
      '202',
      '--reason',
      'Re-audited after follow-up',
    ]);

    const second = readLedger(ledgerPath);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      itemId: 'backlog-dogfood-001',
      cycleId: 'cycle-2',
      prNumber: 202,
      reason: 'Re-audited after follow-up',
      completedAt: firstCompletedAt,
    });
  });

  it.each(['0', '-1', '1.5', '123abc', ' 123', '123 ', '01'])(
    'rejects invalid --pr value %s and does not create completed.json',
    async (prValue) => {
      await runCli([
        'backlog',
        'complete',
        'backlog-dogfood-001',
        '--project-root',
        projectRoot,
        '--pr',
        prValue,
      ]);

      const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
      expect(process.exitCode).toBe(1);
      expect(existsSync(ledgerPath)).toBe(false);
    },
  );

  it('does not corrupt an existing completed.json when --pr is invalid', async () => {
    await runCli([
      'backlog',
      'complete',
      'backlog-existing',
      '--project-root',
      projectRoot,
      '--pr',
      '42',
    ]);

    const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
    const before = readFileSync(ledgerPath, 'utf8');

    await runCli([
      'backlog',
      'complete',
      'backlog-existing',
      '--project-root',
      projectRoot,
      '--pr',
      '42oops',
      '--reason',
      'should fail',
    ]);

    const after = readFileSync(ledgerPath, 'utf8');
    expect(process.exitCode).toBe(1);
    expect(after).toBe(before);
  });

  async function runCli(args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }

  function readLedger(path: string): CompletedLedger {
    return JSON.parse(readFileSync(path, 'utf8')) as CompletedLedger;
  }
});

describe('agentforge backlog status', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-backlog-status-'));
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

  it('prints deterministic status counts and active scoped item ids/titles with scope', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({
        items: [
          { id: 'scoped task', title: 'Scoped Task', estimatedComplexity: 'low', files: ['packages/cli/src/bin.ts'] },
          { id: 'routed task', title: 'Routed Task', estimatedComplexity: 'low', files: ['packages/cli/src/commands/backlog.ts'], runtimeMode: 'codex-cli', preferredProvider: 'codex-cli' },
          { id: 'high task', title: 'High Task', estimatedComplexity: 'high', files: ['packages/core/src/autonomous/proposal-to-backlog.ts'] },
          { id: 'noscope', title: 'No Scope Task', estimatedComplexity: 'low' },
          { id: 'done task', title: 'Done Task', estimatedComplexity: 'low', files: ['packages/cli/src/commands/backlog.ts'] },
          { id: 'quarantined task!!', title: 'Quarantined Task', estimatedComplexity: 'low', files: ['packages/cli/src/__tests__/backlog-command.test.ts'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'completed.json'),
      JSON.stringify({ entries: [{ itemId: ' Done Task ', completedAt: '2026-05-27T00:00:00.000Z' }] }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'quarantine.json'),
      JSON.stringify({ ids: [' QUARANTINED task ', 'backlog-quarantined-task', 42] }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('[backlog] status');
    expect(output).toContain('activeBacklogFileItems: 4');
    expect(output).toContain('activeResearchPlanItems: 0');
    expect(output).toContain('completedLedgerEntries: 1');
    expect(output).toContain('quarantinedIds: 1');
    expect(output).toContain('unattendedExcludedBacklogItems: 2');
    expect(output).toContain('runtimeRoutingHints: scoped=2 routed=1 default=1');
    expect(output).toContain('duplicateNormalizedIds: (none)');
    expect(output).toContain('activeScopedItemsCount: 2');
    expect(output).toContain('readyForCycle: yes');
    expect(output).toContain('- backlog-scoped-task: Scoped Task [complexity=low, source=items.json, scope=packages/cli/src/bin.ts]');
    expect(output).toContain('- backlog-routed-task: Routed Task [complexity=low, source=items.json, scope=packages/cli/src/commands/backlog.ts, runtime=codex-cli, provider=codex-cli]');
    expect(output).not.toContain('sourceFile: items.json');
    expect(output).not.toContain('High Task');
    expect(output).not.toContain('No Scope Task');
  });

  it('prints deterministic machine-readable JSON status with --json', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({
        items: [
          { id: 'scoped task', title: 'Scoped Task', estimatedComplexity: 'low', files: ['packages/cli/src/bin.ts'] },
          { id: 'routed task', title: 'Routed Task', estimatedComplexity: 'low', files: ['packages/cli/src/commands/backlog.ts'], runtimeMode: 'codex-cli', preferredProvider: 'codex-cli' },
          { id: 'high task', title: 'High Task', estimatedComplexity: 'high', files: ['packages/core/src/autonomous/proposal-to-backlog.ts'] },
          { id: 'done task', title: 'Done Task', estimatedComplexity: 'low', files: ['packages/cli/src/commands/backlog.ts'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'completed.json'),
      JSON.stringify({ entries: [{ itemId: ' Done Task ', completedAt: '2026-05-27T00:00:00.000Z' }] }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'quarantine.json'),
      JSON.stringify({ ids: ['missing-item'] }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot, '--json']);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).not.toContain('[backlog] status');
    expect(JSON.parse(output)).toEqual({
      projectRoot,
      activeBacklogFileItems: 3,
      activeResearchPlanItems: 0,
      completedLedgerEntries: 1,
      quarantinedIds: 1,
      unattendedExcludedBacklogItems: 1,
      runtimeRoutingHints: {
        scopedItems: 2,
        routedItems: 1,
        defaultItems: 1,
      },
      duplicateNormalizedIds: [],
      readyForCycle: true,
      activeScopedItemsCount: 2,
      activeScopedItems: [
        {
          id: 'backlog-routed-task',
          title: 'Routed Task',
          estimatedComplexity: 'low',
          runtimeMode: 'codex-cli',
          preferredProvider: 'codex-cli',
          sourceFile: 'items.json',
          scopeFiles: ['packages/cli/src/commands/backlog.ts'],
        },
        {
          id: 'backlog-scoped-task',
          title: 'Scoped Task',
          estimatedComplexity: 'low',
          runtimeMode: null,
          preferredProvider: null,
          sourceFile: 'items.json',
          scopeFiles: ['packages/cli/src/bin.ts'],
        },
      ],
    });
  });

  it('normalizes mixed raw/canonical IDs and drops blank or un-normalizable IDs', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({
        items: [
          { id: 'dogfood 002', title: 'Dogfood Raw', estimatedComplexity: 'low', files: ['README.md'] },
          { id: 'backlog-dogfood-002', title: 'Dogfood Canonical', estimatedComplexity: 'low', files: ['README.md'] },
          { id: ' Backlog Dogfood 002 ', title: 'Dogfood Prefix Phrase', estimatedComplexity: 'low', files: ['README.md'] },
          { id: ' visible task ', title: 'Visible Task', estimatedComplexity: 'low', files: ['README.md'] },
          { id: 'backlog', title: 'Prefix Only', estimatedComplexity: 'low', files: ['README.md'] },
          { id: '!!!', title: 'Invalid ID', estimatedComplexity: 'low', files: ['README.md'] },
          { title: 'No ID uses fallback', estimatedComplexity: 'low', files: ['README.md'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'completed.json'),
      JSON.stringify({ entries: [{ itemId: ' backlog dogfood 002 ', completedAt: '2026-05-27T00:00:00.000Z' }] }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'quarantine.json'),
      JSON.stringify({ ids: [' Backlog Visible Task ', ''], }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('activeBacklogFileItems: 1');
    expect(output).toContain('activeResearchPlanItems: 0');
    expect(output).toContain('completedLedgerEntries: 1');
    expect(output).toContain('quarantinedIds: 1');
    expect(output).toContain('unattendedExcludedBacklogItems: 0');
    expect(output).toContain('runtimeRoutingHints: scoped=1 routed=0 default=1');
    expect(output).toContain('duplicateNormalizedIds: (none)');
    expect(output).toContain('activeScopedItemsCount: 1');
    expect(output).toContain('- backlog-items-json-no-id-uses-fallback: No ID uses fallback [complexity=low, source=items.json, scope=README.md]');
    expect(output).not.toContain('Dogfood Raw');
    expect(output).not.toContain('Dogfood Canonical');
    expect(output).not.toContain('Dogfood Prefix Phrase');
    expect(output).not.toContain('Visible Task');
    expect(output).not.toContain('Prefix Only');
    expect(output).not.toContain('Invalid ID');
  });

  it('tolerates malformed completed/quarantine files and keeps status deterministic', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({ items: [{ id: 'visible', title: 'Visible Item', estimatedComplexity: 'low', files: ['README.md'] }] }),
      'utf8',
    );
    writeFileSync(join(backlogDir, 'completed.json'), '{ malformed', 'utf8');
    writeFileSync(join(backlogDir, 'quarantine.json'), '{ malformed', 'utf8');

    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('activeBacklogFileItems: 1');
    expect(output).toContain('activeResearchPlanItems: 0');
    expect(output).toContain('completedLedgerEntries: 0');
    expect(output).toContain('quarantinedIds: 0');
    expect(output).toContain('unattendedExcludedBacklogItems: 0');
    expect(output).toContain('runtimeRoutingHints: scoped=1 routed=0 default=1');
    expect(output).toContain('duplicateNormalizedIds: (none)');
    expect(output).toContain('activeScopedItemsCount: 1');
    expect(output).toContain('- backlog-visible: Visible Item [complexity=low, source=items.json, scope=README.md]');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports duplicate normalized IDs with source context deterministically', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'alpha-a.json'),
      JSON.stringify({
        items: [
          { id: 'alpha', title: 'Zulu', estimatedComplexity: 'low', files: ['README.md'] },
          { id: 'beta', title: 'Beta', estimatedComplexity: 'low', files: ['README.md'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'alpha-b.json'),
      JSON.stringify({
        items: [
          { id: 'alpha!!', title: 'Alpha', estimatedComplexity: 'low', files: ['README.md'] },
        ],
      }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const scopedLines = consoleLog.mock.calls
      .map((args: unknown[]) => String(args[0] ?? ''))
      .filter((line: string) => line.startsWith('    - '));
    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain(
      'duplicateNormalizedIds: backlog-alpha x2: Alpha (alpha-b.json); Zulu (alpha-a.json)',
    );
    expect(scopedLines).toEqual([
      '    - backlog-alpha: Alpha [complexity=low, source=alpha-b.json, scope=README.md]',
      '    - backlog-alpha: Zulu [complexity=low, source=alpha-a.json, scope=README.md]',
      '    - backlog-beta: Beta [complexity=low, source=alpha-a.json, scope=README.md]',
    ]);
    expect(output).not.toContain('sourceFile: alpha-a.json');
    expect(output).not.toContain('sourceFile: alpha-b.json');
  });

  it('prints duplicate normalized ID source context in JSON', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'beta.json'),
      JSON.stringify({
        items: [
          { id: 'beta', title: 'Beta Two', estimatedComplexity: 'low', files: ['README.md'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'alpha.json'),
      JSON.stringify({
        items: [
          { id: 'alpha', title: 'Alpha Two', estimatedComplexity: 'low', files: ['README.md'] },
          { id: 'backlog-alpha', title: 'Alpha One', estimatedComplexity: 'low', files: ['README.md'] },
          { id: 'beta!!', title: 'Beta One', estimatedComplexity: 'low', files: ['README.md'] },
        ],
      }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot, '--json']);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.duplicateNormalizedIds).toEqual([
      {
        id: 'backlog-alpha',
        count: 2,
        items: [
          { title: 'Alpha One', sourceFile: 'alpha.json' },
          { title: 'Alpha Two', sourceFile: 'alpha.json' },
        ],
      },
      {
        id: 'backlog-beta',
        count: 2,
        items: [
          { title: 'Beta One', sourceFile: 'alpha.json' },
          { title: 'Beta Two', sourceFile: 'beta.json' },
        ],
      },
    ]);
  });

  it('prints deterministic empty status when backlog directory is missing', async () => {
    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('[backlog] status');
    expect(output).toContain('activeBacklogFileItems: 0');
    expect(output).toContain('activeResearchPlanItems: 0');
    expect(output).toContain('completedLedgerEntries: 0');
    expect(output).toContain('quarantinedIds: 0');
    expect(output).toContain('unattendedExcludedBacklogItems: 0');
    expect(output).toContain('runtimeRoutingHints: scoped=0 routed=0 default=0');
    expect(output).toContain('duplicateNormalizedIds: (none)');
    expect(output).toContain('  activeScopedItemsCount: 0');
    expect(output).toContain('  readyForCycle: no');
    expect(output).toContain('  activeScopedItems:');
    expect(output).toContain('    (none)');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints readyForCycle false in JSON when active scoped items are empty', async () => {
    await runCli(['backlog', 'status', '--project-root', projectRoot, '--json']);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.activeScopedItemsCount).toBe(0);
    expect(parsed.activeScopedItems).toEqual([]);
    expect(parsed.readyForCycle).toBe(false);
    expect(parsed.activeBacklogFileItems).toBe(0);
    expect(parsed.activeResearchPlanItems).toBe(0);
  });

  it('includes planned research candidates in text status and scoped/routing counts', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    const researchRunDir = join(projectRoot, '.agentforge', 'research-runs', 'run-123');
    mkdirSync(backlogDir, { recursive: true });
    mkdirSync(researchRunDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({
        items: [
          { id: 'scoped task', title: 'Scoped Task', estimatedComplexity: 'low', files: ['packages/cli/src/bin.ts'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(researchRunDir, 'run.json'),
      JSON.stringify({
        plannedCycle: { ideaIds: ['idea-001'] },
        ideas: [
          { ideaId: 'idea-001', status: 'planned', title: 'Research Candidate', risk: 'medium', touchedAreas: ['packages/core/src/autonomous/proposal-to-backlog.ts'] },
        ],
      }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot]);

    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('activeBacklogFileItems: 1');
    expect(output).toContain('activeResearchPlanItems: 1');
    expect(output).toContain('runtimeRoutingHints: scoped=2 routed=0 default=2');
    expect(output).toContain('activeScopedItemsCount: 2');
    expect(output).toContain('readyForCycle: yes');
    expect(output).toContain('- backlog-research-run-123-idea-001: Research Candidate [complexity=medium, source=research:run-123, scope=packages/core/src/autonomous/proposal-to-backlog.ts]');
  });

  it('includes planned research candidates in JSON activeScopedItems and counts', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    const researchRunDir = join(projectRoot, '.agentforge', 'research-runs', 'run-456');
    mkdirSync(backlogDir, { recursive: true });
    mkdirSync(researchRunDir, { recursive: true });
    writeFileSync(
      join(backlogDir, 'items.json'),
      JSON.stringify({
        items: [
          { id: 'scoped task', title: 'Scoped Task', estimatedComplexity: 'low', files: ['packages/cli/src/bin.ts'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(researchRunDir, 'run.json'),
      JSON.stringify({
        plannedCycle: { ideaIds: ['idea-002'] },
        ideas: [
          { ideaId: 'idea-002', status: 'planned', title: 'JSON Research Candidate', risk: 'low', touchedAreas: ['packages/cli/src/commands/backlog.ts'] },
        ],
      }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot, '--json']);
    const parsed = JSON.parse(consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n'));
    expect(parsed.activeBacklogFileItems).toBe(1);
    expect(parsed.activeResearchPlanItems).toBe(1);
    expect(parsed.readyForCycle).toBe(true);
    expect(parsed.runtimeRoutingHints).toEqual({ scopedItems: 2, routedItems: 0, defaultItems: 2 });
    expect(parsed.activeScopedItems).toEqual([
      {
        id: 'backlog-research-run-456-idea-002',
        title: 'JSON Research Candidate',
        estimatedComplexity: 'low',
        runtimeMode: null,
        preferredProvider: null,
        sourceFile: 'research:run-456',
        scopeFiles: ['packages/cli/src/commands/backlog.ts'],
      },
      {
        id: 'backlog-scoped-task',
        title: 'Scoped Task',
        estimatedComplexity: 'low',
        runtimeMode: null,
        preferredProvider: null,
        sourceFile: 'items.json',
        scopeFiles: ['packages/cli/src/bin.ts'],
      },
    ]);
  });

  it('filters completed research candidates using normalized IDs', async () => {
    const backlogDir = join(projectRoot, '.agentforge', 'backlog');
    const researchRunDir = join(projectRoot, '.agentforge', 'research-runs', 'run-789');
    mkdirSync(backlogDir, { recursive: true });
    mkdirSync(researchRunDir, { recursive: true });
    writeFileSync(
      join(researchRunDir, 'run.json'),
      JSON.stringify({
        plannedCycle: { ideaIds: ['idea-003', 'idea-004'] },
        ideas: [
          { ideaId: 'idea-003', status: 'planned', title: 'Completed Research', risk: 'low', touchedAreas: ['README.md'] },
          { ideaId: 'idea-004', status: 'planned', title: 'Visible Research', risk: 'low', touchedAreas: ['packages/cli/src/bin.ts'] },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(backlogDir, 'completed.json'),
      JSON.stringify({
        entries: [{ itemId: ' Research Run 789 Idea 003 ', completedAt: '2026-05-27T00:00:00.000Z' }],
      }),
      'utf8',
    );

    await runCli(['backlog', 'status', '--project-root', projectRoot]);
    const output = consoleLog.mock.calls.map((args: unknown[]) => String(args[0] ?? '')).join('\n');
    expect(output).toContain('activeResearchPlanItems: 1');
    expect(output).toContain('readyForCycle: yes');
    expect(output).toContain('Visible Research');
    expect(output).not.toContain('Completed Research');
  });

  async function runCli(args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }
});
