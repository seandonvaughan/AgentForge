# Epic Decomposer — PR-2b1: Planner Agent + decomposeObjective Orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Author + register the `epic-planner` Opus agent, and build the `decomposeObjective()` orchestrator that turns an operator objective into a validated, wave-layered `EpicPlan` — invoke the planner, parse its JSON, run the pure `validateAndLayerEpicPlan` core (PR-2a), and on a cyclic / missing-predecessor / invalid-JSON result issue exactly one repair retry before failing. This is the reusable integration layer that PR-2b2 (DECOMPOSE phase) and a later preview command both call.

**Architecture:** The pure DAG/wave algorithms already exist in `packages/core/src/autonomous/decompose/` (PR-2a). This PR adds `decompose-objective.ts` (the impure LLM-driven orchestrator) beside them, plus the `epic-planner` agent definition in its four required places (`.agentforge/agents/*.yaml`, `.claude/agents/*.md`, `team.yaml`, `routing-index.json`) so `ctx.runtime.run('epic-planner', …)` resolves to an Opus runtime rather than silently falling back to a keyword-matched Sonnet agent.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — `.js` import suffixes), Zod, js-yaml, Vitest. Node **>=22.13.0** (`nvm use lts/jod`). pnpm via Corepack.

**Environment note for every command:** prefix with `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod >/dev/null 2>&1 &&`. Working dir `/Users/seandonvaughan/Projects/AgentForge`, branch `feat/epic-decomposer` (do NOT switch, do NOT push). `git add` new files immediately.

**Verification:** test `corepack pnpm exec vitest run <path>`; typecheck `corepack pnpm run check:types` (runs `tsc -b`; expect exit 0 — do NOT use `tsc -b --noEmit`, it has a pre-existing TS6310 error).

---

## File Structure

- New: `.agentforge/agents/epic-planner.yaml` — Opus agent definition (the load-bearing file; without it `runtime.run('epic-planner')` falls back to a wrong agent).
- New: `.claude/agents/epic-planner.md` — Claude Code agent frontmatter + body.
- Modify: `.agentforge/team.yaml` — add `epic-planner` to `agents.strategic`, `model_routing.opus`, `delegation_graph`.
- Modify: `.agentforge/routing-index.json` — add an `epic-planner` agent object (`tier: opus`).
- New: `packages/core/src/autonomous/decompose/decompose-objective.ts` — `buildEpicPlannerPrompt`, `buildRepairPrompt`, `extractEpicPlanJson`, `DecomposeError`, `decomposeObjective`.
- Modify: `packages/core/src/autonomous/decompose/index.ts` — re-export the new orchestrator surface.
- New tests: `__tests__/agent-registration.test.ts`, `__tests__/decompose-objective.test.ts`.

---

## Task 1: Author + register the `epic-planner` Opus agent

**Files:**
- Create: `.agentforge/agents/epic-planner.yaml`
- Create: `.claude/agents/epic-planner.md`
- Modify: `.agentforge/team.yaml`
- Modify: `.agentforge/routing-index.json`
- Test: `packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts`

- [ ] **Step 1: Write the failing test** (guards all four registration points)

Create `packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..'); // repo root from this test file

describe('epic-planner agent registration', () => {
  it('agent yaml exists, is Opus, strategic', () => {
    const y = load(readFileSync(join(ROOT, '.agentforge/agents/epic-planner.yaml'), 'utf8')) as any;
    expect(y.name).toBe('epic-planner');
    expect(y.model).toBe('opus');
    expect(y.team).toBe('strategic');
    expect(typeof y.system_prompt).toBe('string');
    expect(y.system_prompt.length).toBeGreaterThan(100);
  });

  it('claude agent md has opus frontmatter', () => {
    const md = readFileSync(join(ROOT, '.claude/agents/epic-planner.md'), 'utf8');
    expect(md).toMatch(/name:\s*epic-planner/);
    expect(md).toMatch(/model:\s*opus/);
  });

  it('team.yaml lists epic-planner under strategic + opus routing', () => {
    const t = load(readFileSync(join(ROOT, '.agentforge/team.yaml'), 'utf8')) as any;
    expect(t.agents.strategic).toContain('epic-planner');
    expect(t.model_routing.opus).toContain('epic-planner');
  });

  it('routing-index has an opus-tier epic-planner agent', () => {
    const idx = JSON.parse(readFileSync(join(ROOT, '.agentforge/routing-index.json'), 'utf8'));
    const agent = idx.agents.find((a: any) => a.id === 'epic-planner');
    expect(agent).toBeDefined();
    expect(agent.tier).toBe('opus');
  });
});
```

