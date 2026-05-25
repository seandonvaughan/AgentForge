# AgentForge Runtime Modes

AgentForge supports multiple runtime modes across Claude and Codex transports,
selected via the `AGENTFORGE_RUNTIME` environment variable or the `runtime:`
field in `.agentforge/autonomous.yaml`.

---

## Primary modes

| Mode | Value | Transport registered | Best for |
|---|---|---|---|
| SDK only | `sdk` | `AnthropicSdkTransport` only | AgentForge Cloud, CI, any environment where the `claude` CLI is not installed |
| CLI only | `cli` | `ClaudeCodeCompatTransport` only | Local Claude Code users who want to guarantee the CLI path |
| Auto (default) | `auto` | Both | Local development; falls back gracefully when only one transport is available |

## Full `resolveMode()` contract

`resolveMode()` accepts and can return the full `RuntimeMode` union:

- `auto`
- `sdk` (compat alias for Anthropic SDK routing)
- `cli` (compat alias for Claude CLI routing)
- `anthropic-sdk`
- `claude-cli`
- `claude-code-compat`
- `codex-cli`
- `openai-sdk`

### `auto` (default)

Both transports are registered. The `ProviderResolver` selects one at runtime:

- When `allowedTools` are requested it always picks the CLI transport (tool execution
  requires the Claude Code subprocess).
- Otherwise it prefers the SDK transport when `ANTHROPIC_API_KEY` is present.
- Falls back to the CLI transport when the API key is absent but `claude` is on PATH.

### `sdk`

Only `AnthropicSdkTransport` is registered.  Requires `ANTHROPIC_API_KEY` (or an
explicit `apiKey` on the request).  No `claude` subprocess is ever spawned.

**This is the required mode for AgentForge Cloud**, which sets
`AGENTFORGE_RUNTIME=sdk` in its container environment and has no Claude Code CLI.

### `cli`

Only `ClaudeCodeCompatTransport` is registered.  Requires the `claude` binary to be
authenticated and on PATH.  Useful when you explicitly want to exercise the Claude
Code path (e.g. during local integration testing of tool-use flows).

---

## Precedence rules

Resolution order, highest to lowest:

1. **`AGENTFORGE_RUNTIME` environment variable** — per-process, always wins.
2. **`runtime:` in `.agentforge/autonomous.yaml`** — project-level default.
3. **Hard fallback: `auto`**.

### Why env var wins over config file

The env var is a per-process, per-invocation signal.  A deploy platform (e.g.
AgentForge Cloud) sets it at container launch to hard-pin the transport without
touching project files.  The config file is a developer convenience for standing
up a project-local default; it is intentionally lower priority so that
infrastructure-level decisions cannot be overridden by a checked-in file.

### Conflict warning

When the env var and the config file disagree, AgentForge logs a single warning to
stderr and uses the env var value:

```
[agentforge] AGENTFORGE_RUNTIME="sdk" overrides autonomous.yaml runtime="cli".
Env var takes precedence (see docs/runtime-modes.md).
```

---

## Configuration

### Environment variable

```sh
# Always use the Anthropic SDK (AgentForge Cloud / CI)
export AGENTFORGE_RUNTIME=sdk

# Always use the Claude Code CLI subprocess
export AGENTFORGE_RUNTIME=cli

# Let AgentForge decide (default)
export AGENTFORGE_RUNTIME=auto
```

### `.agentforge/autonomous.yaml`

Add a top-level `runtime:` field:

```yaml
runtime: sdk   # or: auto | cli | anthropic-sdk | claude-cli | claude-code-compat | codex-cli | openai-sdk

budget:
  perCycleUsd: 200
  # ...
```

---

## Invalid values

An unrecognised value (e.g. `AGENTFORGE_RUNTIME=turbo`) emits a warning and falls
back to `auto`:

```
[agentforge] AGENTFORGE_RUNTIME="turbo" is not a valid value.
Falling back to "auto". Valid values: auto, sdk, cli, anthropic-sdk, claude-cli, claude-code-compat, codex-cli, openai-sdk.
```

---

## Programmatic access

```typescript
import { resolveMode, readConfigMode } from '@agentforge/core/runtime/execution-service-mode';

// Resolve from process.env + autonomous.yaml in cwd
const mode = resolveMode(); // 'auto' | 'sdk' | 'cli' | 'anthropic-sdk' | 'claude-cli' | 'claude-code-compat' | 'codex-cli' | 'openai-sdk'

// Read only the config-file field
const configMode = readConfigMode('/path/to/project');

// Construct ExecutionService with an explicit mode (bypasses env/config)
import { ExecutionService } from '@agentforge/core';
const svc = new ExecutionService({ mode: 'sdk' });
console.log(svc.mode); // 'sdk'
```
