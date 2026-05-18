# Wave 5 Shipped — Night-Shift Arc Summary

Over a single continuous night-shift session (2026-05-17 → 2026-05-18), five waves of work were completed against the AgentForge v23.5 milestone. Waves 1-4 each targeted a distinct operational concern — resumability, skill curation, MCP exposure, and durability observability — while Wave 5 added the unattended-mode safety guards, a replay/coverage CLI, and the autonomous skill flywheel pipeline. All waves landed on `main` via atomic commits with full test coverage; the combined effort brought total tests to approximately 5,900+, with every CI gate green.

## Wave Summary Table

| Wave | Focus | Key Features | Related Docs |
|------|-------|--------------|--------------|
| Wave 1 (T1) | Per-item resume | Checkpoint file per cycle item; `--resume` flag; stale-checkpoint detection (>24 h warns, >72 h blocks) | [Unattended Cycle Runbook](runbooks/unattended-cycle.md) |
| Wave 2 (T2) | Skill flywheel — propose | `agentforge skills propose-from-learnings`; proposals persisted to `.agentforge/flywheel/proposals/`; `/flywheel/proposals` dashboard UI | [Skill Flywheel Runbook](runbooks/skill-flywheel.md) |
| Wave 3 (T3) | MCP server | `packages/mcp/` stdio MCP server; `agentforge/list_agents`, `agentforge/run_cycle`, `agentforge/get_status`, `agentforge/get_memory` tools | [API Reference](api-reference.md) |
| Wave 4 (T4) | `/durability` dashboard | New `/durability` SvelteKit page; checkpoint ring, guard status panel, resume controls; wired to `/api/v5/durability` endpoint | [Autonomous Loop Guide](guides/autonomous-loop.md) |
| Wave 5 (T5 + T6 + T7 + T8) | Unattended guards, replay CLI, flywheel approve | 5 pre-flight guards (`AGENTFORGE_UNATTENDED=1`); `agentforge cycle replay`/`coverage`; `/flywheel/proposals` approve/reject/revert UX | This document |

## Cross-Links

- [Unattended Cycle Runbook](runbooks/unattended-cycle.md) — pre-flight checklist and guard-failure recovery
- [Skill Flywheel Runbook](runbooks/skill-flywheel.md) — how to triage and approve skill proposals
- [Autonomous Loop Guide](guides/autonomous-loop.md) — 9-phase cycle internals
- [Configuration Reference](guides/autonomous-config-reference.md) — `autonomous.yaml` full reference
