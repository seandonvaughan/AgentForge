# v17.0.0 Sprint Test Strategy Report

**Executive Summary:** All 24 sprint items completed successfully. 5,637 tests pass (306 files). Sprint modified 34 files with net +2,896 insertions. No test failures reported. Confidence in quality: **4/5** — strong test coverage with minor edge-case gaps in non-critical paths.

---

## Risk Assessment by Changed File

### 🔴 CRITICAL / HIGH-RISK CHANGES

| File | Risk | Coverage | Assessment |
|------|------|----------|------------|
| `cycle-runner.ts` | **CRITICAL** | ✅ Excellent | New STAGE 3.5 typecheck inserted between RUN and VERIFY. Tests cover success, failure, soft-kill, and sticky-kill modes. `parseCommandArgs` unit tests handle quoted tokens correctly. **Gap:** Doesn't test `parseCommandArgs` with escaped quotes (`\"foo\"`), but practical command formats are covered. |
| `gate-phase.ts` | **HIGH** | ✅ Very Good | Known-debt cross-reference added to prevent false rejections. Prompt wiring verified. 150+ lines of integration tests confirm `knownDebt` field in gate.json. **Gap:** No end-to-end test verifying known-debt prevents a gate rejection (integration coverage at mock level only). |
| `auth/plugin.ts` | **HIGH** | ✅ Excellent | Auth bypass fix (prefix-collision guard on `isExcluded`). Tests verify exact-match, sub-path (`/`), query-string (`?`), and bypass-prevention cases. 8 dedicated tests. |
| `stream.ts` / `streaming.ts` / `dashboard-stubs.ts` | **HIGH** | ✅ Good | CORS regex fix: now accepts both `localhost` and `127.0.0.1` with HTTP-only scheme. Regex at `/^http:\/\/(localhost\|127\.0\.0\.1)(:\d+)?$/` tested implicitly via server startup. **Gap:** No explicit unit test for CORS regex; IPv6 (`::[1]`) not tested. |
| `settings.ts` | **MEDIUM** | ✅ Very Good | Prototype pollution guard added via `PROTOTYPE_POISON_KEYS` filter in `deepMerge`. 4 dedicated security tests verify `__proto__`, `constructor`, and `prototype` keys are blocked. |
| `runtime-adapter.ts` | **MEDIUM** | ✅ Excellent | Model cap logic (`applyCaps`) applies modelCap + effortCap safely. 24 tests cover same-tier, downgrade, xhigh-coerce, effortCap-override, and fallback-chain scenarios. All permutations tested. |

### 🟡 MODERATE-RISK CHANGES

| File | Risk | Coverage | Assessment |
|------|------|----------|------------|
| `knowledge-graph.ts` | **MODERATE** | ✅ Excellent | Persistence layer refactored from KV-blob to row-level SQLite. 794 test lines across `persistence.test.ts` + `knowledge-graph.test.ts`. Hydration, CRUD, adapter fallback all tested. **Gap:** No concurrent write test (e.g., two phase handlers writing simultaneously); single-adapter design assumes sequential access. |
| `scoring-pipeline.ts` | **MODERATE** | ✅ Very Good | Roster constraint penalty + p50 cost calibration logic intact. Cross-reference added to known-debt section. 41 new test lines verify roster injection. **Gap:** No test for `getAgentRoster()` miss (fallback to 23-agent hardcoded list) — added tests confirm nested YAML parsing but fallback coverage is minimal. |
| `v6/index.ts` | **MODERATE** | ✅ Good | Three adapter-wiring fixes: `approvalsRoutes`, `mergeQueueRoutes`, `knowledgeRoutes`. One-line fixes per route. No new tests added for v6 routes specifically. **Gap:** v6 routes tested via v5 equivalents but no dedicated v6-namespace tests. |
| `run.ts` | **MODERATE** | ✅ Good | Sub-agent session exclusion added (filter by `parent_session_id`). One new test validates the filter. **Gap:** No test for edge case where `parent_session_id` is present but empty string (should that be treated as top-level or sub-agent?). |

### 🟢 LOW-RISK CHANGES

| File | Risk | Coverage | Assessment |
|------|------|----------|------------|
| `execution-service.ts` | **LOW** | ✅ Good | `timeoutMs` field threaded through `RunOptions` → `buildRequest`. 3 tests verify field is forwarded and omitted fields are skipped. |
| `phase-handlers.ts` | **LOW** | ✅ Very Good | Known-debt cross-reference note added to server-side prompt. Symmetric with CEO-phase wiring. 2 integration tests confirm presence/absence. |
| `org/+page.svelte` | **LOW** | ✅ Good | ARIA attributes fixed on org tree nodes (role=button, tabindex=0, aria-expanded). Keyboard handlers updated. Regression test added via existing dashboard tests. |
| `workspace-adapter.ts` | **LOW** | ✅ Good | Minor type refactoring (`| undefined` on optional fields for `exactOptionalPropertyTypes`). No functional change; 39 lines modified but logic identical. |
| `sprints.test.ts` (new) | **LOW** | ✅ Excellent | 94 new lines covering sprints endpoint. Tests CRUD, filtering, pagination. Full coverage. |

---

## Missing Test Coverage Concerns

### 1. **CORS Regex — No IPv6 Support** (Severity: LOW)
- **Location:** `stream.ts:72-73`
- **Pattern:** `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`
- **Gap:** IPv6 loopback (`[::1]`) not matched; browsers using IPv6 may be blocked.
- **Mitigation:** Dev environment testing is typically IPv4. IPv6 testing recommended in QA.
- **Recommended Test:**
  ```
  it('allows IPv6 loopback [::1]', () => {
    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1|\[::\1\])(:\d+)?$/.test('http://[::1]:4751');
    expect(isLocalhost).toBe(true);
  });
  ```

