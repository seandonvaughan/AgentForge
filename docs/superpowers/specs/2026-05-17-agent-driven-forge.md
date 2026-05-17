# Agent-Driven Forge & Reforge — Opus writes the team

**Author:** Claude (Opus 4.7, 1M context)
**Date:** 2026-05-17
**Status:** Approved — implementation kicks off in v18.0.0
**Supersedes:** the deterministic forge pipeline (file-scanner → heuristic team composer → template-substitution customizer)

---

## The problem — concrete evidence

Inspection of the *current* AgentForge team after the v10.7 fresh forge produced these defects:

1. **`api-specialist.yaml` says "You are the Coder agent"** — every "specialist" is a clone of `coder.yaml` with the name swapped. There is no actual specialization.
2. **`coder.yaml` claims familiarity with "Django, FastAPI, Flask, Gin, Actix, Fiber"** — none of which exist in this codebase. The file-scanner regex-matched framework names inside `docs/superpowers/specs/*.md` (which use them as illustrative examples).
3. **`frontend-dev.yaml` still says "vanilla HTML/CSS/JS, zero external dependencies"** — but the actual dashboard is SvelteKit + Svelte 5 runes + TypeScript. Hasn't been updated since v0.
4. **`coder.yaml` system prompt has broken template substitutions** — `"As of version , the canonical product stack is under :"` (empty version, empty stack — the placeholders never resolved).
5. **One generalist absorbs all the work.** Last cycle (v17.0.0) routed 9 of 25 sprint items to `coder`; 16 of 25 went to just 4 agents total. The other 33 forged agents sat idle.
6. **`assign-phase.ts:inferAssigneeFromTag` knows 5 keywords** — `fix|bug|security → coder`, `feature → coder`, `docs → backend-tech-writer`, `architecture → architect`, `test → backend-qa`. Everything else defaults to `coder`. The 37-agent roster is invisible to the router.

**Root cause:** the entire forge pipeline is deterministic regex+heuristic. It doesn't *read* the project — it pattern-matches against the project. The output reflects that.

---

## Goals

1. **Intelligence drives forging.** Opus reads the project and *writes each agent's system prompt*.
2. **Multiple agents collaborate on reconnaissance.** Sonnet-class scanners do the legwork in parallel; Opus only synthesizes.
3. **Every forged agent is a real specialist.** The system prompt mentions specific subsystems, specific file paths, specific tools, specific conventions — derived from the codebase, not inherited from a generic template.
4. **Routing is roster-aware.** The assign-phase consults the actual team and picks the most-specialized agent for each item.
5. **Reforge is incremental.** A second run only updates agents whose subsystem/learnings actually changed.

---

## High-level architecture

```
                  ┌─────────────────────────────────────┐
                  │      forge / reforge entrypoint     │
                  └─────────────────┬───────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
    Phase A: Recon            Phase A: Recon          Phase A: Recon
    (parallel agents,         (parallel agents,       (parallel agents,
     Sonnet/Haiku)             Sonnet/Haiku)            Sonnet/Haiku)
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    ▼
                          Phase B: Synthesis (Opus)
                          • Reads all recon outputs
                          • Decides roster
                          • Writes each agent's
                            system prompt
                          • Writes team.yaml
                                    │
                                    ▼
                       Phase C: Validation (Sonnet)
                       • Verifies file paths exist
                       • Verifies subsystem refs are real
                       • Flags hallucinations
                                    │
                                    ▼
              Phase D: Routing layer update (deterministic)
              • Build capability-tag index from agents
              • Update assign-phase router
```

### Phase A — Recon (parallel Sonnet/Haiku agents)

Five agents, each producing a structured JSON artifact under
`.agentforge/forge/recon/`:

