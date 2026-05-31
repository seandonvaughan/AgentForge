# Epic Decomposer — PR-2c2: Integration Branch (waves build on predecessor code)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make wave N+1 fork off wave N's *merged code*, not just correct timing. For an epic cycle, maintain a **local integration branch** `codex/epic-<id>`: wave worktrees fork off it (via `sourceRef`), and after each wave's barrier the completed children's branches are merged into it. PR-2c1 already gives wave ordering; this gives wave **continuity**.

**Architecture + the key decision (local, not origin):** The worktree pool forks a child off `sourceRef` (default `origin/<baseBranch>`). The naive epic design would use `origin/codex/epic-<id>`, but that requires the branch to exist on a remote — which local runs and tests lack, and which would make the whole feature untestable without a live origin. Instead we use a **local** ref: create `codex/epic-<id>` as a local branch, fork wave worktrees off the **local** branch name (`sourceRef: 'codex/epic-<id>'`), and merge child branches into it in a **dedicated integration worktree** between waves. No remote needed for the wave mechanics; pushing happens only at release (PR-2d). The integration worktree holds `codex/epic-<id>` checked out; child worktrees are on their own `codex/<child-id>` branches — no checkout conflict. Merges run only at the barrier, when all of the wave's child worktrees have settled and released.

**The no-op-for-flat invariant (unchanged from PR-2c1):** all of this is gated on the cycle being an epic — detected by `items.some(it => it.parentEpicId)`. Signal cycles have no `parentEpicId`, so no integration branch is created, `sourceRef` is not overridden (children fork off `origin/main` as today), and no merges run. Flat behavior is byte-for-byte preserved.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — `.js` suffixes), `node:child_process` `execFile` for git, Vitest with real local git repos (`initGitRepo` pattern from `execute-phase-worktree.test.ts`). Node **>=22.13.0** (`nvm use lts/jod`).

**Environment note:** prefix every command with `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod >/dev/null 2>&1 &&`. Working dir `/Users/seandonvaughan/Projects/AgentForge`, branch `feat/epic-decomposer` (do NOT switch, do NOT push). Read before Edit; `git add` new files immediately.

**Verification:** test `corepack pnpm exec vitest run <path>`; typecheck `corepack pnpm run check:types` (`tsc -b`; exit 0 — never `tsc -b --noEmit`).

---

## File Structure

