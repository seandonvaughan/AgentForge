# AgentForge Runtime Modes

AgentForge supports three execution backends, selected via the `AGENTFORGE_RUNTIME`
environment variable or the `runtime:` field in `.agentforge/autonomous.yaml`.

---

## Runtime modes and transports

| Mode | Value | Transport registered | Best for |
|---|---|---|---|
| Anthropic SDK | `sdk` or `anthropic-sdk` | `AnthropicSdkTransport` only | AgentForge Cloud, CI, any environment with Anthropic API credentials |
| Claude CLI compat | `cli`, `claude-cli`, or `claude-code-compat` | `ClaudeCodeCompatTransport` only | Local Claude Code users who want to guarantee the `claude` subprocess path |
| Codex CLI | `codex-cli` | `CodexCliTransport` only | Local Codex users who need CLI tool execution and Codex sandbox controls |
| OpenAI SDK | `openai-sdk` | `OpenAiSdkTransport` only | Headless OpenAI API usage without local CLI dependencies |
| Auto (default) | `auto` | Resolver chooses from available transports | Local development with graceful fallback across providers |

### `auto` (default)

All transports can be registered. The `ProviderResolver` selects one at runtime:

- When `allowedTools` are requested, it prefers `claude-code-compat`, then `codex-cli`.
- Otherwise selection order is:
  1. `anthropic-sdk`
  2. `claude-code-compat`
  3. `codex-cli`
  4. `openai-sdk`

### `sdk`

Only `AnthropicSdkTransport` is registered.  Requires `ANTHROPIC_API_KEY` (or an
explicit `apiKey` on the request).  No `claude` subprocess is ever spawned.

**This is the required mode for AgentForge Cloud**, which sets
`AGENTFORGE_RUNTIME=sdk` in its container environment and has no Claude Code CLI.

### `cli`

Only `ClaudeCodeCompatTransport` is registered.  Requires the `claude` binary to be
authenticated and on PATH.  Useful when you explicitly want to exercise the Claude
Code path (e.g. during local integration testing of tool-use flows).

### `codex-cli`

Only `CodexCliTransport` is registered. Requires the Codex CLI to be installed and
authenticated. This mode is the forced option when a job must run with Codex CLI
settings (for example `codexSandbox`, `codexProfile`, or `codexSearch`).

### `openai-sdk`

Only `OpenAiSdkTransport` is registered. Requires `OPENAI_API_KEY` (or an explicit
`apiKey` in the request). No local CLI subprocess is required.

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

# Always use Codex CLI
export AGENTFORGE_RUNTIME=codex-cli

# Always use OpenAI SDK
export AGENTFORGE_RUNTIME=openai-sdk

# Let AgentForge decide (default)
export AGENTFORGE_RUNTIME=auto
```

### `.agentforge/autonomous.yaml`

Add a top-level `runtime:` field:

```yaml
runtime: sdk   # or: cli | auto | codex-cli | openai-sdk | anthropic-sdk | claude-cli | claude-code-compat

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

## Per-job model profiles

Each runtime job carries an explicit model profile per provider via
`providerModelProfiles`. This keeps retries idempotent and guarantees the selected
transport receives a concrete `modelId` (and optional `effort`) for that job.

Precedence for Codex/OpenAI model profile resolution:

1. Tier-specific environment overrides (for example `AGENTFORGE_CODEX_OPUS_MODEL`)
2. Provider-wide environment overrides (for example `AGENTFORGE_CODEX_MODEL`)
3. Runtime-supplied job effort override (`agentEffort`)
4. `.agentforge/config/models.yaml` provider/tier overrides
5. Built-in defaults

Transport-specific profiles are read from `providerModelProfiles[providerKind]`;
when missing, runtime falls back to request-level `modelId` and `effort`.

Supported environment prefixes for profile overrides:

- `AGENTFORGE_CODEX_*` for `codex-cli`
- `AGENTFORGE_OPENAI_*` for `openai-sdk`

Anthropic transports (`anthropic-sdk` and `claude-code-compat`) keep Claude model
IDs per tier unless explicitly overridden in request payloads.

---

## Programmatic access

```typescript
import { resolveMode, readConfigMode } from '@agentforge/core/runtime/execution-service-mode';
import { resolveProviderModelProfiles } from '@agentforge/core/runtime/model-profiles';

// Resolve from process.env + autonomous.yaml in cwd
const mode = resolveMode();         // 'auto' | 'sdk' | 'cli'

// Read only the config-file field
const configMode = readConfigMode('/path/to/project');

// Construct ExecutionService with an explicit mode (bypasses env/config)
import { ExecutionService } from '@agentforge/core';
const svc = new ExecutionService({ mode: 'sdk' });
console.log(svc.mode); // 'sdk'

// Resolve per-provider model profiles for a specific job.
const providerModelProfiles = resolveProviderModelProfiles('sonnet', 'high');
console.log(providerModelProfiles['codex-cli']); // { modelId: 'gpt-5.3-codex', effort: 'high' }
```
