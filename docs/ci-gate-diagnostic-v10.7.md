# CI Gate Diagnostic Report — main → v10.7.0

**Date:** 2026-05-16  
**Branch:** main  
**Version:** 10.5.1  
**Command audited:** `pnpm verify:gates`

---

## Executive Summary

`pnpm verify:gates` exits **0** on main. All sub-gates pass. Full test suite (5,614 tests, 305 files) passes with zero failures. **No genuine regressions found. No stale failures to triage. v10.7.0 convergence gate: CLEAR.**

---

## Gate-by-Gate Results

| Gate | Command | Result | Exit Code | Notes |
|---|---|---|---|---|
| Lint | `pnpm lint` | ✅ PASS | 0 | 0 errors, 0 warnings |
| Version sync | `pnpm check:versions` | ✅ PASS | 0 | 10.5.1 in sync across root + packages |
| TypeScript build | `pnpm build` (tsc -b) | ✅ PASS | 0 | 0 errors across all 9 packages |
| Dashboard typecheck | `pnpm dashboard:check` | ✅ PASS | 0 | 0 ERRORS; 64 WARNINGS (pre-existing baseline, see below) |
| Dashboard build | `pnpm dashboard:build` | ✅ PASS | 0 | Build succeeds, all chunks emitted |
| CLI help | `pnpm check:help` | ✅ PASS | 0 | — |
| Changelog | `pnpm check:changelog` | ✅ PASS | 0 | 10.5.1 entry present |
| Dep audit | `pnpm audit:deps` | ✅ PASS | 0 | 0 known vulnerabilities |
| **Full gate** | `pnpm verify:gates` | ✅ **PASS** | **0** | — |

---

## Test Suite

| Metric | Value |
|---|---|
| Test files | 305 |
| Total tests | 5,614 |
| Passed | 5,614 |
| Failed | **0** |
| Command | `pnpm test:run` |
| Duration | ~42 s |

---

## Failure Classification

### Genuine Regressions
*None.*

### Stale / Pre-existing (not failures)
| Item | Classification | Evidence |
|---|---|---|
| 64 `svelte-check` warnings in dashboard | **STALE / BASELINE** | Same 64 warnings present since v6.5–v10.5 UI build (documented in gate-verdict `341a0c61`). svelte-check exits 0. All are style/a11y advisory; zero are type errors. No new warnings introduced by v10.7.0 work. |
| First-run TS1232 in `progress-events.test.ts:315` | **TRANSIENT / CACHE ARTIFACT** | Error appeared only on first run against a stale `.tsbuildinfo` incremental cache. Disappeared on next `tsc -b` invocation. Line 315 is `const memDir = join(...)` — not an import. All subsequent runs clean. |
| Node engine WARN (`>=22.13.0`, current v22.9.0) | **STALE / ENV MISMATCH** | Dev machine runs Node v22.9.0; package.json requires `>=22.13.0`. Non-blocking (pnpm proceeds with WARN). CI matrix pins the correct Node version. |

---

## svelte-check Warning Breakdown (64 total, 0 errors)

All 64 warnings are advisory and pre-existing:

| Category | Count | Files |
|---|---|---|
| `state_referenced_locally` (Svelte 5 runes) | ~45 | `+page.svelte` across ~20 routes |
| `a11y_*` (interactive role / keyboard handler) | ~10 | `cycles/`, `settings/`, `webhooks/`, `branches/` |
| `a11y_consider_explicit_label` | 4 | `settings/autonomous/`, `settings/notifications/` |
| CSS non-standard / empty ruleset | 2 | `memory/+page.svelte`, `branches/+page.svelte` |
| Unknown property (`spellcheck`) | 1 | `agents/[id]/+page.svelte` |
| Other (`a11y_no_noninteractive_tabindex`) | 2 | `org/+page.svelte`, `settings/security/` |

No warning is a blocking typecheck error. All existed before this sprint.

---

## Conclusion

The v10.7.0 convergence goal — "one clean CI run on main" — is met. The fix backlog derived from this diagnostic is empty (no genuine regressions). The 64 svelte-check warnings are tracked as known pre-existing technical debt and do not require action before v10.7.0 ships.

**Recommended next action:** Proceed with v10.7.0 release gate. Carry svelte-check warning reduction to the v10.8.0 or v11.0.0 backlog.