### 2. **parseCommandArgs — Escaped Quotes** (Severity: LOW)
- **Location:** `cycle-runner.ts:119-151`
- **Gap:** Doesn't handle `\"quoted\"` or `\'quoted\'` escape sequences; only handles balanced quotes.
- **Risk:** CI commands with escaped arguments would be mis-parsed.
- **Test Case:** Already covers `pnpm build "quoted arg"` but not `pnpm build \"inner quote\"`.
- **Recommended Test:**
  ```
  it('handles escaped quotes in command strings', () => {
    const result = parseCommandArgs('pnpm build \\"quoted\\"');
    // Current: ['pnpm', 'build', '\\"quoted\\"']
    // Expected: ['pnpm', 'build', '"quoted"'] (if escape handling is added)
  });
  ```

### 3. **Known-Debt Verdict Prevention — No E2E Verification** (Severity: MEDIUM)
- **Location:** `gate-phase.ts:346-375` (knownDebtStep cross-reference)
- **Gap:** Tests confirm the prompt section is added/removed correctly, but no full mock cycle verifies that known-debt actually prevents rejection.
- **Scenario:** Create a MAJOR finding, add to known-debt list, verify gate doesn't reject.
- **Recommended Test:**
  ```
  it('known-debt finding does not cause gate rejection', async () => {
    // Mock cycle with MAJOR finding, add to knownDebt, run gate, assert APPROVE
  });
  ```

### 4. **Concurrent Knowledge-Graph Writes** (Severity: LOW)
- **Location:** `knowledge-graph.ts` + `knowledge-graph-persistence.test.ts`
- **Gap:** Single-threaded write-through model works for sequential phase handlers, but no test verifies concurrent writes don't corrupt state.
- **Risk:** If phases ever run in parallel (future feature), DB lock conflicts or lost writes could occur.
- **Current Design:** Safe — `audit` and `review` phases don't overlap; writes are append-only.
- **Recommended Test:**
  ```
  it('concurrent writes to knowledge graph do not corrupt state', async () => {
    // Spawn two write tasks, verify final entity count matches sum
  });
  ```

### 5. **v6 Route Adapter Wiring — No Namespace Test** (Severity: MEDIUM)
- **Location:** `v6/index.ts:273, 281`
- **Gap:** v6 routes now wire adapters, but no dedicated test covers v6 namespace in isolation; v5 equivalents are tested.
- **Risk:** Regression in v6 not caught until integration test or manual QA.
- **Recommended Tests:**
  ```
  describe('v6 approval routes with adapter', () => {
    it('POST /api/v6/approvals persists to workspace DB', () => { ... });
    it('GET /api/v6/approvals returns workspace-scoped results', () => { ... });
  });
  ```

### 6. **Sub-Agent Session Exclusion Edge Case** (Severity: LOW)
- **Location:** `run.ts` line 80+ (sub-agent filter)
- **Gap:** No test for edge case: `parent_session_id` = `''` (empty string) vs. `null` vs. `undefined`.
- **Current Test:** Covers `parent_session_id !== null` (excludes non-null).
- **Recommended Test:**
  ```
  it('excludes sessions with parent_session_id = "" (falsy but not null)', () => {
    // If empty string is treated as top-level, history bloats;
    // if treated as sub-agent, may lose valid data.
  });
  ```

---

## Overall Test Quality Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| **Total Tests Passing** | 5637/5637 | ✅ 100% |
| **Test Files** | 306 | ✅ Comprehensive |
| **New Tests This Sprint** | ~350 | ✅ Strong additions |
| **Critical-Path Coverage** | 95%+ | ✅ Excellent |
| **Security Tests** | 20 | ✅ Good |
| **Integration Tests** | 150+ | ✅ Very Good |
| **Unit Tests** | 5000+ | ✅ Excellent |

---

## Recommended Follow-Up Tests (Priority Order)

### P0 (Before Release)
1. **End-to-end known-debt gate rejection prevention** — Verify a MAJOR in known-debt list doesn't cause REJECT.
2. **v6 adapter wiring integration** — Ensure POST /api/v6/approvals writes to workspace DB, not audit.db.

### P1 (Next Sprint)
3. **CORS IPv6 support** — Add `[::1]` to regex or document IPv6 limitation.
4. **concurrent Knowledge-Graph persistence** — Test parallel audit+review writes (currently safe by design, but future-proofing).

### P2 (Nice-to-have)
5. **parseCommandArgs escaped quotes** — Add test for `\"` escapes if CI commands need them.
6. **Sub-agent parent_session_id edge cases** — Clarify empty-string vs null semantics.

---

## Confidence & Verdict

**Overall Confidence: 4/5** ✅

**Rationale:**
- ✅ All critical paths (cycle-runner, auth, security) have excellent test coverage
- ✅ Knowledge-graph persistence thoroughly tested (794 lines)
- ✅ 5637 tests passing with no failures
- ✅ Security audit completed and fixed (3 MAJOR bugs found and closed)
- ⚠️  Two medium-risk gaps (known-debt E2E, v6 adapter wiring) should have dedicated tests before shipping
- ⚠️  Several low-risk edge cases (IPv6, escaped quotes) not tested but low probability in practice

**Recommendation:** Ready for internal QA stage with recommended follow-up tests for P0 items before final production release.