- New: `packages/core/src/autonomous/phase-handlers/wave-integration.ts` — all git orchestration for the integration branch: `epicIntegrationBranchName`, `ensureIntegrationWorktree`, `mergeBranchesIntoIntegration`. Isolated so the git logic is testable on its own and `execute-phase.ts` only calls three well-named functions.
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts` — detect epic cycle; ensure integration worktree before wave 0; pass `sourceRef` for epic items; collect completed child branches per wave; merge after each barrier; clean up the integration worktree at the end.
- New tests: `wave-integration.test.ts` (real local git), and an extension of the wave test for sourceRef wiring.

---

## Task 1: `wave-integration.ts` git orchestration module

**Files:**
- Create: `packages/core/src/autonomous/phase-handlers/wave-integration.ts`
- Test: `packages/core/src/autonomous/phase-handlers/__tests__/wave-integration.test.ts`

- [ ] **Step 1: Write the failing test** (real local git repo — no remote)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  epicIntegrationBranchName,
  ensureIntegrationWorktree,
  mergeBranchesIntoIntegration,
} from '../wave-integration.js';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-waveint-'));
  g(root, ['init', '-q', '-b', 'main']);
  g(root, ['config', 'user.email', 't@t.t']);
  g(root, ['config', 'user.name', 'T']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g(root, ['add', '.']); g(root, ['commit', '-q', '-m', 'base']);
  return root;
}

/** Create a child branch off main that adds one disjoint file, mimicking commitAgentWork. */
function makeChildBranch(root: string, branch: string, file: string): void {
  g(root, ['branch', branch, 'main']);
  const wt = join(root, `.wt-${branch.replace(/\//g, '-')}`);
  g(root, ['worktree', 'add', '-q', wt, branch]);
  writeFileSync(join(wt, file), `content of ${file}\n`);
  g(wt, ['add', '.']); g(wt, ['commit', '-q', '-m', `add ${file}`]);
  g(root, ['worktree', 'remove', '--force', wt]);
}

describe('epicIntegrationBranchName', () => {
  it('derives a safe local branch name', () => {
    expect(epicIntegrationBranchName('epic-abc12345')).toBe('codex/epic-abc12345');
  });
  it('strips unsafe chars', () => {
    expect(epicIntegrationBranchName('epic-../x')).toBe('codex/epic-..x'.replace('..', '')); // no slashes/dots
  });
});

describe('ensureIntegrationWorktree', () => {
  it('creates the local branch off baseBranch + a worktree checked out on it', async () => {
    const root = initRepo();
    const branch = 'codex/epic-test1';
    const wt = await ensureIntegrationWorktree(root, branch, 'main');
    expect(existsSync(wt)).toBe(true);
    expect(g(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(branch);
    // idempotent: a second call returns the same path without error
    const wt2 = await ensureIntegrationWorktree(root, branch, 'main');
    expect(wt2).toBe(wt);
  });
});

describe('mergeBranchesIntoIntegration', () => {
  it('merges disjoint child branches into the integration branch', async () => {
    const root = initRepo();
    makeChildBranch(root, 'codex/c1', 'a.ts');
    makeChildBranch(root, 'codex/c2', 'b.ts');
    const branch = 'codex/epic-test2';
    const wt = await ensureIntegrationWorktree(root, branch, 'main');
    const result = await mergeBranchesIntoIntegration(wt, ['codex/c1', 'codex/c2']);
    expect(result.merged.sort()).toEqual(['codex/c1', 'codex/c2']);
    expect(result.conflicted).toEqual([]);
    expect(existsSync(join(wt, 'a.ts'))).toBe(true);
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
  });

  it('reports a conflicted branch without aborting the others', async () => {
    const root = initRepo();
    // Two branches that both modify base.txt → conflict on the second merge.
    g(root, ['branch', 'codex/x1', 'main']);
    g(root, ['branch', 'codex/x2', 'main']);
    for (const [b, txt] of [['codex/x1', 'x1\n'], ['codex/x2', 'x2\n']] as const) {
      const wt = join(root, `.wt-${b.replace(/\//g, '-')}`);
      g(root, ['worktree', 'add', '-q', wt, b]);
      writeFileSync(join(wt, 'base.txt'), txt);
      g(wt, ['add', '.']); g(wt, ['commit', '-q', '-m', b]);
      g(root, ['worktree', 'remove', '--force', wt]);
    }
    const wt = await ensureIntegrationWorktree(root, 'codex/epic-test3', 'main');
    const result = await mergeBranchesIntoIntegration(wt, ['codex/x1', 'codex/x2']);
    expect(result.merged).toEqual(['codex/x1']);
    expect(result.conflicted).toEqual(['codex/x2']);
    // working tree is clean after the aborted conflicting merge
    expect(g(wt, ['status', '--porcelain']).trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/wave-integration.test.ts`

- [ ] **Step 3: Create `wave-integration.ts`**

```ts
// packages/core/src/autonomous/phase-handlers/wave-integration.ts
//
// Local integration-branch orchestration for epic wave execution (spec §8.2).
// A dedicated worktree holds codex/epic-<id> checked out; completed child
// branches are merged into it between waves so wave N+1 forks off wave N's
// code. Local-only (no remote required) — pushing happens at release (PR-2d).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.toString();
}

/** Best-effort git that never throws (for cleanup / probe paths). */
async function gitSafe(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args) };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** Derive the local integration branch name from an epic id. Slashes/dots stripped. */
export function epicIntegrationBranchName(parentEpicId: string): string {
  const safe = parentEpicId.replace(/[^a-zA-Z0-9-]/g, '');
  return `codex/${safe}`;
}

function integrationWorktreePath(projectRoot: string, branch: string): string {
  return join(projectRoot, '.agentforge', 'worktrees', `int-${branch.replace(/[\\/]/g, '-')}`);
}

/**
 * Ensure a local branch `branch` exists (created off `baseBranch` if absent) and
 * is checked out in a dedicated worktree. Idempotent — returns the worktree path.
 */
export async function ensureIntegrationWorktree(
  projectRoot: string,
  branch: string,
  baseBranch: string,
): Promise<string> {
  const wtPath = integrationWorktreePath(projectRoot, branch);
  if (existsSync(wtPath)) {
    // Reuse if it is the right branch; otherwise treat as fresh.
    const cur = await gitSafe(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.ok && cur.out.trim() === branch) return wtPath;
  }
  mkdirSync(join(projectRoot, '.agentforge', 'worktrees'), { recursive: true });

  const branchExists = (await gitSafe(projectRoot, ['branch', '--list', branch])).out.trim().length > 0;
  if (!branchExists) {
    await git(projectRoot, ['branch', branch, baseBranch]);
  }
  await git(projectRoot, ['worktree', 'add', '--force', wtPath, branch]);
  return wtPath;
}

/**
 * Merge each branch in `childBranches` into the integration branch checked out
 * at `intWorktreePath`, in order. A conflicting merge is aborted (leaving the
 * working tree clean) and recorded in `conflicted`; remaining branches still
 * merge. Uses --no-ff so each child is a distinct merge commit.
 */
export async function mergeBranchesIntoIntegration(
  intWorktreePath: string,
  childBranches: string[],
): Promise<{ merged: string[]; conflicted: string[] }> {
  const merged: string[] = [];
  const conflicted: string[] = [];
  // Merge commits need an identity; set a local one in case the worktree lacks it.
  await gitSafe(intWorktreePath, ['config', 'user.email', 'autonomous@agentforge.local']);
  await gitSafe(intWorktreePath, ['config', 'user.name', 'AgentForge Epic Integrator']);

  for (const branch of childBranches) {
    const res = await gitSafe(intWorktreePath, ['merge', '--no-ff', '-m', `merge ${branch}`, branch]);
    if (res.ok) {
      merged.push(branch);
    } else {
      conflicted.push(branch);
      // Abort the in-progress merge so the worktree stays clean for the next branch.
      await gitSafe(intWorktreePath, ['merge', '--abort']);
    }
  }
  return { merged, conflicted };
}

/** Remove the integration worktree (best-effort). The branch is kept for release. */
export async function removeIntegrationWorktree(projectRoot: string, branch: string): Promise<void> {
  const wtPath = integrationWorktreePath(projectRoot, branch);
  await gitSafe(projectRoot, ['worktree', 'remove', '--force', wtPath]);
  await gitSafe(projectRoot, ['worktree', 'prune']);
}
```

> Note the conflict test's `epicIntegrationBranchName('epic-../x')` expectation: `replace(/[^a-zA-Z0-9-]/g, '')` turns `epic-../x` into `epic-x`, so the result is `codex/epic-x`. Fix the test's expected value to `'codex/epic-x'` (the inline `.replace` in the test draft is wrong — assert the literal `'codex/epic-x'`).

- [ ] **Step 4: Run, expect PASS** (fix the one test expectation noted above) — `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/wave-integration.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/wave-integration.ts packages/core/src/autonomous/phase-handlers/__tests__/wave-integration.test.ts
git commit -m "feat(execute): local integration-branch git orchestration for epic waves (PR-2c2)"
```

---

## Task 2: Wire the integration branch into the execute phase

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts`

- [ ] **Step 1: Add the import + detect the epic cycle**

Add near the top imports:

```ts
import {
  epicIntegrationBranchName,
  ensureIntegrationWorktree,
  mergeBranchesIntoIntegration,
  removeIntegrationWorktree,
} from './wave-integration.js';
```

After `items` is read and before the wave dispatch loop (the `for (const waveItems of groupItemsByWave(items))` from PR-2c1), derive the epic integration branch:

```ts
  // Epic cycle detection (spec §8.2): any item carrying parentEpicId means this
  // is an epic; we maintain a local integration branch so each wave forks off
  // the previous wave's merged code. Flat cycles skip all of this.
  const epicParentId = items.find((it) => it.parentEpicId)?.parentEpicId;
  const integrationBranch = epicParentId ? epicIntegrationBranchName(epicParentId) : undefined;
  let integrationWorktreePath: string | undefined;
  if (integrationBranch && worktreePool) {
    try {
      integrationWorktreePath = await ensureIntegrationWorktree(
        ctx.projectRoot,
        integrationBranch,
        ctx.baseBranch ?? 'main',
      );
    } catch (err) {
      // Non-fatal: fall back to flat behavior (children fork off origin/main).
      ctx.bus.publish('execute.epic.integration-setup-failed', {
        sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId,
        branch: integrationBranch,
        error: err instanceof Error ? err.message : String(err),
      });
      integrationWorktreePath = undefined;
    }
  }
```

- [ ] **Step 2: Pass `sourceRef` for epic items in `allocateWorktreeForItem`**

`allocateWorktreeForItem(pool, ctx, item)` (line 679) must fork epic items off the local integration branch. Thread the branch in. Change its signature + the `pool.allocate` call (the non-rejected path):

```ts
async function allocateWorktreeForItem(
  pool: WorktreePoolLike,
  ctx: PhaseContext,
  item: SprintItem,
  integrationBranch?: string,
): Promise<ExecuteWorktreeHandle> {
  const candidates = worktreeSessionCandidates(ctx, item);
  const rejectedBranch = shouldUseRejectedBranch(ctx, item);
  let lastErr: unknown;

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await pool.allocate({
        agentId: item.assignee,
        sessionId: candidates[i]!,
        ...(rejectedBranch
          ? { branchName: rejectedBranch, sourceRef: `origin/${rejectedBranch}`, deleteBranchOnRelease: false }
          : integrationBranch && item.parentEpicId
            ? { sourceRef: integrationBranch }   // local ref — fork off the epic integration branch
            : {}),
      });
    } catch (err) {
      lastErr = err;
      if (i === candidates.length - 1 || !shouldRetryWorktreeAllocation(err)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

Update the call site (line ~1071): `worktreeHandle = await allocateWorktreeForItem(worktreePool, ctx, item, integrationBranch);`

> `sourceRef: integrationBranch` (a LOCAL branch name) — the pool's `git worktree add --no-track -b <child> <wtPath> <sourceRef>` accepts a local ref. No `origin/` prefix, so no remote needed.

- [ ] **Step 3: Collect completed child branches per wave + merge at the barrier**

In the wave loop, track each wave's child branches. The per-item `finally` already has `worktreeHandle.branch`. Capture completed children into a per-wave list. The simplest non-invasive approach: before the inner item loop, snapshot `liveResults`; after the barrier, compute which of THIS wave's items completed and map them to their branches.

Maintain a module-level (function-scope) `Map<string, string>` of `itemId -> branch` populated where the worktree is allocated (line ~1071, right after a successful allocate):

```ts
        worktreeHandle = await allocateWorktreeForItem(worktreePool, ctx, item, integrationBranch);
        itemBranchById.set(item.id, worktreeHandle.branch);
```

Declare `const itemBranchById = new Map<string, string>();` alongside the other pre-loop state. Then replace the PR-2c1 barrier block with a merge step:

```ts
    // Wave barrier (PR-2c1): block until every item in this wave settles.
    await Promise.allSettled(inFlight.keys());

    // Epic integration (PR-2c2): merge this wave's completed children into the
    // integration branch so the next wave forks off their code.
    if (integrationWorktreePath) {
      const waveBranches = waveItems
        .filter((it) => liveResults.get(it.id)?.status === 'completed')
        .map((it) => itemBranchById.get(it.id))
        .filter((b): b is string => typeof b === 'string');
      if (waveBranches.length > 0) {
        const { conflicted } = await mergeBranchesIntoIntegration(integrationWorktreePath, waveBranches);
        if (conflicted.length > 0) {
          ctx.bus.publish('execute.epic.wave-merge-conflict', {
            sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId,
            branch: integrationBranch, conflicted,
          });
        }
      }
    }
  }
```

> A conflicted child is reported via bus event (the quarantine/blocked cascade for conflicts is PR-2c3). For PR-2c2 a conflict just means that child's code isn't in the integration branch; dependents may then fail their own work — acceptable until the cascade lands.

- [ ] **Step 4: Clean up the integration worktree after the loop**

After `await checkpointWriter.flush();` (end of the wave loop), add:

```ts
  if (integrationBranch && integrationWorktreePath) {
    await removeIntegrationWorktree(ctx.projectRoot, integrationBranch);
  }
```

The integration BRANCH `codex/epic-<id>` survives (release/PR-2d opens the PR from it); only the temporary worktree is removed.

- [ ] **Step 5: Typecheck + the existing execute-phase suite (no-regression)**

`corepack pnpm run check:types` → exit 0.
`corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__` → all green (flat cycles have no `parentEpicId`, so `integrationBranch` is `undefined` and every new block is skipped — identical behavior).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/execute-phase.ts
git commit -m "feat(execute): epic waves fork off + merge into a local integration branch (PR-2c2)"
```

---

## Task 3: End-to-end wave-continuity test

**Files:**
- Test: extend `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts` (real git harness)

- [ ] **Step 1: Add a test** proving wave-1 children see wave-0's merged file. Using the real-git harness (model on `execute-phase-worktree.test.ts` which inits a git repo + real worktree pool):
  - plan.json: c1 (wave 0, `parentEpicId: 'epic-X'`, creates `shared.ts`), c2 (wave 1, `parentEpicId: 'epic-X'`, `predecessors: ['c1']`, asserts/reads `shared.ts`).
  - runtime mock: for c1, write `shared.ts` in its worktree; for c2, record whether `shared.ts` exists in c2's worktree cwd at dispatch time.
  - Assert: c2's worktree contains `shared.ts` (i.e. it forked off the integration branch after c1 merged), AND `codex/epic-X` branch exists at the end with both children's commits.

> If the full real-git E2E proves too heavy/flaky to assert deterministically, report DONE_WITH_CONCERNS shipping Tasks 1-2 (Task 1's git module is exhaustively unit-tested on real git, Task 2's wiring is regression-proven), and note the E2E is covered by the PR-2c3 smoke-gated run. Do NOT ship a test that asserts nothing.

- [ ] **Step 2: Run + commit**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts
git add packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts
git commit -m "test(execute): wave-1 forks off wave-0's merged integration branch (PR-2c2)"
```

---

## Task 4: Verification gate

- [ ] **Step 1:** `corepack pnpm run check:types` → exit 0.
- [ ] **Step 2:** `corepack pnpm exec vitest run packages/core tests/autonomous` → only the 3 known pre-existing failures, nothing new. The full `phase-handlers/__tests__` suite (flat-path regression) MUST be green.

---

## Self-Review

**Spec coverage (§8.2 integration branch):** local `codex/epic-<id>` created off baseBranch (Task 1 `ensureIntegrationWorktree`); wave worktrees fork off it via `sourceRef` (Task 2 Step 2); completed children merged in at each barrier (Task 2 Step 3). **Deviation from spec §8.2:** the spec said `origin/codex/epic-<id>` (remote) + push between waves; we use a LOCAL branch + local merges (no push until release) to avoid a hard remote dependency that would make the feature unrunnable locally and untestable. Same outcome (wave N+1 sees wave N's code); push moves to release (PR-2d). **Deferred:** conflict → quarantine/blocked cascade (PR-2c3, here a conflict is reported via bus event only); smokeGuard between waves (PR-2c3); pushing the integration branch + opening the PR (PR-2d).

**Placeholder scan:** Tasks 1-2 exact code. Task 3 is a guided real-git E2E with an explicit DONE_WITH_CONCERNS fallback (no meaningless test).

**No-op-for-flat invariant:** `integrationBranch` is `undefined` unless an item has `parentEpicId`; every new block (`ensureIntegrationWorktree`, the `sourceRef` override, the merge, the cleanup) is guarded on it. Flat cycles are byte-for-byte unchanged — proven by the existing `phase-handlers/__tests__` suite staying green (Task 2 Step 5, Task 4).

**Type consistency:** `epicIntegrationBranchName`/`ensureIntegrationWorktree`/`mergeBranchesIntoIntegration`/`removeIntegrationWorktree` named identically across the module, the imports, and the call sites. `integrationBranch` (local ref string) is passed as `sourceRef` with NO `origin/` prefix — matching the pool's local-ref handling.

**Risk note:** this is real repo-mutating git orchestration. The dedicated integration worktree isolates merges from the main tree + child worktrees; merges run only at the barrier (no concurrent access to the integration branch); conflicts are aborted (`merge --abort`) leaving a clean tree. `mergeBranchesIntoIntegration`'s conflict test exercises the abort path.

---

## Deferred to PR-2c3 / PR-2d

- **PR-2c3:** the `smokeGuard` arg on `selectGateMode` (`run-verify-tests.mjs`, pack §5.4) + a per-wave smoke check (build + `vitest related` on the integration worktree); quarantine a failed/conflicted child + mark transitive dependents `blocked` (skip in later waves via the predecessor set).
- **PR-2d:** push `codex/epic-<id>` + open one squashed PR; gate runs on the integration branch HEAD; epic risk classification; `epic.*` caps; `cycle.json` observability (waveResults, epicOutcome).