> If `__dirname` is unavailable under the test's module mode, resolve the repo root via `process.cwd()` instead (tests run from the repo root): replace `ROOT` with `process.cwd()`. Verify by running the test and adjusting if the path is wrong.

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts`

- [ ] **Step 3a: Create `.agentforge/agents/epic-planner.yaml`** (use `js-yaml`-safe block scalars; this is hand-authored, not generated)

```yaml
name: epic-planner
model: opus
version: '1.0'
description: epic-decomposition, dependency-dag, wave-scheduling, task-breakdown, campaign-planning
system_prompt: >
  You are the Epic Planner for AgentForge. You take a single high-level operator objective (an "epic")
  and decompose it into a dependency-ordered set of concrete child work items that the autonomous cycle
  executes in waves. Strategic Opus reasoning — invoked once per epic cycle.


  **Your sole output is a single JSON object** matching this exact shape (no prose, no markdown outside the
  JSON — a fenced ```json block is acceptable):


  {
    "epicId": "<the epic id you are given>",
    "rationale": "<2-4 sentences on how you split the work>",
    "children": [
      {
        "id": "child-1",
        "title": "<imperative, specific>",
        "description": "<what to build + acceptance criteria>",
        "files": ["packages/.../file.ts"],
        "capabilityTags": ["<specific, mutually-exclusive tags>"],
        "suggestedAssignee": "<a forged specialist agent id>",
        "estimatedCostUsd": 5,
        "estimatedComplexity": "low|medium|high",
        "predecessors": ["<child ids this depends on>"]
      }
    ]
  }


  **Hard rules:**

  - The predecessor graph MUST be acyclic. A child's `predecessors` may only reference ids of OTHER children
  in this same plan.

  - Wave 0 children have `predecessors: []`. A child that needs another child's code lists it as a predecessor.

  - Keep each child small enough to be one focused PR-sized change. Prefer more, smaller children over a few
  huge ones.

  - Declare every file a child will touch in `files` — this is how the scheduler prevents two children from
  racing on the same file. Two children that must edit the same file MUST be ordered (one a predecessor of
  the other).

  - Give each child SPECIFIC, mutually-exclusive `capabilityTags` (e.g. "fastify-route" vs "svelte-page"),
  never a generic "cheap" tag on security-sensitive work — tags drive provider routing.

  - `suggestedAssignee` should be a real forged specialist id when one fits the child's subsystem.


  **Iron law:** output ONLY the JSON object. Do not include explanation before or after it.
skills:
  - epic-decomposition
  - dependency-dag
  - wave-scheduling
  - task-breakdown
  - campaign-planning
triggers:
  file_patterns: []
  keywords:
    - epic-decomposition
    - dependency-dag
    - wave-scheduling
    - task-breakdown
    - campaign-planning
collaboration:
  reports_to: null
  reviews_from: []
  can_delegate_to: []
  parallel: true
context:
  max_files: 30
  auto_include:
    - package.json
    - tsconfig.json
    - .agentforge/routing-index.json
  project_specific:
    - packages
learnings:
  - >
    The predecessor graph must be acyclic and every predecessor id must reference another child in the same
    plan — a cycle or dangling id triggers a single repair retry, then the decompose phase fails.
  - >
    Two children that touch the same file must be explicitly ordered; the scheduler runs file-disjoint
    children of the same wave in parallel and a shared file would corrupt the worktree merge.
owns_subsystems:
  - packages/core/src/autonomous/decompose
capability_tags:
  - epic-decomposition
  - dependency-dag
  - wave-scheduling
  - task-breakdown
  - campaign-planning
team: strategic
effort: xhigh
```

- [ ] **Step 3b: Create `.claude/agents/epic-planner.md`**

```md
---
name: epic-planner
description: >
  epic-decomposition, dependency-dag, wave-scheduling, task-breakdown, campaign-planning
tools: Read,Grep,Glob
model: opus
---
You are the Epic Planner for AgentForge. You take a single high-level operator objective (an "epic") and decompose it into a dependency-ordered set of concrete child work items that the autonomous cycle executes in waves.

**Your sole output is a single JSON object** with this shape (a fenced ```json block is fine; no other prose):

