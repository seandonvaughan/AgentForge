# Lesson Flywheel — Phase 0 (attribution) + Phase 1 (outcome-correlated promotion)

> Grounded against real source (main @ 692fd55+) by a 4-agent code-mapping workflow, not the roadmap's citations. Source: ruflo gap analysis Phase 0/1.

## Feasibility
- **Phase 0 (lesson-attribution): FEASIBLE.** Propagation spine exists — `execute-phase.ts` writes `itemResults[]` into `.agentforge/cycles/<id>/phases/execute.json`; `test-phase.ts` + `gate-phase.ts` already read it. **Blocking constraint (honesty, not blocker):** gate verdict + VERIFY are **cycle-scoped, not item-scoped**. Record cycle-level verdict/verify with a `scope:'cycle'` marker; do NOT fabricate per-item verdicts.
- **Phase 1 (outcome-correlated promotion): FEASIBLE, depends on Phase 0 data.** Lands in `team/engine/learnings/curator.ts` (has `projectRoot`); leave legacy `builder/memory-curator.ts` on the baseline.

## Stable lesson ID — `packages/core/src/team/engine/learnings/lesson-id.ts` (NEW)
```ts
import { createHash } from 'node:crypto';
function normalizeForHash(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function deriveSlug(t: string): string {
  const tokens = normalizeForHash(t).split(' ').filter((x) => x.length > 3);
  return tokens.slice(0, 4).join('-').slice(0, 48) || 'lesson';
}
export function computeLessonId(lessonText: string): string {
  const hash = createHash('sha256').update(normalizeForHash(lessonText)).digest('hex').slice(0, 12);
  return `${hash}-${deriveSlug(lessonText)}`;
}
```
Computed **on-read** at the dispatch seam (no YAML schema change). Same normalized text → same ID across re-forges; rewording cold-starts (acceptable v1, no fuzzy matching). 12-char hash is the join key; slug is debug sugar.

## exactOptionalPropertyTypes (tsconfig.base.json:7 = true)
Never assign literal `undefined` to a `?:` field. Use conditional spread: `...(x.length ? { appliedLessons: x } : {})` (execute-phase.ts:1407 already does this).

---

## Phase 0 — lesson-attribution instrumentation (ONE PR)

**A. NEW `team/engine/learnings/lesson-id.ts`** — the module above.
*Acceptance:* `computeLessonId` is byte-identical across calls and across casing/whitespace/trailing-period variants of the same text; two different lessons → different 12-char prefixes.

**B. NEW `memory/lesson-attribution.ts`** — append-only writer + reader mirroring `memory/types.ts` `writeMemoryEntry` (lock + `appendFileSync`); do NOT extend the closed `MemoryEntryType` enum.
```ts
export interface LessonAttributionEntry {
  id: string;                              // randomUUID()
  cycleId: string; itemId: string; agentId: string;
  lessonId: string;                        // computeLessonId(text)
  lessonText: string;
  gateVerdict?: 'approved' | 'rejected';   // cycle-scoped, filled at gate (conditional-spread)
  verifyPassed?: boolean;                  // cycle-scoped, filled at verify
  scope: 'cycle';                          // honesty marker
  ts: string;                              // ISO
}
// appendLessonAttributions(projectRoot, rows: Omit<LessonAttributionEntry,'id'|'ts'>[]): void
// readLessonAttributions(projectRoot): LessonAttributionEntry[]
```
Path `.agentforge/memory/lesson-attribution.jsonl`. Append-only; gate/verify fill by appending augmented rows keyed by `(cycleId,itemId,lessonId)`; reader collapses to latest filled verdict per key.
*Acceptance:* append 3 rows → re-read returns 3 valid JSONL rows with stable lessonIds; lock created/released.

