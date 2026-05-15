# Test Strategy Report — Sprint v14.1.0 Execute Phase

## Executive Summary

**Overall Confidence: 2/5** — This sprint shows strong unit test coverage for isolated backend logic but has significant gaps in integration, component, and E2E coverage. **Critical blocker**: Item 10 (flywheel page wiring) failed completely due to timeout, leaving core metrics computation potentially incomplete.

---

## Risk Assessment by Changed File

### 1. `packages/dashboard/src/__tests__/flywheel-page-server.test.ts` (+66 lines)
**Risk: LOW** | **Test Type**: Unit tests (backend computation logic)

**Changes**: 4 new tests added for velocity score formula boundaries:
- `cycleThroughput` calculation (`min(30, meaningfulCycles * 5)`)
- `sessionBoost` calculation (`min(15, floor(satisfiedSessions / 2))`)
- Combined three-component formula
- Cross-directory cycle merge (active + archived)

**Coverage Quality**: Excellent for happy paths; these tests pin critical formula constants.

**Gaps Identified**:
- ❌ **No error handling tests**: What happens if `cycle.json` is malformed or missing required fields?
- ❌ **No edge case for formula caps**: Tests verify the formulas work at specific thresholds, but don't test behavior at the boundary (29 vs 30 cycles, 14 vs 15 sessions)
- ❌ **No integration with real SSR rendering**: Tests are pure computation; don't verify Svelte renders the computed values correctly

---

### 2. `packages/dashboard/src/routes/flywheel/+page.svelte` (+11 lines, -1)
**Risk: LOW** | **Test Type**: Component logic (reactive statements only)

**Changes**: Added conditional display of `meaningfulCycleCount` when it differs from `completedCycleCount`

```javascript
sub: flywheel.debug.meaningfulCycleCount !== flywheel.debug.completedCycleCount
  ? `${flywheel.debug.completedCycleCount} completed · ${flywheel.debug.meaningfulCycleCount} meaningful`
  : `${flywheel.debug.completedCycleCount} completed`,
```

**Coverage Quality**: Logic is straightforward (ternary branch); low likelihood of runtime errors.

**Gaps Identified**:
- ❌ **No component tests**: Svelte snapshot/interaction tests missing
- ❌ **No tests for undefined values**: What if `flywheel.debug.meaningfulCycleCount` is undefined? Ternary will render "undefined · undefined"
- ❌ **No accessibility tests**: Alt text or ARIA labels for the new stat row
- ❌ **No E2E verification**: No test confirms the new stat row appears in the browser when data is real

**Recommended Test**: Add a Vitest component test:
```typescript
it('displays meaningful cycle count when different from completed', () => {
  const data = { debug: { cycleCount: 5, completedCycleCount: 3, meaningfulCycleCount: 4 }};
  // render component with data
  expect(screen.getByText('3 completed · 4 meaningful')).toBeVisible();
});
```

---

### 3. `packages/dashboard/src/__tests__/memory-page-server.test.ts` (NEW, 536 lines, 40 tests)
**Risk: MEDIUM** | **Test Type**: Unit tests (SSR server logic)

**Changes**: Complete new test suite for memory page SSR-side data loading:
- Empty/missing state handling (4 tests)
- Field mapping from JSONL and curated JSON (9 tests)
- Merge + deduplication logic (3 tests)
- Search/agent/type filters (13 tests)
- **Critical**: `filter-before-cap` correctness test (regression guard from v11)

**Coverage Quality**: Comprehensive for SSR data path. Explicit guard against filtering-after-capping bug.

**Gaps Identified**:
- ❌ **No API route tests**: Tests are SSR-only; `/api/v5/memory` endpoint behavior untested
- ❌ **No large-dataset tests**: SSR_LIMIT=200 cap tested at boundary, but no tests for >1000 entries performance
- ❌ **No JSONL parsing edge cases**: No tests for JSONL with mixed line endings, BOM markers, or streaming reads
- ❌ **No real-file concurrency tests**: What if memory.jsonl is being written while read happens?
- ❌ **No integration with page load**: Tests export `_readMemoryEntries()` but don't verify it's called in the `load()` function

**Status Note**: File exists (20 KB, modified 23:25 today) but **not yet committed to main** — merge workflow issue?

---

### 4. `packages/dashboard/src/routes/memory/+page.server.ts` (MODIFIED, details unavailable)
**Risk: MEDIUM** | **Test Type**: SSR server refactoring

**Reported Changes** (from sprint result):
- Exported `_readMemoryEntries(root, opts)` and `_readMemoriesJson(root)` for testing
- Refactored to accept explicit `root` parameter (was calling `findProjectRoot()` internally)

**Gaps Identified**:
- ❌ **No visibility into actual changes**: Git diff shows no changes on main branch; work likely on worktree
- ❌ **Unclear if `load()` function was updated**: Sprint report doesn't confirm the refactored functions are wired into the page load
- ❌ **No tests for the new `_` exports**: Exported functions should have dedicated unit tests (now provided via memory-page-server.test.ts)