| Agent | Output | Model |
|---|---|---|
| **`code-archaeologist`** | `subsystems.json` — package boundaries, ownership, public surface | Sonnet |
| **`dep-graph-analyst`** | `dependencies.json` — real prod/dev deps, lockfile, framework usage proven by import graph | Haiku |
| **`convention-detective`** | `conventions.json` — formatter, linter rules in effect, test runner, common file structures, naming | Haiku |
| **`domain-mapper`** | `domain.json` — what this product IS, who uses it, the business domain language, the user-facing primitives | Sonnet |
| **`failure-historian`** | `history.json` — recurring bug patterns, gate-verdict trends, cycle-cost outliers (read from `.agentforge/memory/*.jsonl` + last 90 days of `git log`) | Sonnet |

Each agent has a tight, structured prompt and a Zod schema for its output —
the agent is **required** to emit JSON that matches the schema or it fails.

### Phase B — Synthesis (Opus)

A single Opus call takes the five recon JSONs and a corpus of representative
source files (selected by recon — the top-N files by load-bearing-ness per
subsystem) and produces:

1. **`team-plan.json`** — the roster as a structured spec:
   ```jsonc
   {
     "team_name": "...",
     "agents": [
       {
         "id": "fastify-route-engineer",
         "tier": "sonnet",
         "owns_subsystems": ["packages/server/src/routes/v5"],
         "system_prompt": "<full markdown prompt>",
         "capability_tags": ["fastify", "rest", "route", "v5-api"],
         "auto_include_files": ["packages/server/src/server.ts", ...],
         "learnings_seed": [...]
       },
       ...
     ]
   }
   ```
2. **`team.yaml`** — emitted from `team-plan.json`.
3. **`.agentforge/agents/<id>.yaml`** — one file per agent, with the full
   Opus-written system prompt.
4. **`.claude/agents/<id>.md`** — same content in CC-compatible format (so
   the same agent can be invoked via the CC `Agent` tool — see the
   "5-cycle arc" spec for parity context).

The Opus prompt is the load-bearing artifact. It will be the
`packages/core/src/team/engine/builder/synthesis-prompt.md` template.

### Phase C — Validation (Sonnet)

`team-validator` agent reads every generated agent file and checks:

