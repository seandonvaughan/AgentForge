---
name: agentforge-runtime
description: Invoke AgentForge agents through the Codex CLI runtime and inspect model-tier mapping.
---

# AgentForge Runtime

Use this skill when a user wants to invoke one generated AgentForge agent from Codex or inspect how AgentForge maps agents to Codex models.

## Commands

```bash
node packages/cli/dist/bin.js codex readiness --project-root .
AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js run invoke --project-root . --runtime codex-cli --agent <agent-id> --task "<task>"
```

PowerShell:

```powershell
$env:AGENTFORGE_RUNTIME = 'codex-cli'
node packages/cli/dist/bin.js run invoke --project-root . --runtime codex-cli --agent <agent-id> --task "<task>"
```

AgentForge keeps `opus`, `sonnet`, and `haiku` as capability tiers. For Codex v1 those tiers resolve to `gpt-5.5` with `xhigh` effort, `gpt-5.3-codex` with `high` effort, and `gpt-5.4-mini` with `medium` effort respectively, unless overridden by `.agentforge/config/models.yaml` or `AGENTFORGE_CODEX_*` environment variables.
