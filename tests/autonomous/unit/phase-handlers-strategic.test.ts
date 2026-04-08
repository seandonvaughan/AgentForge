// tests/autonomous/unit/phase-handlers-strategic.test.ts
//
// v6.5.2 — Tests for strategic phase handlers (audit, plan, assign,
// gate, learn). All exercised against a mocked runtime — no real
// `claude -p` calls.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAuditPhase,
  runPlanPhase,
  runAssignPhase,
  runGatePhase,
  runLearnPhase,
  GateRejectedError,
  parseGateVerdict,
  extractFindingsByLevel,
  inferAssigneeFromTag,
  inferAssignee,
  readRecentMemoryEntries,
  formatMemoryForPrompt,
  type CycleMemoryEntry,
} from '../../../packages/core/src/autonomous/phase-handlers/index.js';
import type { PhaseContext } from '../../../packages/core/src/autonomous/phase-scheduler.js';

function makeMockBus() {
  const subscribers: Record<string, Array<(event: any) => void>> = {};
  const published: Array<{ topic: string; payload: any }> = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: any) => {
        published.push({ topic, payload });
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (event: any) => void) => {
        if (!subscribers[topic]) subscribers[topic] = [];
        subscribers[topic]!.push(cb);
        return () => {
          subscribers[topic] = subscribers[topic]!.filter((c) => c !== cb);
        };
      },
    } as any,
  };
}

function writeSprintFile(
  cwd: string,
  version: string,
  items: Array<{ id: string; title: string; assignee?: string; tags?: string[] }>,
) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  const wrapper = {
    sprints: [
      {
        version,
        sprintId: `v${version}-test`,
        title: `v${version}`,
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: items.map((i) => ({ status: 'planned', priority: 'P1', estimatedCostUsd: 0, ...i })),
        budget: 10,
        teamSize: 1,
        successCriteria: [],
      },
    ],
  };
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify(wrapper, null, 2));
}

function makeCtx(opts: { cwd: string; sprintVersion: string; cycleId?: string; runtime: any; bus: any }): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    adapter: {},
    bus: opts.bus,
    runtime: opts.runtime,
    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
  };
}

function makeTmp(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'phase-strat-'));
  return { cwd, cleanup: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} } };
}

describe('runAuditPhase', () => {
  it('calls researcher and writes audit.json', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', []);
      const cycleId = 'cycle-1';
      const calls: any[] = [];
      const runtime = {
        run: async (agentId: string, task: string, opts: any) => {
          calls.push({ agentId, task, opts });
          return { output: '## Findings\n- something', costUsd: 0.05, durationMs: 100 };
        },
      };
      const { bus, published } = makeMockBus();
      const result = await runAuditPhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId, runtime, bus }));
      expect(result.status).toBe('completed');
      expect(calls[0].agentId).toBe('researcher');
      expect(calls[0].opts.allowedTools).toEqual(['Read', 'Bash', 'Glob', 'Grep']);
      const auditPath = join(cwd, '.agentforge/cycles', cycleId, 'phases/audit.json');
      expect(existsSync(auditPath)).toBe(true);
      const j = JSON.parse(readFileSync(auditPath, 'utf8'));
      expect(j.findings).toContain('Findings');
      expect(published.some((p) => p.topic === 'sprint.phase.started')).toBe(true);
      expect(published.some((p) => p.topic === 'sprint.phase.completed')).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('runPlanPhase', () => {
  it('reads audit.json and produces plan.json', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [{ id: 'i1', title: 'Item 1', tags: ['fix'] }]);
      const cycleId = 'c2';
      mkdirSync(join(cwd, '.agentforge/cycles', cycleId, 'phases'), { recursive: true });
      writeFileSync(
        join(cwd, '.agentforge/cycles', cycleId, 'phases/audit.json'),
        JSON.stringify({ findings: 'AUDIT-FINDINGS-MARKER' }),
      );
      const calls: any[] = [];
      const runtime = {
        run: async (agentId: string, task: string) => {
          calls.push({ agentId, task });
          return { output: 'PLAN-CONTENT', costUsd: 0.1 };
        },
      };
      const { bus } = makeMockBus();
      const result = await runPlanPhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId, runtime, bus }));
      expect(result.status).toBe('completed');
      expect(calls[0].agentId).toBe('cto');
      expect(calls[0].task).toContain('AUDIT-FINDINGS-MARKER');
      expect(calls[0].task).toContain('Item 1');
      const planPath = join(cwd, '.agentforge/cycles', cycleId, 'phases/plan.json');
      const j = JSON.parse(readFileSync(planPath, 'utf8'));
      expect(j.plan).toBe('PLAN-CONTENT');
    } finally {
      cleanup();
    }
  });

  it('works when audit.json is missing', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [{ id: 'i1', title: 'Item 1' }]);
      const calls: any[] = [];
      const runtime = {
        run: async (a: string, t: string) => {
          calls.push(t);
          return { output: 'plan', costUsd: 0 };
        },
      };
      const { bus } = makeMockBus();
      const result = await runPlanPhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'c3', runtime, bus }));
      expect(result.status).toBe('completed');
      expect(calls[0]).toContain('no audit findings available');
    } finally {
      cleanup();
    }
  });
});

