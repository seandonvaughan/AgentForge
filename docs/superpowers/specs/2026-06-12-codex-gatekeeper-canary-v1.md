# Codex Gatekeeper Canary v1

**Date:** 2026-06-12
**Status:** DESIGN - v1 contract for nonblocking readiness hardening
**Consumers:** future epic planners and readiness-service implementers

---

## 1. Purpose

The Codex gatekeeper canary is a readiness signal, not a new blocking service
boundary. v1 keeps the existing synchronous readiness surfaces intact while it
hardens the contract that future service work must preserve.

This spec documents the current contract, the mocked seams tests must use, the
nonblocking service-hardening path, rollout gates, and the work that must wait
for a future readiness service without blocking this epic.

---

## 2. Current Consumers

### Core

- `packages/core/src/runtime/codex-readiness.ts` owns
  `buildCodexReadinessReport()`, the canonical report shape, the `codex exec`
  preflight, `codex doctor` diagnostics, agent profile checks, auth state, MCP
  build-output checks, redaction, and the optional `codexReadinessCanary`.
- Core readiness returns the fields downstream consumers depend on:
  `ready`, `warnings`, `agents`, `codexCliAvailable`,
  `codexExecProbeChecked`, `codexExecProbeOk`, `codexExecProbeStatus`,
  `codexExecProbeLaunchKind`, `codexExecProbeExitCode`,
  `codexExecProbeDurationMs`, `codexExecProbeMessage`,
  `codexDoctorChecked`, `codexDoctorOk`, `codexDoctorStatus`,
  `codexDoctorVersion`, `codexReadinessCanary`, `mcpServerAvailable`,
  `mcpServerPath`, `codexLoginChecked`, `codexLoginOk`, `codexAuthStatus`,
  and `codexAuthReason`.
- `packages/cli/src/commands/codex.ts` consumes the core report for
  `agentforge codex readiness`, including JSON output, human output, and failing
  exit codes when readiness or the exec probe fails.
- `packages/mcp-server/src/tools/af-codex-workflows.ts` shells through the CLI
  for `af_codex_readiness` and preserves the parsed readiness fields for MCP
  clients.

### Server

- `packages/server/src/routes/v5/codex-readiness.ts` exposes
  `GET /api/v5/codex/readiness`, derives dashboard-friendly `summary` and
  `checks` objects from the core report, redacts user and project details, and
  caches by `projectRoot`, `skipLogin`, and `includeDoctor`.
- `packages/server/src/routes/v5/index.ts` registers the v5 adapter route.
- `packages/server/src/server.ts` registers the same route in the no-adapter
  dashboard boot path.

### Dashboard

- `packages/dashboard/src/lib/components/CodexReadinessPanel.svelte` fetches
  `/api/v5/codex/readiness?skipLogin=true`, renders the `ready`/`degraded`
  status, surfaces check details, and keeps canary/diff warnings visible even in
  compact mode.
- The panel is currently mounted by:
  `packages/dashboard/src/routes/health/+page.svelte`,
  `packages/dashboard/src/routes/runner/+page.svelte`,
  `packages/dashboard/src/routes/settings/forge/+page.svelte`, and
  `packages/dashboard/src/routes/cycles/new/+page.svelte`.

---

## 3. v1 Contract

v1 is a report contract and canary contract only. It must not require a daemon,
background scheduler, persistent readiness database, or live Codex call from
unit tests.

The report contract is:

- `ready` is `true` only when agent profiles are valid, the Codex CLI is
  available, the exec probe was checked and passed, MCP build output exists, and
  login either passed or was skipped.
- `codexExecProbeStatus` is one of `skipped`, `passed`, `failed`,
  `timed-out`, `spawn-error`, or `resolution-error`.
- `codexExecProbe*` fields carry launch kind, exit code, duration, and redacted
  message evidence when available.
- `codexReadinessCanary` has `checked`, `ok`, `status`, and optional redacted
  `message`; `status` is one of `skipped`, `passed`, or `failed`.
- `codex doctor` remains optional diagnostics. It may enrich warnings, but it is
  not the primary readiness gate.
