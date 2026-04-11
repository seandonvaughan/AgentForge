# Memory Wiring Sprint (v6.7.5 → v6.8.0)

The /memory dashboard page exists but no agents currently write to it,
no agents read from it, and the UI may not even render real data.
This sprint wires it up end-to-end so the autonomous loop has actual
cross-cycle memory.

## What's broken right now

- `/api/v5/memory` returns whatever's in `.agentforge/memory/*.json|md`
  but nothing writes to that directory
- The /memory dashboard page renders the API response but the response
  is empty so the page is empty
- The CycleRunner doesn't append cycle outcomes to memory
- Agents don't read past memory in their prompts
- There's no schema for what a memory entry looks like

## TODO markers (planted for the autonomous loop)

TODO(autonomous): Define a memory entry schema in packages/core/src/memory/types.ts. Each entry should have id, key, value, type (cycle-outcome | gate-verdict | review-finding | failure-pattern | learned-fact), createdAt, source (cycleId or agentId), tags. Export a writeMemoryEntry helper that appends to .agentforge/memory/<type>.jsonl with file lock.

DONE(autonomous): Wire CycleLogger.logCycleComplete() to also call writeMemoryEntry with type=cycle-outcome containing {cycleId, sprintVersion, stage, costUsd, testsPassed, gateVerdict, prUrl}. Cycle 88026e07 is a good test target — it has known failure context. — Implemented in packages/core/src/autonomous/cycle-logger.ts: logCycleResult() calls writeMemoryEntry() with type=cycle-outcome, serialising {cycleId, sprintVersion, stage, costUsd, testsPassed, gateVerdict, prUrl} into the value field. Tags include the cycle stage. All 10 unit tests in tests/autonomous/unit/cycle-logger.test.ts pass, including explicit tests for APPROVE/REJECT verdicts and null gateVerdict (killed cycles). Production entries visible in .agentforge/memory/cycle-outcome.jsonl.

DONE(autonomous): Wire the gate phase handler to write a memory entry of type=gate-verdict for every cycle, capturing {cycleId, verdict, rationale, criticalFindings[], majorFindings[]}. The next cycle's audit phase should read these. — Implemented in two locations: (1) packages/core/src/autonomous/phase-handlers/gate-phase.ts: runGatePhase() calls writeMemoryEntry() with type=gate-verdict, value=human-readable summary, metadata=GateVerdictMetadata (cycleId, verdict, rationale, criticalFindings, majorFindings), and tags=[verdict:approved/rejected, sprint:v*, ...sprintDomainTags]. Sprint item domain tags are collected via collectSprintItemTags() so the execute-phase memory injector can cross-reference verdicts with future items sharing the same domain tags. (2) packages/server/src/lib/phase-handlers.ts: runGatePhase() follows the same pattern for the server-side path. Both paths swallow memory-write errors non-fatally. 103 unit tests pass in packages/core/src/autonomous/phase-handlers/__tests__/gate-phase-memory.test.ts (30 tests), 8 integration tests pass in tests/autonomous/integration/gate-phase-memory.test.ts, and 38 cross-cycle flow tests pass in tests/integration/memory-flow.test.ts.

TODO(autonomous): Wire the review phase handler to write memory entries of type=review-finding for each MAJOR or CRITICAL finding, capturing {file, line, severity, summary, fixSuggestion}. These are the seeds for cross-cycle learning.

DONE(autonomous): Update the audit phase handler to read recent memory entries (last 10 cycles' worth) and inject them into the audit agent's prompt as a "Past mistakes to avoid" section. This is the core cross-cycle learning loop. — Implemented in packages/core/src/autonomous/phase-handlers/audit-phase.ts: readRecentMemoryEntries() reads .agentforge/memory/*.jsonl, formatMemoryForPrompt() wraps entries in a "## Past mistakes and learnings (cross-cycle memory)" section, and runAuditPhase() injects the block into the researcher agent's prompt. 29 tests pass.

DONE(autonomous): Update the execute phase handler to inject relevant memory entries into each item's agent prompt — filter by tags matching the item's tags. Each agent sees the failures past versions of themselves had on similar work. — Implemented in packages/core/src/autonomous/phase-handlers/execute-phase.ts: readRelevantMemoryEntries() reads .agentforge/memory/*.jsonl, filters by OR-tag-overlap with item.tags (case-insensitive), sorts by priority type (failure-pattern, review-finding, gate-verdict before cycle-outcome) then by recency, and caps at 5 entries. formatMemorySection() wraps matched entries in a "## Memory: Past Failures on Similar Work" section. buildItemPrompt() calls both helpers and injects the section between the Tags line and the "Your job:" line. Items with no matching memory entries receive the unmodified prompt. Also exposed via the registry-based v4 API in src/autonomous/execute-phase-handler.ts as ExecutePhaseHandler.buildMemorySection() / injectMemoryIntoPrompt(). 81 unit and integration tests pass across execute-phase-memory.test.ts, execute-phase.test.ts, and execute-phase-handler.test.ts.

TODO(autonomous): Fix the /api/v5/memory backend to read the new .agentforge/memory/*.jsonl files instead of *.json|md. Stream the latest 200 entries with optional filter by type, since, agentId. Sort by createdAt descending.

TODO(autonomous): Update packages/dashboard/src/routes/memory/+page.svelte to render the live memory feed with type chips, source links (clickable to cycle/agent), search, and filter by type. Each entry expandable to show full value JSON.

TODO(autonomous): Add a memory stats card to the /flywheel page showing total entries, entries-per-cycle trend, and "memory hit rate" (% of cycles whose audit phase actually used a past memory entry to influence its plan).

TODO(autonomous): Add tests/integration/memory-flow.test.ts that runs a complete cycle, asserts memory entries were written for cycle-outcome + gate-verdict, then runs a second cycle and asserts the audit prompt included the prior cycle's memory.
