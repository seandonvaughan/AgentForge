---
name: agentforge-plugin-maintenance
description: Validate AgentForge Codex marketplace installs, MCP startup, version sync, and plugin cache-root diagnostics.
---

# AgentForge Plugin Maintenance

Use this skill when maintaining or validating the AgentForge Codex plugin,
especially after packaging, marketplace install, cache relocation, or version
sync changes.

## Checks

1. Confirm version sync:

```bash
corepack pnpm check:versions
```

2. Build the repo with Corepack-managed pnpm:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

3. Validate plugin-cache root resolution:

```bash
AGENTFORGE_PROJECT_ROOT=. node plugins/agentforge-codex/mcp/agentforge-mcp-runner.mjs
```

PowerShell:

```powershell
$env:AGENTFORGE_PROJECT_ROOT = (Get-Location).Path
node plugins/agentforge-codex/mcp/agentforge-mcp-runner.mjs
```

The runner must resolve `AGENTFORGE_PROJECT_ROOT` to the AgentForge repo root
and find `packages/mcp-server/dist/index.js`. Codex workflow MCP tools also
need `packages/cli/dist/bin.js`; if it is missing, rebuild before testing
`af_codex_readiness` or `af_cycle_preview`.

4. Validate marketplace install from the repo-local marketplace:

```bash
codex plugin marketplace add .
codex plugin install agentforge-codex@agentforge-local
```

5. Smoke-test read-only MCP surfaces after the plugin starts:

- `af_codex_readiness` with `{ "skipLogin": true }`
- `af_cycle_preview` with the target `projectRoot`
- `af_cycle_status` with no `cycleId`, then with one returned cycle id

Do not use plugin maintenance checks to start autonomous work. `af_cycle_run`
and direct agent execution require an explicit user confirmation path before
implementation or invocation.