- Server `summary` and `checks` must continue to serialize non-open statuses
  directly enough for dashboards and API clients to show why readiness is
  degraded.
- Warnings and details must be redacted through the core/server redaction paths
  before reaching CLI, server, MCP, or dashboard users.

The canary contract is:

- Canary input is deterministic status and message data supplied to the core
  builder, not a second hidden subprocess.
- Canary output is serialized beside exec probe and doctor evidence.
- A failed canary adds a warning and is visible in the dashboard readiness
  evidence list.
- Canary failures should be used as rollout signals before they become hard
  cycle gates.

---

## 4. Mocked Test Seams

Unit tests must use injected readiness builders/probes rather than real Codex.
No unit test may require a live `codex` binary, network login, operator profile,
or `codex exec` subprocess.

Required seams:

- Core tests inject `runCodexExecProbe`, `codexCliAvailable`, `doctorJson`,
  `codexReadinessCanary`, `env`, and `codexSpawnOptions` into
  `buildCodexReadinessReport()`.
- Server tests inject `readinessReportBuilder` into `codexReadinessRoutes()` and
  vary `readinessCacheTtlMs` instead of invoking core's real subprocess path.
- CLI tests mock `buildCodexReadinessReport()` and assert output/exit-code
  behavior from report fixtures.
- MCP workflow tests mock CLI execution and parse fixture JSON.
- Dashboard tests mock the readiness endpoint payload or inspect component
  source contracts; they must not load the real API or Codex runtime.

Regression guards must include non-open readiness states. In particular,
degraded, failed, skipped, timed-out, spawn-error, and resolution-error statuses
must still serialize with enough detail for the named consumers above.

---

## 5. Nonblocking Service-Hardening Milestones

1. **Freeze v1 report shape.** Keep the current core/server/dashboard fields
   stable and add tests around failure serialization before introducing a
   service facade.
2. **Extract a readiness facade.** Introduce an interface that can call today's
   builder synchronously while allowing a future service-backed implementation
   to be swapped in by the server and CLI.
3. **Centralize cache policy.** Move route-local cache semantics into the facade
   with explicit freshness metadata, while preserving the existing server query
   behavior.
4. **Add background refresh behind a flag.** A service may refresh readiness in
   the background, but request paths must keep their current synchronous fallback
   until the service has production evidence.
5. **Publish readiness events.** Emit status/freshness transitions for dashboard
   and operator diagnostics without making event delivery part of readiness
   correctness.
6. **Gate gradually.** Start with advisory canary warnings, then preflight
   warnings, then optional launch-blocking gates once false-positive rates are
   measured and fixtures cover degraded paths.

Each milestone must be shippable without requiring the next milestone. The epic
is complete when the v1 contract is documented and guarded; it is not blocked on
the future readiness service.

---

## 6. Rollout Gates

- Existing CLI, server route, MCP tool, and dashboard panel tests pass with
  mocked readiness reports.
- At least one server-side regression test proves non-open statuses still
  serialize for the dashboard contract.
- Dashboard evidence remains visible for readiness canary failures and
  dashboard-readiness diffs in compact and full modes.
- `codex doctor` remains opt-in diagnostics for normal readiness checks.
- Redaction tests cover project root and secret-like values in canary, exec
  probe, and warning output.
- Operators can compare advisory canary output against real cycle outcomes
  before any hard launch block is enabled.

---

## 7. Future Readiness Service Work

Future readiness service work must not block this epic.

The following belongs to a future readiness service and must not block this
epic:

- A long-lived readiness daemon or worker process.
- Persistent readiness history, trend charts, and cross-cycle analytics.
- Cross-process cache invalidation and distributed locks.
- Dashboard live updates over SSE or WebSocket.
- Organization-level device posture, policy enforcement, or fleet health.
- Automatic remediation of Codex installation, login, or MCP build failures.
- Hard blocking of autonomous cycle launches based solely on background service
  state.

Until that service exists, current consumers should keep calling the v1 report
path and should treat the canary as explicit evidence, not as an implicit
platform-wide gate.
