---
name: agentforge-runtime
description: Invoke AgentForge agents through the Codex CLI runtime and inspect model-tier mapping.
---

# AgentForge Runtime

Use this skill when a user wants to invoke one generated AgentForge agent from Codex or inspect how AgentForge maps agents to Codex models.

## Commands

```bash
corepack pnpm build
node packages/cli/dist/bin.js codex readiness --project-root .
AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js run invoke --project-root . --runtime codex-cli --agent <agent-id> --task "<task>"
```

PowerShell:

```powershell
$env:AGENTFORGE_RUNTIME = 'codex-cli'
node packages/cli/dist/bin.js run invoke --project-root . --runtime codex-cli --agent <agent-id> --task "<task>"
```

When running from a Codex plugin cache, set `AGENTFORGE_PROJECT_ROOT` to the
AgentForge repo root before starting Codex. If MCP diagnostics mention missing
`packages/mcp-server/dist/index.js` or `packages/cli/dist/bin.js`, run
`corepack enable && corepack pnpm install && corepack pnpm build` in that repo.

AgentForge keeps `opus`, `sonnet`, and `haiku` as capability tiers. For Codex v1 the default runtime mapping is:

| Tier | Codex model | Reasoning effort |
| --- | --- | --- |
| `opus` | `gpt-5.5` | `xhigh` |
| `sonnet` | `gpt-5.3-codex` | `high` |
| `haiku` | `gpt-5.4-mini` | `medium` |

These defaults can be overridden by `.agentforge/config/models.yaml` or `AGENTFORGE_CODEX_*` environment variables.
