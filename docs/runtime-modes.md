# AgentForge Runtime Modes

AgentForge is **one product with one resolution policy: Claude-first**. You do
not pick a "mode" to run a cycle — the default (`auto`) lets the per-job router
decide the provider for every work item, with Claude as the default provider
for everything. `AGENTFORGE_RUNTIME` still exists, but it is an **escape
hatch** that pins an entire cycle to one provider family; most operators never
need to set it.

---

## Claude-first resolution (the default)

Under `auto`, the assign phase calls the per-job routing policy
(`resolveJobRouting` in `packages/core/src/autonomous/routing/job-router.ts`)
for every item. The policy is split-tier:

- **Judgment, security, and high-complexity work stays on Claude.** Items
  matching security markers (`security`, `auth`, `rbac`, `secret`, `token`,
  `credential`, `crypto`, `vuln`, `cve`), items estimated high-complexity, and
  items that have already failed repeatedly route to Claude **opus** via the
  tool-capable Claude transport (`claude-code-compat`), with `anthropic-sdk`
  as the only alternate. Codex is intentionally **not** in this chain.
- **Sonnet-tier implementation work (bulk / docs / low-complexity / unmarked
  items) may ride Codex as auxiliary capacity** — `codex-cli` running
  `gpt-5.5` at high effort — but **only when the `codex` binary
  identity-validates**: the resolved binary's `--version` output must look
  like the real Codex CLI and the CLI must be authenticated. When either check
  fails, the availability gate drops the decision to the Claude alternates
  (`claude-code-compat`, then `anthropic-sdk`). Codex is used when available,
  never required — the product works Claude-only.

The identity probe exists because a wrong binary answering as `codex` on PATH
has killed cycles mid-run before; a failed probe now degrades the item to
Claude instead (`packages/core/src/runtime/provider-availability.ts`).

---

## Codex exec readiness

When operators need to prove the Codex path before a cycle, use the readiness
gate instead of `codex doctor` alone:

```sh
corepack pnpm exec agentforge codex readiness --json --skip-login --skip-doctor
```

`agentforge codex readiness` verifies generated agent profiles, the Codex CLI,
the built AgentForge MCP server, and a tiny noninteractive `codex exec`
preflight. The exec preflight asks Codex to print a fixed string with
`--ask-for-approval never`, `--sandbox read-only`, `--json`, `--cd
<project-root>`, `--skip-git-repo-check`, `--ignore-user-config`, and
`--ignore-rules`; readiness is not just a PATH or version check.

Important fields in `--json` output:

- `codexExecProbeChecked`, `codexExecProbeOk`, and
  `codexExecProbeStatus` are the primary Codex execution gate.
- `codexExecProbeLaunchKind`, `codexExecProbeExitCode`,
  `codexExecProbeDurationMs`, and `codexExecProbeMessage` explain how the
  preflight launched and why it degraded.
- `mcpServerAvailable` proves `packages/mcp-server/dist/index.js` exists for
  tools that depend on the local MCP server build.
- `warnings[]` is operator-facing remediation context. Values such as
  `[project-root]`, `[codex-home]`, `[codex-bin]`, and `[redacted-secret]`
  mean the report intentionally removed local paths or secrets before
  returning CLI, API, or MCP diagnostics.

`codex doctor` remains optional diagnostics, not the primary readiness gate.
Add `--doctor` when you need its slower environment checks; keep
`--skip-doctor` for the normal readiness gate. The dashboard API exposes the
same contract at `/api/v5/codex/readiness?skipLogin=true&includeDoctor=true`,
and MCP clients can call `af_codex_readiness` with `skipLogin` and
`includeDoctor`.

---

## The escape hatch: `AGENTFORGE_RUNTIME`

Setting `AGENTFORGE_RUNTIME` (or `runtime:` in `.agentforge/autonomous.yaml`)
to anything other than `auto` **pins the whole cycle to that provider
family**. The forced family's failover chain is restricted to same-family
transports — forcing a Claude runtime can never dispatch Codex and vice versa
— while the router's cost-optimized tier/effort per item is preserved (e.g. a
sonnet-tier item runs claude-sonnet on the Claude family). With `auto`, the
routed decision is byte-identical to the router's output.

Use it when you must guarantee a transport: CI without the `claude` CLI,
AgentForge Cloud containers, or local integration testing of one specific
path.

| Mode | Value | Transport registered | Best for |
|---|---|---|---|
| SDK only | `sdk` | `AnthropicSdkTransport` only | AgentForge Cloud, CI, any environment where the `claude` CLI is not installed |
| CLI only | `cli` | `ClaudeCodeCompatTransport` only | Local Claude Code users who want to guarantee the CLI path |
| Auto (default) | `auto` | Available transports | Everyone else; per-job Claude-first routing as described above |

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

`auto` registers the available Anthropic SDK, Claude Code compatibility, Codex
CLI, and OpenAI SDK transports, preserving the
historical Claude-first preference in resolution order. At the cycle level, the per-job router (see
"Claude-first resolution" above) supplies a `providerPreference` chain per
item; at the transport level the `ProviderResolver` selects one at runtime:

- When `allowedTools` are requested, it first honors a compatible
  `preferredProvider` (`claude-code-compat` or `codex-cli`), then falls back to
  Claude Code compatibility and finally Codex CLI. Tool execution requires one of
  those CLI-backed transports.
- Otherwise it preserves the Claude-first preference by preferring the
  SDK transport when `ANTHROPIC_API_KEY` is present.
- Falls back to the CLI transport when the API key is absent but `claude` is on PATH,
  and can route to Codex/OpenAI transports when they are requested explicitly.

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

If you are documenting a Codex-mode recovery canary, keep the `AGENTFORGE_RUNTIME`
override evidence in this section so it stays beside the operator-facing runtime
override warning.

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
