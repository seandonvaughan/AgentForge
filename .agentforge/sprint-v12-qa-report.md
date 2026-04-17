# Sprint v12.0.0 QA Test Strategy Report

**Date:** 2026-04-17  
**Analysis Scope:** 63 modified files across 22 completed sprint items  
**Overall Risk Level:** 🟡 Medium (mostly UI/data with targeted core fixes)  
**Overall Confidence:** 3.5/5

---

## Risk Assessment by Changed File

### 🔴 High-Risk Core Changes

**`packages/core/src/autonomous/cycle-runner.ts`** — CycleID Coordination
- **Risk:** Runtime critical; affects cycle logging directory allocation
- **Change:** Added `cycleId?: string` option parameter; establishes priority chain (options.cycleId → env var → UUID)
- **Coverage:** ✅ Fully testable via unit tests; indirectly validated by existing integration tests
- **Concern:** UUID validation regex used correctly, three-tier fallback logic is clear
- **Recommendation:** Unit test covering all three fallback scenarios explicitly (currently inferred)

**`packages/core/src/autonomous/scoring-pipeline.ts`** — Malformed JSON Extraction
- **Risk:** Fallback logic for LLM output parsing; affects scoring stability
- **Changes:** Added 4-step extraction strategy (fence-strip → brace extraction → control-char sanitization)
- **Coverage:** ⚠️ **Gap** — New helper functions `extractScoringJson()`, `findFirstBalancedBraces()`, `sanitiseControlCharsInStrings()` are NOT explicitly unit tested
- **Concern:** Functions are indirectly exercised through `parseAndValidate()`, but edge cases (escaped quotes, nested braces, literal newlines) lack direct test coverage
- **Recommendation:** Add 8-10 unit tests for each helper function covering:
  - Brace extraction with leading prose, nested braces, unclosed braces
  - Control character sanitization with mixed escape sequences
  - All three fallback scenarios independently (not just success path)

**`packages/cli/src/commands/autonomous.ts`** — Type Safety & CycleID Passing
- **Risk:** CLI phase runner; affects autonomous loop execution
- **Changes:** Replaced 9 `any` type casts with concrete `PhaseContext` and `MessageEnvelopeV2` types; added cycleId parameter to CycleRunner
- **Coverage:** ✅ Type-safe compilation guarantees; runtime coordination validated indirectly
- **Concern:** None identified; type narrowing is strict and correct
- **Recommendation:** Smoke test (one integration test) ensuring CLI and API-spawned cycles produce same cycleId mapping

### 🟡 Medium-Risk API/Data Changes

**`packages/server/src/routes/v5/dashboard-stubs.ts`** — Memory API Metadata Passthrough
- **Risk:** API response shape; affects dashboard rendering
- **Changes:** Added metadata field passthrough to batch and streaming endpoints
- **Coverage:** ✅ 2 new tests added for metadata inclusion and exclusion
- **Concern:** Conditional spread pattern is idiomatic; malformed JSONL lines gracefully skipped
- **Recommendation:** Add test for entries with partial metadata (only some fields present)

**`packages/server/src/routes/v5/cycles.ts`** — Cycle Detail Synthesis
- **Risk:** API endpoint; affects dashboard cycle view
- **Changes:** Updated TODO comment to reflect cycleId coordination; no logic changes
- **Coverage:** ✅ 2 new tests added for killed cycles (both synthetic and with cycle.json)
- **Concern:** Killed cycle synthesis relies on event ordering; missing event could produce 404 instead of `stage: killed`
- **Recommendation:** Test killed-cycle recovery when events.jsonl exists but cycle.json is missing

**`packages/server/src/routes/v5/sprints.ts`** — Backward Compatibility Fallback
- **Risk:** Sprint data normalization; affects historical data rendering
- **Changes:** Added 6-field fallback chains for v4.7–v5.x era format compatibility
- **Coverage:** ✅ 6 new tests added covering each fallback scenario
- **Concern:** Type guards for `results` object are correct; field precedence is documented
- **Recommendation:** None identified; test coverage is comprehensive

### 🟢 Low-Risk UI Changes

**Dashboard Components** (15 files modified)
- Runner, agents, flywheel, memory, branches, sprints detail pages
- **Risk:** Rendering correctness; CSS styling
- **Coverage:** ✅ 38 UI tests added, E2E regression tests for __unassigned__ filter and model badges
- **Concern:** `hidden={!loading}` binding vs `class:hidden`; Svelte type-safety with `exactOptionalPropertyTypes`
- **Recommendation:** None identified; test coverage is solid

