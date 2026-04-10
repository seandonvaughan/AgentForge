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

TODO(autonomous): Wire CycleLogger.logCycleComplete() to also call writeMemoryEntry with type=cycle-outcome containing {cycleId, sprintVersion, stage, costUsd, testsPassed, gateVerdict, prUrl}. Cycle 88026e07 is a good test target — it has known failure context.

TODO(autonomous): Wire the gate phase handler to write a memory entry of type=gate-verdict for every cycle, capturing {cycleId, verdict, rationale, criticalFindings[], majorFindings[]}. The next cycle's audit phase should read these.

TODO(autonomous): Wire the review phase handler to write memory entries of type=review-finding for each MAJOR or CRITICAL finding, capturing {file, line, severity, summary, fixSuggestion}. These are the seeds for cross-cycle learning.

DONE(autonomous): Update the audit phase handler to read recent memory entries (last 10 cycles' worth) and inject them into the audit agent's prompt as a "Past mistakes to avoid" section. This is the core cross-cycle learning loop. — Implemented in packages/core/src/autonomous/phase-handlers/audit-phase.ts: readRecentMemoryEntries() reads .agentforge/memory/*.jsonl, formatMemoryForPrompt() wraps entries in a "## Past mistakes and learnings (cross-cycle memory)" section, and runAuditPhase() injects the block into the researcher agent's prompt. 29 tests pass.

TODO(autonomous): Update the execute phase handler to inject relevant memory entries into each item's agent prompt — filter by tags matching the item's tags. Each agent sees the failures past versions of themselves had on similar work.

TODO(autonomous): Fix the /api/v5/memory backend to read the new .agentforge/memory/*.jsonl files instead of *.json|md. Stream the latest 200 entries with optional filter by type, since, agentId. Sort by createdAt descending.

TODO(autonomous): Update packages/dashboard/src/routes/memory/+page.svelte to render the live memory feed with type chips, source links (clickable to cycle/agent), search, and filter by type. Each entry expandable to show full value JSON.

TODO(autonomous): Add a memory stats card to the /flywheel page showing total entries, entries-per-cycle trend, and "memory hit rate" (% of cycles whose audit phase actually used a past memory entry to influence its plan).

TODO(autonomous): Add tests/integration/memory-flow.test.ts that runs a complete cycle, asserts memory entries were written for cycle-outcome + gate-verdict, then runs a second cycle and asserts the audit prompt included the prior cycle's memory.