`{ "epicId", "rationale", "children": [ { "id", "title", "description", "files": [], "capabilityTags": [], "suggestedAssignee", "estimatedCostUsd", "estimatedComplexity": "low|medium|high", "predecessors": [] } ] }`

**Hard rules:**
- The predecessor graph MUST be acyclic; `predecessors` may only reference other child ids in this plan.
- Wave 0 children have `predecessors: []`. A child needing another child's code lists it as a predecessor.
- Keep each child small (one focused PR). Prefer more, smaller children.
- Declare every file a child touches in `files`. Two children editing the same file MUST be ordered.
- Give each child specific, mutually-exclusive `capabilityTags` (tags drive provider routing).

**Iron law:** output ONLY the JSON object.
```

- [ ] **Step 3c: Edit `.agentforge/team.yaml`** — add `epic-planner` in three places:
  - under `agents.strategic:` add `    - epic-planner` (after `autonomy-strategist`)
  - under `model_routing.opus:` add `    - epic-planner` (after `autonomy-strategist`)
  - under `delegation_graph:` add an entry `  epic-planner: []` (mirrors the other strategic agents' shape; if their entries list agents, leave `epic-planner` as an empty list `[]`).

- [ ] **Step 3d: Edit `.agentforge/routing-index.json`** — add this object to the `agents` array (after the `autonomy-strategist` object; mind the trailing comma on the preceding `}`):

```json
    {
      "id": "epic-planner",
      "capability_tags": [
        "epic-decomposition",
        "dependency-dag",
        "wave-scheduling",
        "task-breakdown",
        "campaign-planning"
      ],
      "owns_subsystems": [
        "packages/core/src/autonomous/decompose"
      ],
      "tier": "opus",
      "priority": 16
    }
```

- [ ] **Step 4: Run, expect PASS** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts`. Also confirm the JSON is still valid: `node -e "JSON.parse(require('node:fs').readFileSync('.agentforge/routing-index.json','utf8')); console.log('routing-index ok')"`.

- [ ] **Step 5: Commit**

```bash
git add .agentforge/agents/epic-planner.yaml .claude/agents/epic-planner.md .agentforge/team.yaml .agentforge/routing-index.json packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts
git commit -m "feat(decompose): author + register epic-planner Opus agent (PR-2b1)"
```

---

## Task 2: `decomposeObjective` orchestrator (prompt + parse + validate + repair retry)

**Files:**
- Create: `packages/core/src/autonomous/decompose/decompose-objective.ts`
- Modify: `packages/core/src/autonomous/decompose/index.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/decompose-objective.test.ts`

- [ ] **Step 1: Write the failing test** (mock runtime — no real LLM)

