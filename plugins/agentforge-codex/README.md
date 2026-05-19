# AgentForge Codex Plugin

This plugin is the Codex host surface for AgentForge. It shares the existing
AgentForge packages and MCP server while routing local agent execution through
`AGENTFORGE_RUNTIME=codex-cli`.

Install from this repo-local marketplace:

```bash
codex plugin marketplace add .
codex plugin install agentforge-codex@agentforge-local
```

If Codex launches the plugin MCP server from its plugin cache, set
`AGENTFORGE_PROJECT_ROOT` to this repository root before starting Codex.
The cached plugin runner validates that the root contains
`packages/mcp-server/dist/index.js`; if it cannot find it, rebuild from the
repo with Corepack-managed pnpm:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

PowerShell:

```powershell
$env:AGENTFORGE_PROJECT_ROOT = 'C:\Users\SeanVaughan\Projects\AgentForge'
corepack enable
corepack pnpm install
corepack pnpm build
```

If MCP startup succeeds but Codex workflow tools report `CLI_NOT_BUILT`, the
server was found but `packages/cli/dist/bin.js` is missing. Run
`corepack pnpm build` at `AGENTFORGE_PROJECT_ROOT` and restart Codex.

First-cycle readiness:

```bash
corepack pnpm build
node packages/cli/dist/bin.js codex readiness --project-root .
```

MCP tools exposed by this plugin:

| Tool | Behavior |
| --- | --- |
| `af_codex_readiness` | Returns `agentforge codex readiness --json`; accepts optional `projectRoot` and `skipLogin`. |
| `af_cycle_preview` | Runs the existing `agentforge cycle preview` path and does not start a cycle. |
| `af_cycle_status` | Lists or shows recorded `.agentforge/cycles` state without starting work. |

Single-agent smoke:

```bash
AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js run invoke --agent cli-engineer --task "Return a short readiness summary." --runtime codex-cli
```

Default Codex runtime tier mapping:

| AgentForge tier | Codex model | Reasoning effort |
| --- | --- | --- |
| `opus` | `gpt-5.5` | `xhigh` |
| `sonnet` | `gpt-5.3-codex` | `high` |
| `haiku` | `gpt-5.4-mini` | `medium` |

PowerShell:

```powershell
$env:AGENTFORGE_RUNTIME = 'codex-cli'
node packages/cli/dist/bin.js run invoke --agent cli-engineer --task "Return a short readiness summary." --runtime codex-cli
```
