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

First-cycle readiness:

```bash
corepack pnpm build
node packages/cli/dist/bin.js codex readiness --project-root .
```

Single-agent smoke:

```bash
AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js run invoke --agent cli-engineer --task "Return a short readiness summary." --runtime codex-cli
```

PowerShell:

```powershell
$env:AGENTFORGE_RUNTIME = 'codex-cli'
node packages/cli/dist/bin.js run invoke --agent cli-engineer --task "Return a short readiness summary." --runtime codex-cli
```