```ts
import { describe, it, expect } from 'vitest';
import { decomposeObjective, extractEpicPlanJson, DecomposeError } from '../decompose-objective.js';
import type { EpicObjective } from '../types.js';

const objective: EpicObjective = {
  id: 'epic-abc12345', title: 'RBAC', description: 'Add multi-tenant RBAC', createdAt: '2026-05-30T00:00:00.000Z',
};

function planJson(children: unknown): string {
  return JSON.stringify({ epicId: 'epic-abc12345', rationale: 'r', children });
}
const goodChildren = [
  { id: 'c1', title: 'type', description: 'd', files: ['shared.ts'], capabilityTags: ['types'],
    suggestedAssignee: 'eng', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [] },
  { id: 'c2', title: 'api', description: 'd', files: ['api.ts'], capabilityTags: ['route'],
    suggestedAssignee: 'eng', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'] },
];
const cyclicChildren = [
  { id: 'c1', title: 'a', description: 'd', files: ['a.ts'], capabilityTags: ['x'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c2'] },
  { id: 'c2', title: 'b', description: 'd', files: ['b.ts'], capabilityTags: ['y'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c1'] },
];

function mockRuntime(outputs: string[]) {
  let i = 0;
  return { run: async () => ({ output: outputs[i++]!, costUsd: 0.5, model: 'opus' }) };
}

describe('extractEpicPlanJson', () => {
  it('parses a raw JSON object', () => {
    expect((extractEpicPlanJson('{"epicId":"e","rationale":"r","children":[]}') as any).epicId).toBe('e');
  });
  it('parses a ```json fenced block with surrounding prose', () => {
    const out = 'Here is the plan:\n```json\n{"epicId":"e","rationale":"r","children":[]}\n```\nDone.';
    expect((extractEpicPlanJson(out) as any).epicId).toBe('e');
  });
});