- Every `auto_include_files` path actually exists on disk
- Every `owns_subsystems` path is a real directory
- Every system-prompt file-path reference resolves to a real file
- The agent's role description doesn't contradict the project domain (e.g.
  no "Django specialist" if there's no Django in the project)
- The system prompt isn't a verbatim clone of another agent

Flagged issues go back to Opus for one corrective pass, then Phase D
proceeds even if some warnings remain (they're tracked, not blocking).

### Phase D — Routing layer update

This phase is deterministic — once the team is written, the router needs to
know how to find each agent.

- **Capability-tag index:** `.agentforge/routing-index.json` mapping tags →
  agent IDs, built from every agent's `capability_tags`.
- **`assign-phase.ts` rewrite:** instead of a 5-keyword switch, it:
  1. Tokenizes the sprint item (title + tags + auto-detected file paths from
     mentions of `packages/...` or `src/...`)
  2. Looks up matching agents by tag and by subsystem ownership
  3. Picks the most-specialized match (smallest `owns_subsystems` footprint
     that still covers the item)
  4. Falls back to `coder` only when no specialist matches AND no tag matches
     AND no path matches

---

## Cost model

A full forge cycle, estimated:

| Phase | Calls | Tokens (in/out) | Cost |
|---|---|---|---|
| Recon — code-archaeologist | 1 × Sonnet | 30k / 8k | $0.18 |
| Recon — dep-graph-analyst | 1 × Haiku | 15k / 3k | $0.018 |
| Recon — convention-detective | 1 × Haiku | 20k / 4k | $0.025 |
| Recon — domain-mapper | 1 × Sonnet | 25k / 6k | $0.14 |
| Recon — failure-historian | 1 × Sonnet | 18k / 5k | $0.10 |
| Synthesis — Opus | 1 × Opus | 80k / 25k | $2.10 |
| Validation — Sonnet | 1 × Sonnet | 40k / 6k | $0.20 |
| **Total per forge** | | | **~$2.80** |

This compares to the *cycle* cost (typically $15-30) — a single forge is
cheaper than one cycle item. Reforge is incremental and is expected to be
50-70% cheaper (only changed subsystems get re-analyzed).

For external project onboarding, $2.80 is well below the
"first-impressions cost" threshold.

---

## Reforge — incremental updates

Reforge differs from forge in three places:

1. **Recon agents skip unchanged subsystems.** Each agent persists a hash of
   its inputs; if the hash matches the previous run, the output is reused.
2. **Synthesis only rewrites agents whose owned subsystems changed.**
   Unchanged agents keep their existing system prompt (and accumulated
   learnings — see `feedback_always_use_team`).
3. **Failure-historian always re-runs.** The memory store grows monotonically
   and the latest learnings are always worth incorporating.

A reforge after a typical 25-item cycle is expected to touch 2-5 agents,
not all 30+.

---

## Implementation breakdown

### Cycle 1 deliverables (v18.0.0)

- [ ] `packages/core/src/team/engine/builder/recon/` package — 5 recon agent
      definitions + Zod schemas for their outputs
- [ ] `packages/core/src/team/engine/builder/synthesis.ts` — Opus invocation
      that consumes recon outputs and produces `team-plan.json`
- [ ] `synthesis-prompt.md` — the Opus system prompt (the load-bearing
      artifact; will iterate based on actual output quality)
- [ ] `validation.ts` — Sonnet agent that fact-checks the generated agents
- [ ] **CLI integration:** `forge` and `reforge` use this pipeline by
      default; old deterministic forge stays available as
      `forge --legacy` for fallback
- [ ] **Required `pr-merge-manager` role** — Synthesis prompt explicitly
      adds this even if no recon agent requested it
- [ ] **Capability-tag routing:** `assign-phase.ts` rewrite consuming
      `.agentforge/routing-index.json`
- [ ] **Tests:**
  - Each recon agent's Zod schema (no LLM call — fixture-driven)
  - Synthesis happy-path (mocked Opus response → expected files)
  - Validation flags hallucinated file paths
  - End-to-end: tiny test repo → forge → roster matches expectations
  - Router picks specialist over generalist when tags/path overlap
- [ ] **Telemetry:** track per-agent-per-cycle utilization. After Cycle 1
      ships, the dashboard's `/flywheel` view should show *utilization
      spread* — i.e., how flat the histogram of items-per-agent is. The
      goal is more spread; currently it's heavily skewed to `coder`.

### Validation milestone — "the v17 cycle, re-routed"

Take the v17.0.0 sprint plan (25 items, currently 9 routed to coder) and
re-route it through the new specialist-aware router. **Success criterion:**
the top-1 agent gets ≤4 items (vs. current 9), and ≥80% of items get a
non-`coder` specialist.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Opus hallucinates file paths in agent prompts | Phase C validation; one corrective pass; fall back to safe defaults |
| Forge becomes expensive ($2.80 × every external project) | Reforge incremental + cache recon outputs by content hash |
| Specialization explosion (Opus emits 200 agents) | Hard cap in synthesis prompt: 12-30 agents, justify each |
| Specialists too narrow — nothing to do | Capability tags can overlap; multiple agents can claim the same subsystem with different "concerns" (engineer vs. reviewer) |
| Backward compatibility breakage | Old deterministic forge stays available as `--legacy`; v17.x consumers keep working |

---

## Why this is core functionality

Per user direction (2026-05-17): *"This is the feature we want to work the
best, it is core functionality. It needs to keep getting better."*

The current forge produces agents that *claim* specialization but actually
share one generic prompt. Every other AgentForge feature — autonomous
cycles, learning curation, routing, the Claude Code parity layer — assumes
the agents are real specialists. If forge doesn't deliver real
specialization, the rest of the system can't deliver real value.

This spec is the foundation for v18-v22 and the AgentForge Cloud
product launch.