describe('runAssignPhase', () => {
  it('infers assignees from tags via keyword mapping', () => {
    expect(inferAssigneeFromTag('fix')).toBe('coder');
    expect(inferAssigneeFromTag('bug')).toBe('coder');
    expect(inferAssigneeFromTag('security')).toBe('coder');
    expect(inferAssigneeFromTag('feature')).toBe('coder');
    expect(inferAssigneeFromTag('docs')).toBe('backend-tech-writer');
    expect(inferAssigneeFromTag('breaking')).toBe('architect');
    expect(inferAssigneeFromTag('architecture')).toBe('architect');
    expect(inferAssigneeFromTag('test')).toBe('backend-qa');
    expect(inferAssigneeFromTag('qa')).toBe('backend-qa');
    expect(inferAssigneeFromTag('unknown')).toBeNull();
    expect(inferAssignee({ id: 'x', title: 'y', tags: [] })).toBe('coder');
  });

  it('preserves existing assignments and assigns missing ones', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [
        { id: 'a', title: 'A', assignee: 'cto', tags: ['fix'] },
        { id: 'b', title: 'B', tags: ['docs'] },
        { id: 'c', title: 'C', tags: ['breaking'] },
      ]);
      const { bus } = makeMockBus();
      const cycleId = 'c4';
      const result = await runAssignPhase(
        makeCtx({ cwd, sprintVersion: '6.5.2', cycleId, runtime: {}, bus }),
      );
      expect(result.status).toBe('completed');
      const sprintFile = JSON.parse(
        readFileSync(join(cwd, '.agentforge/sprints/v6.5.2.json'), 'utf8'),
      );
      const items = sprintFile.sprints[0].items;
      expect(items[0].assignee).toBe('cto'); // preserved
      expect(items[1].assignee).toBe('backend-tech-writer');
      expect(items[2].assignee).toBe('architect');
      const j = JSON.parse(
        readFileSync(join(cwd, '.agentforge/cycles', cycleId, 'phases/assign.json'), 'utf8'),
      );
      expect(j.assignmentCount).toBe(2);
      expect(j.byAgent.cto).toBe(1);
      expect(j.byAgent.architect).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('runGatePhase', () => {
  it('parseGateVerdict handles APPROVE JSON', () => {
    expect(parseGateVerdict('{"verdict":"APPROVE","rationale":"good"}')).toEqual({
      verdict: 'APPROVE',
      rationale: 'good',
    });
  });

  it('completes on APPROVE verdict', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [{ id: 'a', title: 'A' }]);
      const runtime = {
        run: async () => ({
          output: '{"verdict":"APPROVE","rationale":"all good"}',
          costUsd: 0.2,
        }),
      };
      const { bus, published } = makeMockBus();
      const result = await runGatePhase(
        makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'g1', runtime, bus }),
      );
      expect(result.status).toBe('completed');
      const j = JSON.parse(
        readFileSync(join(cwd, '.agentforge/cycles/g1/phases/gate.json'), 'utf8'),
      );
      expect(j.verdict).toBe('APPROVE');
      expect(j.rationale).toBe('all good');
      expect(published.some((p) => p.topic === 'sprint.phase.started')).toBe(true);
      expect(published.some((p) => p.topic === 'sprint.phase.completed')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('throws GateRejectedError on REJECT verdict', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', []);
      const runtime = {
        run: async () => ({
          output: '{"verdict":"REJECT","rationale":"tests broken"}',
          costUsd: 0,
        }),
      };
      const { bus } = makeMockBus();
      await expect(
        runGatePhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'g2', runtime, bus })),
      ).rejects.toBeInstanceOf(GateRejectedError);
    } finally {
      cleanup();
    }
  });

  it('handles malformed JSON as REJECT with raw text rationale', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', []);
      const runtime = {
        run: async () => ({ output: 'not json at all', costUsd: 0 }),
      };
      const { bus } = makeMockBus();
      await expect(
        runGatePhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'g3', runtime, bus })),
      ).rejects.toBeInstanceOf(GateRejectedError);
      const j = JSON.parse(
        readFileSync(join(cwd, '.agentforge/cycles/g3/phases/gate.json'), 'utf8'),
      );
      expect(j.verdict).toBe('REJECT');
      expect(j.rationale).toContain('not json');
    } finally {
      cleanup();
    }
  });

  it('writes gate-verdict memory entry on APPROVE', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [{ id: 'x', title: 'X' }]);
      const runtime = {
        run: async () => ({
          output: '{"verdict":"APPROVE","rationale":"all good"}',
          costUsd: 0.1,
        }),
      };
      const { bus } = makeMockBus();
      await runGatePhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'mem-1', runtime, bus }));
      const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
      expect(existsSync(memFile)).toBe(true);
      const entry = JSON.parse(readFileSync(memFile, 'utf8').trim());
      expect(entry.type).toBe('gate-verdict');
      expect(entry.source).toBe('mem-1');
      expect(entry.tags).toContain('verdict:approve');
      const val = JSON.parse(entry.value);
      expect(val.verdict).toBe('APPROVE');
      expect(val.cycleId).toBe('mem-1');
      expect(val.sprintVersion).toBe('6.5.2');
      expect(Array.isArray(val.criticalFindings)).toBe(true);
      expect(Array.isArray(val.majorFindings)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('writes gate-verdict memory entry on REJECT (before throwing)', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', []);
      const runtime = {
        run: async () => ({
          output: '{"verdict":"REJECT","rationale":"zero test coverage on CRITICAL path"}',
          costUsd: 0,
        }),
      };
      const { bus } = makeMockBus();
      await expect(
        runGatePhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'mem-2', runtime, bus })),
      ).rejects.toBeInstanceOf(GateRejectedError);
      const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
      expect(existsSync(memFile)).toBe(true);
      const entry = JSON.parse(readFileSync(memFile, 'utf8').trim());
      expect(entry.type).toBe('gate-verdict');
      expect(entry.tags).toContain('verdict:reject');
      const val = JSON.parse(entry.value);
      expect(val.verdict).toBe('REJECT');
    } finally {
      cleanup();
    }
  });

  it('extracts CRITICAL and MAJOR findings from review text', () => {
    const review = [
      '## Findings',
      '- CRITICAL: zero test coverage on approval endpoint',
      '- MAJOR: untyped (i: any) silently swallows errors',
      '- Minor: variable naming could be clearer',
      'Overall verdict: 2/5',
    ].join('\n');
    expect(extractFindingsByLevel(review, 'CRITICAL')).toEqual([
      '- CRITICAL: zero test coverage on approval endpoint',
    ]);
    expect(extractFindingsByLevel(review, 'MAJOR')).toEqual([
      '- MAJOR: untyped (i: any) silently swallows errors',
    ]);
    expect(extractFindingsByLevel(review, 'CRITICAL')).toHaveLength(1);
  });

  it('captures criticalFindings from review phase output in memory entry', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', [{ id: 'y', title: 'Y' }]);
      // Seed a review.json so the gate phase reads critical findings from it
      const phasesDir = join(cwd, '.agentforge', 'cycles', 'mem-3', 'phases');
      mkdirSync(phasesDir, { recursive: true });
      writeFileSync(
        join(phasesDir, 'review.json'),
        JSON.stringify({
          findings: '- CRITICAL: missing auth on write endpoint\n- MAJOR: no tests',
        }),
      );
      const runtime = {
        run: async () => ({
          output: '{"verdict":"REJECT","rationale":"critical auth gap"}',
          costUsd: 0,
        }),
      };
      const { bus } = makeMockBus();
      await expect(
        runGatePhase(makeCtx({ cwd, sprintVersion: '6.5.2', cycleId: 'mem-3', runtime, bus })),
      ).rejects.toBeInstanceOf(GateRejectedError);
      const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
      const val = JSON.parse(JSON.parse(readFileSync(memFile, 'utf8').trim()).value);
      expect(val.criticalFindings).toHaveLength(1);
      expect(val.criticalFindings[0]).toContain('CRITICAL');
      expect(val.majorFindings).toHaveLength(1);
      expect(val.majorFindings[0]).toContain('MAJOR');
    } finally {
      cleanup();
    }
  });
});