---

### 5. `docs/superpowers/specs/2026-04-07-dashboard-completion-backlog.md` (MODIFIED)
**Risk: LOW** | **Test Type**: Documentation

**Changes**: Item 6 (phases), item 16 (memory), and item 18 (flywheel) marked as `✅ DONE` with detailed completion summaries.

**Status**: Spec file shows items 6 and 16 as DONE, but **item 19 (flywheel metrics wiring) still marked TODO** despite item 18 completing tests. Inconsistent state.

---

## Critical Finding: Item 10 Complete Failure

**Item 10 Status**: `failed` | Duration: 20+ minutes | Cost: $0 | Response: empty

Item 10 (flywheel page metrics computation) timed out twice at 600s. This is likely the core work on `_computeMetrics()` function that item 18's tests depend on.

**Implications**:
- ✅ Item 18 tests pass in isolation (they test boundary conditions, not full metrics computation)
- ❌ **Real flywheel computation may be incomplete**: If item 10's work was to wire up `/api/v5/flywheel` endpoint, that endpoint might not exist or might be broken
- ❌ **Inconsistent spec file**: Spec still marks item 19 TODO, yet item 18 (tests) is marked complete

**Recommended Verification**: 
1. Check if `/api/v5/flywheel` endpoint exists in `packages/server/src/routes/v5/`
2. Run a real request to `/api/v5/flywheel` to verify it returns metrics (not 404/500)
3. Verify `_computeMetrics()` function exists and is exported

---

## Missing Test Coverage — Recommended Follow-Up Tests

### High Priority (blocks shipping)

| Test Name | Coverage | Effort |
|-----------|----------|--------|
| **flywheel-metrics-api.test.ts** | GET /api/v5/flywheel endpoint returns correct payload shape | Medium |
| **flywheel-component.test.ts** | Svelte component renders metrics, gauges, stat rows with real data | Medium |
| **memory-api.test.ts** | GET /api/v5/memory endpoint (if it exists) with search/filter params | Medium |

### Medium Priority (improve confidence)

| Test Name | Coverage | Effort |
|-----------|----------|--------|
| **flywheel-ssr-fixtures.test.ts** | Real-file smoke test (read actual .agentforge/cycles/ and sprints/) | Low |
| **memory-jsonl-edge-cases.test.ts** | Malformed JSONL, missing fields, empty lines, BOM markers | Low |
| **flywheel-formula-boundaries.test.ts** | Test at exact formula boundaries (29→30, 14→15) | Low |

### Low Priority (polish)

| Test Name | Coverage | Effort |
|-----------|----------|--------|
| flywheel-e2e.test.ts | Browser test of flywheel page rendering gauges | High |
| memory-search-performance.test.ts | Search performance with 1000+ entries | Medium |

---

## Uncommitted Changes Risk

Two files show uncommitted changes in working tree:
- ✅ `flywheel-page-server.test.ts` — already staged/modified, ready for commit
- ✅ `flywheel/+page.svelte` — already modified, ready for commit
- ⚠️ `memory-page-server.test.ts` — **40 tests exist but not in git status** (on worktree? not staged?)
- ⚠️ `memory/+page.server.ts` — **changes reported but not visible in diff** (merge workflow issue)

**Risk**: Spec file was marked DONE but actual code is not committed to main. If tests fail during VERIFY phase, there's no git history to roll back to.

---

## Test Execution Dependencies

Before running the full test suite, verify:
1. ✅ Memory page SSR test file is staged and will be committed
2. ✅ Memory page server refactoring is wired into `load()` function
3. ❌ **BLOCKER**: Flywheel `/api/v5/flywheel` endpoint exists (item 10 may not be done)
4. ⚠️ Flywheel spec file is marked DONE (currently still TODO in spec)

---

## Confidence Breakdown

| Category | Score | Notes |
|----------|-------|-------|
| **Unit test coverage** | 4/5 | Excellent SSR logic tests; weak on edge cases |
| **Integration test coverage** | 2/5 | No API endpoint tests; no real file I/O tests |
| **Component test coverage** | 1/5 | Zero Svelte component tests |
| **E2E test coverage** | 2/5 | Memory page has E2E tests; flywheel has none |
| **Error handling** | 1/5 | No error path tests (malformed files, missing data, timeouts) |
| **Deployment risk** | 2/5 | Item 10 failure leaves metrics wiring uncertain |

**Overall: 2/5** — Backend unit logic is solid; integration and component gaps are significant. Recommend full VERIFY phase before merge.

---

## Next Steps for QA

1. **Immediate**: Run unit tests for flywheel and memory SSR logic
2. **Blocking**: Verify `/api/v5/flywheel` endpoint exists and returns real data (resolves item 10 uncertainty)
3. **Before merge**: Add API contract tests for both endpoints
4. **Before ship**: Add E2E tests for flywheel gauge rendering and stat row updates
