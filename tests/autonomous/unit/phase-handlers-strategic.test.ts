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
  inferAssigneeFromTag,
  inferAssignee,
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