describe('decomposeObjective', () => {
  it('returns a layered plan on a valid first response', async () => {
    const r = await decomposeObjective(objective, mockRuntime([planJson(goodChildren)]));
    expect(r.repaired).toBe(false);
    expect(r.plan.children.find((c) => c.id === 'c2')!.wave).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.5);
  });

  it('repairs once when the first response is cyclic', async () => {
    const r = await decomposeObjective(objective, mockRuntime([planJson(cyclicChildren), planJson(goodChildren)]));
    expect(r.repaired).toBe(true);
    expect(r.plan.children).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(1.0); // two runs
  });

  it('throws DecomposeError when still invalid after the repair retry', async () => {
    await expect(
      decomposeObjective(objective, mockRuntime([planJson(cyclicChildren), planJson(cyclicChildren)])),
    ).rejects.toBeInstanceOf(DecomposeError);
  });

  it('throws DecomposeError when output is not parseable JSON even after repair', async () => {
    await expect(
      decomposeObjective(objective, mockRuntime(['not json', 'still not json'])),
    ).rejects.toBeInstanceOf(DecomposeError);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/decompose-objective.test.ts`

- [ ] **Step 3: Create `decompose-objective.ts`**

```ts
// packages/core/src/autonomous/decompose/decompose-objective.ts
//
// Impure orchestrator: invoke the epic-planner agent, parse its EpicPlan JSON,
// run the pure validate+layer core, and on a cyclic / missing-predecessor /
// invalid-JSON result issue exactly one repair retry before failing.
// (spec 2026-05-30 §6.3 + §9.2 fail-loud-not-silent)

import { EpicPlanSchema, type EpicObjective, type EpicPlan } from './types.js';
import { validateAndLayerEpicPlan } from './validate-and-layer.js';
import type { ValidationReport } from './types.js';

export const EPIC_PLANNER_AGENT_ID = 'epic-planner';

/** Minimal runtime contract this orchestrator needs (satisfied by RuntimeAdapter). */
export interface DecomposeRuntime {
  run(
    agentId: string,
    task: string,
    options?: { allowedTools?: string[] },
  ): Promise<{ output: string; costUsd?: number; model?: string }>;
}

export interface DecomposeResult {
  plan: EpicPlan; // children carry computed `wave`
  report: ValidationReport;
  costUsd: number;
  repaired: boolean;
}

export class DecomposeError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid-json' | 'cycle' | 'missing-predecessors' | 'unknown',
    readonly report?: ValidationReport,
  ) {
    super(message);
    this.name = 'DecomposeError';
  }
}

export function buildEpicPlannerPrompt(objective: EpicObjective): string {
  const constraints = objective.constraints?.length
    ? `\n\nConstraints:\n${objective.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';
  return [
    `Decompose this objective into a dependency-ordered EpicPlan.`,
    ``,
    `epicId: ${objective.id}`,
    `Title: ${objective.title}`,
    `Objective: ${objective.description}${constraints}`,
    ``,
    `Output ONLY the JSON object described in your system prompt (a fenced json block is acceptable).`,
    `Use epicId "${objective.id}" exactly. The predecessor graph must be acyclic and every`,
    `predecessor must reference another child id in this plan.`,
  ].join('\n');
}

export function buildRepairPrompt(
  objective: EpicObjective,
  previousOutput: string,
  reason: DecomposeError['reason'],
  report?: ValidationReport,
): string {
  const detail =
    reason === 'cycle'
      ? `Your previous plan had a dependency CYCLE involving: ${report?.cycle?.join(', ') ?? 'unknown'}. Break the cycle.`
      : reason === 'missing-predecessors'
        ? `Your previous plan referenced predecessor ids that do not exist: ${JSON.stringify(report?.missingPredecessors ?? [])}. Use only ids of children present in the plan.`
        : `Your previous output was not a valid EpicPlan JSON object.`;
  return [
    `Your previous decomposition was invalid. ${detail}`,
    ``,
    `Re-output a corrected EpicPlan JSON object for epicId "${objective.id}".`,
    `Output ONLY the JSON object.`,
    ``,
    `--- your previous output (for reference) ---`,
    previousOutput.slice(0, 4000),
  ].join('\n');
}

/** Pull a JSON object out of an LLM response: strips ```json fences, else first {...last }. */
export function extractEpicPlanJson(output: string): unknown {
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]! : output;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new DecomposeError('no JSON object found in epic-planner output', 'invalid-json');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new DecomposeError('epic-planner output is not valid JSON', 'invalid-json');
  }
}

interface AttemptResult {
  ok: boolean;
  plan?: EpicPlan;
  report?: ValidationReport;
  reason: DecomposeError['reason'];
}