describe('readRecentMemoryEntries', () => {
  it('returns [] when memory directory does not exist', () => {
    const { cwd, cleanup } = makeTmp();
    try {
      expect(readRecentMemoryEntries(cwd)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reads entries from a single .jsonl file', () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const memDir = join(cwd, '.agentforge', 'memory');
      mkdirSync(memDir, { recursive: true });
      const e1: CycleMemoryEntry = {
        id: 'e1',
        type: 'gate-verdict',
        value: 'REJECT: tests were broken',
        createdAt: '2026-04-07T12:00:00.000Z',
        source: 'cycle-abc',
      };
      const e2: CycleMemoryEntry = {
        id: 'e2',
        type: 'gate-verdict',
        value: 'APPROVE: all green',
        createdAt: '2026-04-08T08:00:00.000Z',
        source: 'cycle-def',
      };
      writeFileSync(join(memDir, 'gate-verdict.jsonl'), `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
      const entries = readRecentMemoryEntries(cwd);
      expect(entries).toHaveLength(2);
      // newest first
      expect(entries[0].id).toBe('e2');
      expect(entries[1].id).toBe('e1');
    } finally {
      cleanup();
    }
  });

  it('reads entries across multiple .jsonl files', () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const memDir = join(cwd, '.agentforge', 'memory');
      mkdirSync(memDir, { recursive: true });
      const verdict: CycleMemoryEntry = {
        id: 'v1',
        type: 'gate-verdict',
        value: 'REJECT: coverage < 80%',
        createdAt: '2026-04-07T10:00:00.000Z',
      };
      const finding: CycleMemoryEntry = {
        id: 'f1',
        type: 'review-finding',
        value: 'Missing error handling in execute-phase',
        createdAt: '2026-04-07T11:00:00.000Z',
      };
      writeFileSync(join(memDir, 'gate-verdict.jsonl'), JSON.stringify(verdict) + '\n');
      writeFileSync(join(memDir, 'review-finding.jsonl'), JSON.stringify(finding) + '\n');
      const entries = readRecentMemoryEntries(cwd);
      expect(entries).toHaveLength(2);
      const types = entries.map((e) => e.type);
      expect(types).toContain('gate-verdict');
      expect(types).toContain('review-finding');
    } finally {
      cleanup();
    }
  });

  it('skips malformed lines without throwing', () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const memDir = join(cwd, '.agentforge', 'memory');
      mkdirSync(memDir, { recursive: true });
      const good: CycleMemoryEntry = {
        id: 'g1',
        type: 'learned-fact',
        value: 'Always bump package.json version',
        createdAt: '2026-04-08T09:00:00.000Z',
      };
      writeFileSync(
        join(memDir, 'learned-fact.jsonl'),
        `{bad json\n${JSON.stringify(good)}\n`,
      );
      const entries = readRecentMemoryEntries(cwd);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('g1');
    } finally {
      cleanup();
    }
  });

  it('respects the per-type limit', () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const memDir = join(cwd, '.agentforge', 'memory');
      mkdirSync(memDir, { recursive: true });
      const lines = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({
          id: `e${i}`,
          type: 'cycle-outcome',
          value: `outcome ${i}`,
          createdAt: `2026-04-0${(i % 9) + 1}T00:0${i % 10}:00.000Z`,
        } satisfies CycleMemoryEntry),
      ).join('\n');
      writeFileSync(join(memDir, 'cycle-outcome.jsonl'), lines + '\n');
      const entries = readRecentMemoryEntries(cwd, 5);
      expect(entries).toHaveLength(5);
    } finally {
      cleanup();
    }
  });
});

describe('formatMemoryForPrompt', () => {
  it('returns empty string for no entries', () => {
    expect(formatMemoryForPrompt([])).toBe('');
  });

  it('includes the section header when entries present', () => {
    const entry: CycleMemoryEntry = {
      id: 'x1',
      type: 'gate-verdict',
      value: 'REJECT: missing tests',
      createdAt: '2026-04-08T00:00:00.000Z',
      source: 'cycle-abc',
    };
    const output = formatMemoryForPrompt([entry]);
    expect(output).toContain('Past mistakes and learnings');
    expect(output).toContain('REJECT: missing tests');
    expect(output).toContain('cycle-abc');
  });

  it('groups entries by type with human-readable headings', () => {
    const entries: CycleMemoryEntry[] = [
      { id: 'a', type: 'review-finding', value: 'no error handling', createdAt: '2026-04-08T01:00:00Z' },
      { id: 'b', type: 'cycle-outcome', value: '$42 over budget', createdAt: '2026-04-08T02:00:00Z' },
    ];
    const output = formatMemoryForPrompt(entries);
    expect(output).toContain('Code review findings');
    expect(output).toContain('Cycle outcomes');
    expect(output).toContain('no error handling');
    expect(output).toContain('$42 over budget');
  });
});

describe('runAuditPhase memory injection', () => {
  it('injects memory section into agent prompt when entries exist', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const memDir = join(cwd, '.agentforge', 'memory');
      mkdirSync(memDir, { recursive: true });
      const entry: CycleMemoryEntry = {
        id: 'm1',
        type: 'review-finding',
        value: 'FileLockManager timeout causes silent deadlock',
        createdAt: '2026-04-08T00:00:00.000Z',
        source: 'cycle-prev',
      };
      writeFileSync(join(memDir, 'review-finding.jsonl'), JSON.stringify(entry) + '\n');

      const calls: Array<{ agentId: string; task: string }> = [];
      const runtime = {
        run: async (agentId: string, task: string, opts: any) => {
          calls.push({ agentId, task });
          return { output: '## Findings\n- found something', costUsd: 0.02 };
        },
      };
      const { bus } = makeMockBus();
      await runAuditPhase(makeCtx({ cwd, sprintVersion: '6.8.0', cycleId: 'mem-cycle', runtime, bus }));

      expect(calls).toHaveLength(1);
      expect(calls[0].task).toContain('Past mistakes and learnings');
      expect(calls[0].task).toContain('FileLockManager timeout causes silent deadlock');
    } finally {
      cleanup();
    }
  });

  it('prompt is unchanged (no memory block) when no entries exist', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      const calls: Array<{ task: string }> = [];
      const runtime = {
        run: async (_agentId: string, task: string) => {
          calls.push({ task });
          return { output: 'findings', costUsd: 0 };
        },
      };
      const { bus } = makeMockBus();
      await runAuditPhase(makeCtx({ cwd, sprintVersion: '6.8.0', cycleId: 'no-mem', runtime, bus }));
      expect(calls[0].task).not.toContain('Past mistakes');
    } finally {
      cleanup();
    }
  });
});

describe('runLearnPhase', () => {
  it('writes retrospective even if prior phases are partial', async () => {
    const { cwd, cleanup } = makeTmp();
    try {
      writeSprintFile(cwd, '6.5.2', []);
      const cycleId = 'l1';
      mkdirSync(join(cwd, '.agentforge/cycles', cycleId, 'phases'), { recursive: true });
      writeFileSync(
        join(cwd, '.agentforge/cycles', cycleId, 'phases/audit.json'),
        JSON.stringify({ status: 'completed', costUsd: 0.05, durationMs: 100 }),
      );
      const runtime = {
        run: async () => ({ output: '# Retro\n## Went well\n- xyz', costUsd: 0.07 }),
      };
      const { bus, published } = makeMockBus();
      const result = await runLearnPhase(
        makeCtx({ cwd, sprintVersion: '6.5.2', cycleId, runtime, bus }),
      );
      expect(result.status).toBe('completed');
      const j = JSON.parse(
        readFileSync(join(cwd, '.agentforge/cycles', cycleId, 'phases/learn.json'), 'utf8'),
      );
      expect(j.retrospective).toContain('Retro');
      expect(j.agentId).toBe('data-analyst');
      expect(published.filter((p) => p.topic === 'sprint.phase.started').length).toBe(1);
      expect(published.filter((p) => p.topic === 'sprint.phase.completed').length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