**C. `autonomous/phase-handlers/execute-phase.ts`**
- `interface ItemResult` (~line 382): add `appliedLessons?: string[];`.
- Where `memoryEntries` feed `buildItemPrompt` (~1171-1183): `appliedLessons = memoryEntries.map(e => computeLessonId(<lesson text>))` per item (reuse curator's `extractLessonFromEntry` or the entry `.value`).
- ItemResult construction (~1407, 1456): conditional-spread `...(appliedLessons.length ? { appliedLessons } : {})`.
- After `itemResults` assembled (~1683-1752): `appendLessonAttributions(projectRoot, rows)` — one row per (item × appliedLesson), gateVerdict/verifyPassed omitted, `scope:'cycle'`.
*Acceptance (ungameable):* every `lessonId` in the jsonl ⊆ `{computeLessonId(text) for text in that agent's injected memoryEntries}` — test reconstructs the expected set from the same memoryEntries the prompt builder saw, asserts subset.

**D. `autonomous/phase-handlers/gate-phase.ts`**
- After verdict finalized (`verdictNorm`, before ~709): read attribution rows for `ctx.cycleId`, append augmented rows with `gateVerdict: verdictNorm` (SAME value written to gate.json:644 / gate-verdict memory:709 — do not recompute).
*Acceptance (ungameable):* every `gateVerdict` in the jsonl == `verdict` in that cycle's `phases/gate.json`.

**E. `autonomous/phase-handlers/test-phase.ts`**
- After aggregate test result: append augmented rows with `verifyPassed = (failed === 0)` (cycle-scoped).
*Acceptance (ungameable):* `verifyPassed` == `(cycle.json tests.failed === 0)`.

---

## Phase 1 — outcome-correlated promotion (FOLLOW-UP PR, after Phase 0)

**A. `memory/lesson-attribution.ts`** — add:
```ts
export function computeOutcomeConfidence(passes: number, appearances: number): number {
  const conf = (passes + 1) / (appearances + 2);   // Beta(1,1) posterior mean
  return Math.min(0.95, Math.max(0.05, conf));
}
```
Collapse history per `(cycleId,itemId,lessonId)` to latest filled verdict before counting.

**B. `team/engine/learnings/scorer.ts`** — `ScoredEntry` (line 121): add optional `outcomeConfidence?`, `attributedAppearances?`. Keep `scoreEntry` pure (no projectRoot) — baseline severity×recency intact.

**C. `team/engine/learnings/types.ts`** — `ProposedLearning` (line 8): add optional `outcomeConfidence?`, `attributedAppearances?`.

**D. `team/engine/learnings/curator.ts`** — `curateLearnings` (255):
- After the 5 `readMemoryEntries` (266-270): `readLessonAttributions(projectRoot)` → `Map<lessonId,{passes,appearances}>`.
- In scoring loop (322): `computeLessonId(lesson)` → lookup → `computeOutcomeConfidence` → conditional-spread onto `ProposedLearning`.
- Replace `proposals.slice(0, CAP_PER_AGENT)` (347) with durable-slot gate: `N_MIN=3`, `CONF_FLOOR=0.6`, `DURABLE_SLOTS=8`. eligible = appearances≥N_MIN && conf≥CONF_FLOOR, sorted by conf then score; durable = first 8; fallback = remaining by baseline score; `[...durable, ...fallback].slice(0,CAP_PER_AGENT)`. Empty attribution → eligible empty → output byte-identical to baseline.
*Acceptance (ungameable):* fixture with lesson A (≥3 cycles approved/passed) vs B (≥3 rejected/failed), identical severity+recency+role → A in durable slice, B not; WITHOUT attribution file → baseline tie ordering (flip caused only by outcome data); cold-start → full ordering == pre-Phase-1 snapshot.

## Risks
Lesson-ID breaks on LLM rewording (orphan cold-starts → falls back to baseline, no crash). Low cycle count → Beta prior ≈0.5 + appearances<N_MIN → stays baseline (feature). Cycle-scoped verdict over-attributes (mark `scope:'cycle'`; per-item is separate larger work). Leave legacy `builder/memory-curator.ts` on baseline.
