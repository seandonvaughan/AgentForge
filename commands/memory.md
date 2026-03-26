---
description: Query and manage the agent memory registry and knowledge base
argument-hint: Subcommand — search <query> | list | store | decay | expire | stats
---

# AgentForge Memory

Manage the persistent memory registry — the central store of agent knowledge, learnings, mistakes, and preferences.

## Subcommands

- `search <query>` — Semantic search across all memories (keyword fallback below 0.60 threshold)
- `list` — List all memory entries (filterable: `--agent <id>`, `--category <cat>`)
- `store --agent <id> --category <cat> --summary <text> --tags <t1,t2>` — Store a new memory
- `decay` — Apply time-based relevance decay to all entries
- `expire` — Remove entries past their expiration date
- `stats` — Storage usage report (total entries, per-agent counts, governor status)

## What to Do

1. Import `MemoryRegistry` from `src/registry/memory-registry.ts`
2. Import `SemanticSearch` from `src/memory/semantic-search.ts`
3. Import `StorageGovernor` from `src/registry/storage-governor.ts`
4. For `search`: use `SemanticSearch.search()` — displays hits with scores, confidence flags, and strategy used
5. For `list`: use `registry.getAll()`, `getByAgent()`, or `getByCategory()`
6. For `store`: use `registry.store()` — also register with StorageGovernor
7. For `decay`: use `registry.applyDecay()` — reduces relevance scores based on time since last access
8. For `expire`: use `registry.removeExpired()` — purges entries past their `expiresAt` timestamp
9. For `stats`: use `governor.getUsageReport()` — shows total files, limit, per-agent quotas

## Memory Categories

- `learning` — Pattern learned from task outcomes
- `research` — External knowledge acquired via research
- `mistake` — Error record with corrective action
- `preference` — User or team preference
- `relationship` — Agent-to-agent collaboration data

## Semantic Search Thresholds

- **≥ 0.82** — High confidence results
- **0.60–0.82** — Low confidence, flagged for review
- **< 0.60** — Automatic keyword fallback
- **≥ 0.95** — Deduplication candidate

## MCP Access

Memories are also accessible as MCP resources via `MCPMemoryProvider` (`src/memory/mcp-memory-provider.ts`). URI scheme: `memory://{entryId}`