function attempt(output: string): AttemptResult {
  let raw: unknown;
  try {
    raw = extractEpicPlanJson(output);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = EpicPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-json' };
  const v = validateAndLayerEpicPlan(parsed.data);
  if (v.ok) return { ok: true, plan: v.plan, report: v.report, reason: 'unknown' };
  return { ok: false, reason: v.reason, report: v.report };
}

export async function decomposeObjective(
  objective: EpicObjective,
  runtime: DecomposeRuntime,
): Promise<DecomposeResult> {
  const r1 = await runtime.run(EPIC_PLANNER_AGENT_ID, buildEpicPlannerPrompt(objective), { allowedTools: [] });
  let costUsd = r1.costUsd ?? 0;
  const a1 = attempt(r1.output);
  if (a1.ok) {
    return { plan: a1.plan!, report: a1.report!, costUsd, repaired: false };
  }

  // One repair retry.
  const r2 = await runtime.run(
    EPIC_PLANNER_AGENT_ID,
    buildRepairPrompt(objective, r1.output, a1.reason, a1.report),
    { allowedTools: [] },
  );
  costUsd += r2.costUsd ?? 0;
  const a2 = attempt(r2.output);
  if (a2.ok) {
    return { plan: a2.plan!, report: a2.report!, costUsd, repaired: true };
  }
  throw new DecomposeError(
    `epic-planner produced an invalid decomposition after one repair retry (reason: ${a2.reason})`,
    a2.reason,
    a2.report,
  );
}
```

- [ ] **Step 4: Re-export from the barrel** — append to `packages/core/src/autonomous/decompose/index.ts`:

```ts
export {
  decomposeObjective,
  buildEpicPlannerPrompt,
  buildRepairPrompt,
  extractEpicPlanJson,
  DecomposeError,
  EPIC_PLANNER_AGENT_ID,
} from './decompose-objective.js';
export type { DecomposeRuntime, DecomposeResult } from './decompose-objective.js';
```

- [ ] **Step 5: Run, expect PASS + typecheck**

`corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/decompose-objective.test.ts`
`corepack pnpm run check:types`  (exit 0)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/decompose/decompose-objective.ts packages/core/src/autonomous/decompose/index.ts packages/core/src/autonomous/decompose/__tests__/decompose-objective.test.ts
git commit -m "feat(decompose): decomposeObjective orchestrator with one repair retry (PR-2b1)"
```

---

## Task 3: Verification gate

- [ ] **Step 1:** `corepack pnpm run check:types` → exit 0.
- [ ] **Step 2:** `corepack pnpm exec vitest run packages/core/src/autonomous/decompose` → all pass (PR-2a tests + the two new files).
- [ ] **Step 3:** Confirm the agent is loadable end-to-end (no fallback): `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/agent-registration.test.ts` green; and `node -e "JSON.parse(require('node:fs').readFileSync('.agentforge/routing-index.json','utf8'))"` exits 0 (valid JSON after the hand edit).

---

## Self-Review

**Spec coverage:** epic-planner agent authored + registered in all four places (§6, agent registration checklist) ✓; `decomposeObjective` = planner invoke + parse + `validateAndLayerEpicPlan` + one repair retry + fail-loud (§6.3 + the "no silent fallback" intent) ✓. **Deferred to PR-2b2:** the DECOMPOSE *phase* handler, `--objective` flag, `objective.json`, `PhaseContext.objective`, `plan.json` flatten, phase-sequence insertion. **Deferred (noted):** import-edge augmentation §6.3.4 (impure, best-effort; an enhancement to the deterministic safety net — slot it into `decomposeObjective` before `validateAndLayerEpicPlan` in a later micro-PR); `cycle preview --objective` (needs runtime construction in the preview action).

**Placeholder scan:** none — complete code in every step. The one conditional instruction (test `ROOT` resolution) is a verify-and-adjust guard, not a placeholder.

**Type consistency:** `EpicObjective`/`EpicPlan`/`ValidationReport` reused from `types.js`; `validateAndLayerEpicPlan` consumed as defined in PR-2a; `DecomposeRuntime.run` return shape (`{output, costUsd?, model?}`) is a structural subset of the real `RuntimeAdapter.run` return (§3.5), so the adapter satisfies it. `DecomposeError.reason` union matches `validateAndLayerEpicPlan`'s `reason` plus `'invalid-json'`/`'unknown'`.

**Failure-loud check:** the orchestrator never returns a partial/invalid plan — it either returns a fully-layered plan or throws `DecomposeError`. This is the guard against the runtime-adapter's silent keyword fallback producing a wrong decomposition.

---

## Deferred to PR-2b2 (DECOMPOSE phase wiring)

`runDecomposePhase` (calls `decomposeObjective`, writes `decomposition.json` atomically, flattens children into `plan.json` with `parentEpicId`/`wave`/`predecessors` + zeroed failure counters + `capabilityTags`→`tags`); add `objective?: string` to `PhaseContext` + `CycleRunnerOptions` + scheduler population; `--objective` on `cycle run`; persist `objective.json`; insert `'decompose'` into `PhaseName` + core & server `PHASE_SEQUENCE` + `PHASE_HANDLERS` (+ `PHASE_AGENT_MAP`). Grounding: `/tmp/pr2-pack.md` §1, §2, §6.
