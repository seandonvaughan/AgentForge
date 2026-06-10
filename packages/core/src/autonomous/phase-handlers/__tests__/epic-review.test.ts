// P0.6 — epic-review tests. The epic review replaces the legacy CEO gate on the
// objective/epic path with ONE strong-model structured review + a selective
// fix-up loop. The cardinal rule under test: the parse chain NEVER auto-REJECTs
// on a parse failure (TRIAGE → APPROVE-equivalent for release; deterministic
// VERIFY is the authority).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import {
  runEpicReview,
  salvageEpicReview,
  EPIC_REVIEW_SCHEMA,
} from '../epic-review.js';
import { runGatePhase, GateRejectedError } from '../gate-phase.js';
import { readMemoryEntries, type GateVerdictMetadata } from '../../../memory/types.js';
import { loadKnowledgeEntities } from '../../../knowledge/persistence.js';

let tmpRoot: string;
let cycleId: string;

function phasesDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId, 'phases');
}

function writePlan(items: Array<{ id: string; title: string; files?: string[]; estimatedCostUsd?: number }>): void {
  const dir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({
      version: '1.0.0',
      sprintId: 'sprint-1',
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        description: `do ${i.title}`,
        files: i.files ?? [],
        status: 'completed',
        ...(i.estimatedCostUsd !== undefined ? { estimatedCostUsd: i.estimatedCostUsd } : {}),
      })),
    }),
  );
}

function writeExecute(): void {
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(
    join(phasesDir(), 'execute.json'),
    JSON.stringify({
      phase: 'execute',
      status: 'completed',
      costUsd: 1.0,
      epicIntegration: { branch: 'codex/epic-abc', epicId: 'epic-abc' },
      itemResults: [],
    }),
  );
}

interface StubCall {
  agentId: string;
  task: string;
  opts: any;
}

function makeCtx(runImpl: (call: StubCall) => any): {
  ctx: PhaseContext;
  calls: StubCall[];
  events: Array<{ topic: string; payload: any }>;
} {
  const calls: StubCall[] = [];
  const events: Array<{ topic: string; payload: any }> = [];
  const ctx = {
    sprintId: 'sprint-1',
    sprintVersion: '1.0.0',
    projectRoot: tmpRoot,
    adapter: {},
    bus: {
      publish: (topic: string, payload: any) => {
        events.push({ topic, payload });
      },
      subscribe: () => () => {},
    },
    runtime: {
      run: async (agentId: string, task: string, opts: any) => {
        const call: StubCall = { agentId, task, opts };
        calls.push(call);
        return runImpl(call);
      },
    },
    cycleId,
    baseBranch: 'main',
    objective: 'Build the widget feature end to end',
  } as unknown as PhaseContext;
  return { ctx, calls, events };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-epic-review-'));
  cycleId = '11111111-1111-1111-1111-111111111111';
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runEpicReview — APPROVE via schemaValidation.ok', () => {
  it('returns a completed result and writes epic-review.json + gate.json', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const { ctx, calls } = makeCtx(() => ({
      output: JSON.stringify({ verdict: 'APPROVE', rationale: 'all good', faultedItems: [] }),
      costUsd: 0.5,
      schemaValidation: { ok: true },
    }));

    const result = await runEpicReview(ctx);
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0.5);
    // Exactly one runtime call — no triage re-ask needed.
    expect(calls).toHaveLength(1);

    const epicReview = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(epicReview.mode).toBe('epic-review');
    expect(epicReview.verdict).toBe('APPROVE');
    expect(epicReview.schemaValidationOk).toBe(true);
    expect(epicReview.triageUsed).toBe(false);
    expect(epicReview.faultedItems).toEqual([]);

    const gate = JSON.parse(readFileSync(join(phasesDir(), 'gate.json'), 'utf8'));
    expect(gate.verdict).toBe('APPROVE');

    // Memory entry written as 'approved'.
    const mem = readMemoryEntries(tmpRoot, 'gate-verdict', 1);
    expect((mem[0]!.metadata as GateVerdictMetadata).verdict).toBe('approved');
  });

  it('passes the outputSchema and fable capabilityTier to runtime.run', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();
    const { ctx, calls } = makeCtx(() => ({
      output: '{"verdict":"APPROVE","rationale":"ok","faultedItems":[]}',
      costUsd: 0.1,
      schemaValidation: { ok: true },
    }));
    await runEpicReview(ctx);
    expect(calls[0]!.opts.outputSchema).toBe(EPIC_REVIEW_SCHEMA);
    expect(calls[0]!.opts.capabilityTier).toBe('fable');
    expect(calls[0]!.opts.codexSandbox).toBe('read-only');
  });

  it('prefers the SDK transport for structured output (cycle 5242ca92)', async () => {
    // Two production reviews came back unparseable on the CLI transport
    // (schemaValidationOk:false — the CLI can only append the schema text to
    // the system prompt). The SDK transport enforces+validates+retries
    // structured output, so it must lead the failover chain; the CLI remains
    // the fallback when no ANTHROPIC_API_KEY is configured.
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();
    const { ctx, calls } = makeCtx(() => ({
      output: '{"verdict":"APPROVE","rationale":"ok","faultedItems":[]}',
      costUsd: 0.1,
      schemaValidation: { ok: true },
    }));
    await runEpicReview(ctx);
    expect(calls[0]!.opts.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
  });
});