**CLI Consolidation & Deprecation** (3 files)
- Deleted 12 root CLI command wrappers, updated index.ts shim
- **Risk:** Backward compatibility; deprecation messaging
- **Coverage:** ✅ Audit document created; legacy commands verified as removed
- **Concern:** None identified; clean deletion with clear migration path

---

## Missing Test Coverage & Edge Cases

### Critical Gaps

1. **Scoring Pipeline Helpers — No Direct Unit Tests**
   - `extractScoringJson()`: untested for prose-before-JSON, escaped quotes in values
   - `findFirstBalancedBraces()`: untested for incomplete/unescaped braces
   - `sanitiseControlCharsInStrings()`: untested for mixed escape sequences
   - **Impact:** If malformed JSON extraction fails, fallback may silently drop to static ranking
   - **Effort:** ~30min to add 8–10 focused unit tests

2. **Gate Phase Verification Logic — Untested Prompt Change**
   - New prompt instructs agent to verify findings against working tree before rejecting
   - No automated check that agent actually performs verification steps
   - **Impact:** False rejections could recur if gate agent doesn't follow new instructions
   - **Effort:** Low risk (prompt-only, no logic change), but high-value acceptance test

3. **CycleID Coordination — No Explicit Test**
   - Three-tier fallback (options → env → UUID) is correct but not directly tested
   - API + CLI spawned cycles should map to same directory
   - **Impact:** Cycles written to wrong directory if fallback logic has bug
   - **Effort:** ~15min integration test

### Notable Non-Gaps

- ✅ Backward compatibility fallback chains (sprints.ts) fully tested
- ✅ Memory metadata passthrough API tested for both inclusion and absence
- ✅ Killed cycle synthesis tested for both direct cycle.json and events.jsonl recovery
- ✅ Dashboard filters (__unassigned__ team, model tiers) tested at unit + E2E level
- ✅ CLI type safety improvements validated by TypeScript strict mode

---

## Recommended Follow-Up Tests

### Sprint v12 Verification Stage

1. **`test:unit — packages/core/src/autonomous/scoring-pipeline.test.ts`**
   - Test name: `parseAndValidate recovers from four malformed JSON scenarios`
   - Coverage: fence-stripped, prose-before-JSON, literal newlines, unescaped control chars
   - Time: ~30min

2. **`test:integration — gate-phase finding verification`**
   - Test name: `gate phase verifies CRITICAL findings, dismisses resolved ones`
   - Coverage: Simulate finding that was fixed; verify gate doesn't reject on it
   - Time: ~45min

3. **`test:integration — API + CLI cycle coordination`**
   - Test name: `API-spawned cycle and CLI execution write to same directory`
   - Coverage: POST /api/v5/cycles returns id; env var + cycleId passed; same logs directory
   - Time: ~20min

4. **`test:unit — backward compat edge cases`**
   - Test name: `sprints normalizer handles all empty/missing result fields gracefully`
   - Coverage: results={}, results=[], results=null, results undefined
   - Time: ~15min

---

## Overall Assessment

### Strengths
- **Type Safety:** All `any` casts removed from phase handlers; TypeScript strict mode enforced
- **Test Additions:** 60+ new tests added across dashboard, API, and integration layers
- **Backward Compatibility:** Fallback chains properly tested and documented
- **Data Integrity:** Cycle killed-state rendering and memory passthrough validated

### Weaknesses
- **New Utility Logic Untested:** Scoring pipeline JSON extraction helpers lack explicit unit tests
- **Prompt Change Unvalidated:** Gate phase's new verification instructions not tested for agent compliance
- **CycleID Coordination Test Missing:** Three-tier fallback not explicitly verified

### Execution Confidence
- **Happy Path:** 4.5/5 (all existing tests pass, new happy-path tests added)
- **Error Paths:** 2.5/5 (scoring fallback logic untested; gate verification not validated)
- **Integration:** 3.5/5 (cycleID coordination assumed correct, not verified end-to-end)

### Risk Mitigation
All identified gaps are **non-blocking for v12.0.0 release** but should be addressed in v12.1.0 or during next autonomous cycle:
- Add 8–10 unit tests for scoring JSON extraction helpers
- Add 1 integration test for gate finding verification
- Add 1 integration test for cycleID coordination

**Recommended Action:** Merge to main with note to address scoring pipeline test gap in v12.1.0.
