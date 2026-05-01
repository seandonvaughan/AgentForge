# AgentForge

AgentForge is a TypeScript monorepo for building agent teams, running agent tasks, and operating autonomous development cycles. As of version `10.5.0`, the canonical product stack is under `packages/*`:

- `packages/cli` - canonical CLI surface
- `packages/core` - runtime, team, and cycle services
- `packages/server` - canonical API server
- `packages/dashboard` - canonical operator UI

The root `src/` tree still exists, but it is a compatibility layer during the convergence to the package stack.
Its builder, scanner, genesis, and reforge modules are now shim-only forwarders to package-core.

## Current State

The package CLI is the canonical surface, but not every command is equally converged yet.

- Package-native today:
  - `run invoke`, `run delegate`, `run history`, `run show`
  - `costs report`
  - `cycle run`, `cycle preview`, `cycle list`, `cycle show`, `cycle approve`
  - `team`
  - `team-sessions list`, `team-sessions delete`
  - `workspaces *`
  - `migrate`
  - `info`
  - `start`
- Package team service bridge today:
  - `team forge`
  - `team genesis`
  - `team rebuild`
  - `team reforge *`
  - top-level aliases such as `forge`, `genesis`, `rebuild`, `reforge`, and `sessions`
- Transitional behavior to be aware of:
  - `agentforge start` launches the canonical package server in-process.
  - `run delegate` is recommendation-first and only executes with `--run`.
  - top-level `delegate` is a compatibility alias and preserves the older auto-run default.
- `team forge`, `team genesis`, `team rebuild`, and `team reforge *` currently route through package team services in `@agentforge/core`.

## Canonical CLI Surface

```text
agentforge info
agentforge migrate
agentforge start

agentforge run invoke --agent <agent> --task <task> [--runtime auto|sdk|claude-code-compat]
agentforge run delegate <task...> [--run]
agentforge run history
agentforge run show <sessionId>

agentforge costs report

agentforge cycle run [--dry-run] [--workspace <id>] [--project-root <path>]
agentforge cycle preview [--workspace <id>] [--project-root <path>]
agentforge cycle list [--workspace <id>] [--project-root <path>]
agentforge cycle show <cycleId> [--workspace <id>] [--project-root <path>]
agentforge cycle approve <cycleId> [--all|--approved <ids...> --rejected <ids...>]
agentforge autonomous:cycle    # compatibility alias for cycle run

agentforge team [--verbose]
agentforge team forge
agentforge team genesis
agentforge team rebuild
agentforge team reforge apply|list|rollback|status

agentforge team-sessions list
agentforge team-sessions delete <sessionId>

agentforge workspaces list|add|remove|default
```

## Runtime Modes

Package runtime commands currently support:

- `auto`
- `sdk`
- `claude-code-compat`

`auto` prefers the canonical package runtime path and can fall back to Claude Code compatibility transport when needed.

Streaming runtime transports normalize provider output into `start`, `text_delta`, `usage_delta`, `done`, and `error` events. Non-streaming transports remain supported through a full-response fallback.

## Dashboard Operator Notes

The package dashboard in `packages/dashboard` is the canonical operator UI. In development it runs on port `4751` and proxies API/SSE traffic to the package server on port `4750`.

- `/runner` starts agent work through `POST /api/v5/run` and supports both response modes:
  - default asynchronous `202 Accepted` responses that return a `sessionId` while output continues over SSE
  - compatibility `200` responses with `?wait=true` that include the completed run result
- Runner output streams from `/api/v5/stream` using `agent_activity` events with `data.sessionId` plus `data.content` or `data.chunk`.
- Runner completion/failure is driven by `workflow_event` events with `data.sessionId` and `data.status`.
- `/live` is the raw operator activity feed for the same SSE stream and warns operators when the stream is reconnecting.

## Release and Security Gates

AgentForge requires Node.js `>=20.19.0`. CI and release gates run on Node `20.19.x` and `22.13.x`; Node 18 is no longer a supported compatibility target.

- `corepack pnpm verify:gates` runs lint, version sync, TypeScript build, dashboard check/build, help/changelog truth checks, and the dependency audit.
- `corepack pnpm test:run` runs the Vitest suite.
- `corepack pnpm test:e2e:dashboard` runs the dashboard Playwright product gate.
- Security posture is split across dependency audit, CodeQL, OSV Scanner, Gitleaks, and CycloneDX SBOM generation.

See [docs/release-and-security-gates.md](docs/release-and-security-gates.md) for the full policy and release checklist.

## Durable Jobs and Realtime Direction

The current operator contract is package-first: durable cycle/session artifacts live under `.agentforge/*`, the package server owns `/api/v5/*`, and realtime dashboard updates flow through `/api/v5/stream`. New job orchestration should preserve that contract: make job state restart-safe before adding new dashboard affordances, and publish incremental status through the shared SSE stream rather than route-local polling.

## Development

```bash
git clone https://github.com/seandonvaughan/AgentForge.git
cd AgentForge
corepack pnpm install
corepack pnpm build
corepack pnpm test:run
```

Useful commands:

```bash
# Package CLI
node packages/cli/dist/bin.js --help

# Canonical package server
node packages/cli/dist/bin.js start

# Dashboard dev server
cd packages/dashboard
npx vite --port 4751
```

## Repository Layout

```text
packages/
  cli/          Canonical CLI
  core/         Runtime, team, and autonomous services
  server/       Canonical API server
  dashboard/    Canonical UI
  db/           Workspace/session persistence
  embeddings/   Embedding and similarity services

src/
  cli/          Root compatibility CLI
  server/       Root compatibility server bootstrap
```

## License

MIT
