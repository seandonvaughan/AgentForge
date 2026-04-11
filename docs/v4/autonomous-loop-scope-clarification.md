# Autonomous Loop — Scope Clarification (2026-04-11)

**Author:** Architect agent
**Status:** NOT-ACTIONABLE as written — decomposed below
**Related decision:** `.agentforge/decisions/2026-04-11T00-00-00-000Z-scope-autoloop.json`
**Authoritative reference:** [`docs/guides/autonomous-loop.md`](../guides/autonomous-loop.md)

---

## The item

> *"The autonomous loop automatically plans, executes, tests, and commits code improvements based on backlog proposals and failure detection."*

Source: `manual` (TODO(autonomous) marker)
Tags: `autonomous-loop`, `planning`, `chore`, `needs-clarification`

## Why it is not actionable

The sentence restates existing behavior, not a deliverable.

| Sub-phrase | Already delivered in | Evidence |
|---|---|---|
| "automatically plans" | v5.4 `WorkflowRunner` + `SprintLoop` | `src/autonomous/workflow-runner.ts`; docs/v4/v4.5-roadmap.md |
| "executes" | v6.4.4 parallel agent dispatch | `src/autonomous/phase-handlers.ts`; memory `project_v644_shipped` |
| "tests" | v5.4 post-exec vitest gate | autonomy gate #4 in `project_v54_autonomous_brief` |
| "commits code improvements" | v6.4.4 Git stage at cycle end | `docs/guides/autonomous-loop.md` §6 |
| "based on backlog proposals" | `.agentforge/backlog/v6-backlog.json` + scanner | backlog scanner in `phase-handlers.ts` |
| "failure detection" | v5.9 auto-recovery agent | `docs/superpowers/specs/2026-04-08-auto-recovery-agent-design.md` |

Every phrase is a shipped capability. Handing this to the Coder agent would either:

1. Duplicate one of the modules above (highest-risk outcome — see the `search.ts` partial-refactor failure recorded in memory `721bd958`, where ambiguity produced a compile-blocking half-refactor), or
2. Drift into speculative "improvement" work with no acceptance criteria.

Neither is acceptable. **Scope narrowed to zero.** No source-code changes are authorized under this backlog item.

## Decomposition for future cycles

If later operators want genuine work in this space, they should pick *one* of the following and file it as its own backlog item with explicit acceptance criteria. None of these are in scope for the current cycle.

### D1. Tighten review-finding regex in `phase-handlers.ts`

- **File:** `src/autonomous/phase-handlers.ts` (around the `extractFindingLines` helper)
- **Problem:** `new RegExp('CRITICAL', 'i')` over-matches prose (recorded failure `60f91d34`, also `295a4fde`)
- **Spec:** Replace with `/^[\s*-]*\[(CRITICAL|MAJOR|MINOR)\]/i` or `/^[-*]\s*\[?(CRITICAL|MAJOR)\b/i`
- **Accept:** Unit test that `"this is not a critical path change"` does **not** match, and `"- [CRITICAL] search.ts broken"` does.

### D2. Guard sprint-schema consumers against the `sprints:[]` wrapper

- **Files:** any site that reads sprint JSON — confirmed readers: `collectSprintItemTags`, `parseReviewFindingMetadata`, `searchSprints`
- **Problem:** Post-v10.2.1 sprint files wrap payload in `{ sprints: [ … ] }`; unaudited readers silently skip domain-tag injection (memory `8fdd37bd`)
- **Spec:** Introduce a single `readSprintPayload(file)` helper that returns the first sprint object regardless of wrapper, and route all readers through it.
- **Accept:** Vitest covering both shapes; grep confirms no direct `JSON.parse(sprintFile)` remains in `src/`.

### D3. Deduplicate `CycleHistoryPoint`

- **Files:** `dashboard-stubs.ts`, `+page.server.ts`, `+page.svelte` (finding `35f26d97`)
- **Spec:** Canonical definition in `dashboard-stubs.ts`; both other sites import it.
- **Accept:** Grep shows a single `interface CycleHistoryPoint` declaration in `src/`.

### D4. Make `--dangerously-skip-permissions` configurable

- **File:** `src/autonomous/run.ts` (~line 217)
- **Spec:** Read from `autonomous.yaml` → `runtime.skipPermissions` (default `true` to preserve today's behavior).
- **Accept:** Setting `runtime.skipPermissions: false` removes the flag from the spawn args; test verifies both branches.

Each of these is a 30–90 minute coder task with a clear compile/test gate. The current item is not.

## Disposition

- This document **is** the deliverable for the current sprint item.
- The decision record at `.agentforge/decisions/2026-04-11T00-00-00-000Z-scope-autoloop.json` captures the rationale in the queryable decision log.
- Coder agent: **do not pick this item up in this cycle.** The Git stage will commit this clarification doc and the decision record at cycle end.
- Backlog curator: replace this item with D1–D4 in the next backlog sweep, or delete it once D1–D4 are filed.
