# Using AgentForge from Claude Code sessions

AgentForge is operable from inside any Claude Code session: forge a team,
rehearse and launch cycles, watch progress, dispatch individual forged agents,
and query the project's knowledge base and memory — all through the
`agentforge` MCP server and the forged `.claude/agents` mirrors.

## One-time setup

```bash
corepack pnpm build          # builds packages/mcp-server/dist
agentforge claude setup --project-root /path/to/your-project
```

`claude setup` does two idempotent things:

1. Merges an `agentforge` entry into the project's `.mcp.json` (other servers
   are preserved) pointing at the AgentForge MCP server with
   `AGENTFORGE_PROJECT_ROOT` set.
2. Re-emits any missing `.claude/agents/<id>.md` mirrors from the committed
   `.agentforge/agents/*.yaml` files. `.claude/` is gitignored, so fresh
   clones have the YAMLs but not the mirrors. The `fable` tier is written as
   the full `claude-fable-5` model id (Claude Code has no `fable` alias).

Open a Claude Code session in the project afterwards — the MCP tools and the
forged subagents are available immediately.

## MCP tools

| Tool | What it does | Cost |
|---|---|---|
| `af_cycle_preview` | Signal-backlog preview, or — with `objective` — a full epic-decomposition rehearsal returning children/waves/budget-band JSON | objective mode ≈ $5 (one planner call) |
| `af_cycle_status` | List recorded cycles or show one cycle's summary + artifacts | free |
| `af_cycle_events` | Cursor-based incremental tail of a cycle's `events.jsonl` — poll during long cycles, pass `nextCursor` back | free |
| `af_agent_invoke` | Dispatch ONE forged agent with a **required budget cap** (≤ $25) and optional tool allowlist | capped by you |
| `af_agent_dispatch` | Recommend the best forged agent for capability tags | free |
| `af_kb_search` | Keyword search over the project knowledge base notes (review/audit/learn findings) | free |
| `af_kb_lookup` | Fetch a KB document by id (requires the dashboard server running) | free |
| `af_memory_query` | Top-k search over `.agentforge/memory/*.jsonl` | free |
| `af_codex_readiness` | Codex runtime readiness report | free |

## Recommended session workflow

1. **Ground yourself:** `af_cycle_status` for recent cycles, `af_kb_search`
   for what prior cycles learned about the area you're touching.
2. **Rehearse before you spend:** `af_cycle_preview {objective, budgetUsd}` —
   inspect the children, waves, file overlaps, and whether the plan lands in
   the budget band. ~$5 instead of a blind $150–300 launch.
3. **Launch from a terminal** (`agentforge cycle run --objective "..."`) —
   cycle launches stay deliberate; the MCP surface intentionally has no
   "start cycle" tool.
4. **Monitor:** poll `af_cycle_events {cycleId, cursor}` and re-check
   `af_cycle_status`; the dashboard (`agentforge start`) shows live per-item
   progress, instructions, and per-agent stats.
5. **Spot work:** `af_agent_invoke {agentId, task, budgetUsd}` for one-off
   tasks by a forged specialist — e.g. ask `epic-planner` (fable tier) to
   critique a plan, or `coder` to make a scoped fix.

## Forged agents as Claude Code subagents

Forge writes a `.claude/agents/<id>.md` mirror per agent (frontmatter +
system prompt). Inside a session you can delegate directly to them with the
Task tool — they carry the same prompts, tool defaults, and model tiers as
the autonomous loop, including each agent's baked learnings.

## Notes

- All MCP tools are pinned to `AGENTFORGE_PROJECT_ROOT`; requests for other
  roots are rejected (`PROJECT_ROOT_NOT_ALLOWED`).
- `af_agent_invoke` refuses uncapped runs — `budgetUsd` is schema-required.
- The plugin manifest (`.claude-plugin/plugin.json`) registers the same MCP
  server plus the `commands/` slash commands for plugin installs.