describe('runEpicReview — REQUEST_CHANGES with valid itemIds', () => {
  it('writes artifacts THEN throws GateRejectedError, faultedItems filtered to plan ids', async () => {
    writePlan([
      { id: 'i1', title: 'item one', files: ['src/a.ts'] },
      { id: 'i2', title: 'item two' },
    ]);
    writeExecute();

    const { ctx } = makeCtx(() => ({
      output: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        rationale: 'i1 is broken; ghost is not in plan',
        faultedItems: [
          { itemId: 'i1', reason: 'missing handler', files: ['src/a.ts'] },
          { itemId: 'ghost', reason: 'unknown id should be dropped', files: ['x.ts'] },
        ],
      }),
      costUsd: 0.7,
      schemaValidation: { ok: true },
    }));

    await expect(runEpicReview(ctx)).rejects.toBeInstanceOf(GateRejectedError);

    // Artifacts written BEFORE the throw.
    const epicReview = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(epicReview.verdict).toBe('REQUEST_CHANGES');
    // Unknown 'ghost' id filtered out — only the real plan id remains.
    expect(epicReview.faultedItems.map((f: any) => f.itemId)).toEqual(['i1']);

    // Legacy gate.json records REJECT so the dashboard still works.
    const gate = JSON.parse(readFileSync(join(phasesDir(), 'gate.json'), 'utf8'));
    expect(gate.verdict).toBe('REJECT');

    const mem = readMemoryEntries(tmpRoot, 'gate-verdict', 1);
    expect((mem[0]!.metadata as GateVerdictMetadata).verdict).toBe('rejected');
  });
});

describe('runEpicReview — REQUEST_CHANGES with ALL unknown itemIds → TRIAGE', () => {
  it('does NOT throw; an unactionable rejection cannot loop', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const { ctx } = makeCtx(() => ({
      output: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        rationale: 'something somewhere',
        faultedItems: [{ itemId: 'nope', reason: 'unknown', files: [] }],
      }),
      costUsd: 0.3,
      schemaValidation: { ok: true },
    }));

    // No throw — unactionable rejection degrades to TRIAGE (completed).
    const result = await runEpicReview(ctx);
    expect(result.status).toBe('completed');

    const epicReview = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(epicReview.verdict).toBe('TRIAGE');
    expect(epicReview.faultedItems).toEqual([]);
    expect(epicReview.rationale).toContain('[TRIAGE');

    // gate.json records APPROVE (release proceeds; VERIFY is authority).
    const gate = JSON.parse(readFileSync(join(phasesDir(), 'gate.json'), 'utf8'));
    expect(gate.verdict).toBe('APPROVE');

    const mem = readMemoryEntries(tmpRoot, 'gate-verdict', 1);
    expect((mem[0]!.metadata as GateVerdictMetadata).verdict).toBe('pending');
  });
});

describe('runEpicReview — unparseable output → triage re-ask → still unparseable → TRIAGE', () => {
  it('invokes exactly one triage re-ask and never REJECTs', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const { ctx, calls } = makeCtx((call) => {
      // First call: prose, no JSON, schema not validated.
      // Triage re-ask: still prose.
      void call;
      return {
        output: 'I think it looks fine but here is some prose without any JSON object.',
        costUsd: 0.2,
        schemaValidation: { ok: false, error: 'no json' },
      };
    });

    const result = await runEpicReview(ctx);
    expect(result.status).toBe('completed');
    // Two calls total: primary + ONE triage re-ask.
    expect(calls).toHaveLength(2);
    // The triage re-ask uses the sonnet tier.
    expect(calls[1]!.opts.capabilityTier).toBe('sonnet');
    // Cycle 5242ca92 — BOTH calls lead with the SDK transport so structured
    // output is enforced/validated/retried whenever an API key is configured.
    expect(calls[0]!.opts.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
    expect(calls[1]!.opts.providerPreference).toEqual(['anthropic-sdk', 'claude-code-compat']);

    const epicReview = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(epicReview.verdict).toBe('TRIAGE');
    expect(epicReview.triageUsed).toBe(true);
    expect(epicReview.schemaValidationOk).toBe(false);
  });
});

describe('runEpicReview — salvage path (fenced block, no triage)', () => {
  it('parses a verdict object inside a ```json fence without a triage re-ask', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const fenced = [
      '★ Insight ─────────',
      'Here is my structured verdict:',
      '```json',
      '{ "verdict": "APPROVE", "rationale": "salvaged from fence", "faultedItems": [] }',
      '```',
    ].join('\n');

    const { ctx, calls } = makeCtx(() => ({
      output: fenced,
      costUsd: 0.4,
      // schemaValidation absent/false — the salvage chain must still parse it.
      schemaValidation: { ok: false },
    }));

    const result = await runEpicReview(ctx);
    expect(result.status).toBe('completed');
    // Salvaged without any triage re-ask → exactly one call.
    expect(calls).toHaveLength(1);

    const epicReview = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(epicReview.verdict).toBe('APPROVE');
    expect(epicReview.rationale).toContain('salvaged from fence');
    expect(epicReview.triageUsed).toBe(false);
  });
});

describe('runEpicReview — knowledge note (v25: the epic path feeds the KB)', () => {
  it('APPROVE persists the rationale as a note with source epic-review and tags [cycleId, verdict]', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const { ctx } = makeCtx(() => ({
      output: JSON.stringify({
        verdict: 'APPROVE',
        rationale: 'All children satisfy the operator objective end to end.',
        faultedItems: [],
      }),
      costUsd: 0.5,
      schemaValidation: { ok: true },
    }));

    await runEpicReview(ctx);

    const notes = loadKnowledgeEntities(tmpRoot).filter(
      (e) => e.properties.source === 'epic-review',
    );
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.properties.kind).toBe('note');
    expect(note.description).toContain('operator objective');
    expect(note.properties.tags).toEqual([cycleId, 'APPROVE']);
    expect(note.properties.cycleId).toBe(cycleId);
  });

  it('REQUEST_CHANGES persists the note BEFORE the GateRejectedError throw', async () => {
    writePlan([{ id: 'i1', title: 'item one', files: ['src/a.ts'] }]);
    writeExecute();

    const { ctx } = makeCtx(() => ({
      output: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        rationale: 'Item one is missing the required handler implementation.',
        faultedItems: [{ itemId: 'i1', reason: 'missing handler', files: ['src/a.ts'] }],
      }),
      costUsd: 0.7,
      schemaValidation: { ok: true },
    }));

    await expect(runEpicReview(ctx)).rejects.toBeInstanceOf(GateRejectedError);

    const notes = loadKnowledgeEntities(tmpRoot).filter(
      (e) => e.properties.source === 'epic-review',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.properties.tags).toEqual([cycleId, 'REQUEST_CHANGES']);
    expect(notes[0]!.description).toContain('missing the required handler');
  });

  it('TRIAGE rationale is persisted with the TRIAGE verdict tag', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();

    const { ctx } = makeCtx(() => ({
      output: 'prose only — nothing parseable in this reviewer output at all',
      costUsd: 0.2,
      schemaValidation: { ok: false },
    }));

    const result = await runEpicReview(ctx);
    expect(result.status).toBe('completed');

    const notes = loadKnowledgeEntities(tmpRoot).filter(
      (e) => e.properties.source === 'epic-review',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.properties.tags).toEqual([cycleId, 'TRIAGE']);
  });
});

describe('salvageEpicReview — unit', () => {
  it('parses strict JSON', () => {
    const v = salvageEpicReview('{"verdict":"APPROVE","rationale":"r","faultedItems":[]}');
    expect(v?.verdict).toBe('APPROVE');
  });
  it('returns null for prose with no JSON', () => {
    expect(salvageEpicReview('just prose, no object')).toBeNull();
  });
  it('normalizes faultedItems and drops malformed entries', () => {
    const v = salvageEpicReview(
      '{"verdict":"REQUEST_CHANGES","rationale":"r","faultedItems":[{"itemId":"i1","reason":"x","files":["a"]},{"reason":"no id"}]}',
    );
    expect(v?.faultedItems).toHaveLength(1);
    expect(v?.faultedItems[0]!.itemId).toBe('i1');
  });
});

describe('runGatePhase delegation', () => {
  it('delegates to runEpicReview when ctx.objective is set', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();
    const { ctx } = makeCtx(() => ({
      output: '{"verdict":"APPROVE","rationale":"ok","faultedItems":[]}',
      costUsd: 0.1,
      schemaValidation: { ok: true },
    }));
    const result = await runGatePhase(ctx);
    expect(result.status).toBe('completed');
    // The epic-review artifact is the proof the epic path ran.
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(true);
  });

  it('runs the LEGACY gate (no epic-review.json) when objective is absent', async () => {
    writePlan([{ id: 'i1', title: 'item one' }]);
    writeExecute();
    const { ctx } = makeCtx(() => ({
      output: '{"verdict":"APPROVE","rationale":"legacy approve"}',
      costUsd: 0.1,
    }));
    // Strip objective to exercise the legacy path.
    (ctx as any).objective = undefined;
    const result = await runGatePhase(ctx);
    expect(result.status).toBe('completed');
    // Legacy path writes gate.json but NOT epic-review.json.
    expect(existsSync(join(phasesDir(), 'gate.json'))).toBe(true);
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(false);
  });
});
