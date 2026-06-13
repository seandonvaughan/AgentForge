# Codex Gatekeeper/Canary v1

**Date:** 2026-06-12
**Status:** V1 CONTRACT - nonblocking hardening path
**Consumers:** future epic planners, readiness-service implementers, gate reviewers, and dashboard E2E owners.

---

## 1. Purpose

The Codex Gatekeeper/Canary work proves that AgentForge can expose Codex runtime readiness without turning the dashboard into a hidden production probe. V1 keeps the readiness canary visible, redacted, and testable while leaving durable service ownership for a later readiness-service epic.

This spec is the handoff contract for that future work. It documents what is already promised by the core/server/dashboard seams, how tests must mock them, what hardening can proceed now, and what must wait.

---

## 2. Current Consumers

The v1 contract has four current consumer groups:

1. **Core readiness builder:** `packages/core/src/runtime/codex-readiness.ts` owns `buildCodexReadinessReport`, the injected Codex exec probe, the `codexReadinessCanary` result, warning construction, and redaction.
2. **Server API:** `packages/server/src/routes/v5/codex-readiness.ts` owns `GET /api/v5/codex/readiness`, short-lived route caching, the `checks.readinessCanary` display shape, and rejection of mismatched `projectRoot` requests.
3. **Dashboard surfaces:** `packages/dashboard/src/lib/components/CodexReadinessPanel.svelte` renders the contract on `/health`, `/runner`, `/settings/forge`, and `/cycles/new` through the same panel. The health and runner E2E suites must assert that the canary label, status, and evidence are visible on those pages.
4. **Operator and automation entry points:** `agentforge codex readiness --json`, `af_codex_readiness`, and the autonomous gate/verifier scripts consume the same readiness report shape for release confidence.

No consumer should invent a second readiness status model. New surfaces must reuse the API shape or add fields behind the same route contract.

---

## 3. V1 Contract

`buildCodexReadinessReport` remains the source of truth for Codex readiness. A report is ready only when the existing blocking checks pass: valid agent profiles, Codex CLI availability, the injected exec preflight, MCP server output, and requested login checks. `codex doctor` remains optional diagnostics.

The readiness canary is explicitly **nonblocking** in v1:

- Status values are `skipped`, `passed`, or `failed`.
- A skipped canary records `{ checked: false, ok: null, status: 'skipped' }`.
- A passed canary records `{ checked: true, ok: true, status: 'passed', message? }`.
- A failed canary records `{ checked: true, ok: false, status: 'failed', message? }` and contributes a redacted warning.
- A failed canary does not change `ready` by itself.

The server maps that result to:

- `summary.codexReadinessCanaryChecked`
- `summary.codexReadinessCanaryOk`
- `summary.codexReadinessCanaryStatus`
- `checks.readinessCanary.label = 'Codex readiness canary'`
- `checks.readinessCanary.ok`
- `checks.readinessCanary.detail`
- redacted `warnings[]`

Dashboard consumers must render enough visible evidence for operators and gate reviewers to distinguish skipped, passed, and failed canaries. At minimum, health and runner surfaces must show the `Codex readiness canary` label, a visible status badge or equivalent state, and redacted detail or warning evidence when the canary fails.

---

## 4. Mocked Test Seams

Unit and E2E tests must use injected readiness builders/probes rather than real Codex. This is a hard rule for v1 and for the future readiness service.

Required seams:

- Core unit tests inject `runCodexExecProbe` into `buildCodexReadinessReport`.
- Server route tests inject `readinessReportBuilder` into `codexReadinessRoutes`.
- Dashboard component and E2E tests mock `/api/v5/codex/readiness` responses.
- CLI and MCP tests mock `buildCodexReadinessReport` or the tool wrapper; they must not spawn Codex.

Tests must cover:

- passed canary: label and passed state are preserved;
- failed canary: `ready` remains governed by blocking checks, while warning/detail evidence is redacted and visible;
- skipped canary: skipped/null state is preserved without requiring an exec subprocess;
- health and runner pages: mocked `/api/v5/codex/readiness` responses render visible canary label, status, and evidence;
- release verifier path: Gatekeeper/Canary verification runs before dashboard build/test commands that depend on collected tests.

The mocked response should include realistic warning text such as `codex readiness canary failed: [project-root] ... [redacted-secret]` so the dashboard tests guard redaction and evidence visibility together.

---

## 5. Nonblocking Hardening Milestones

These milestones can ship without waiting for a separate readiness service:

1. **Visibility lock:** keep the dashboard panel on `/health` and `/runner`, and add E2E coverage that intercepts `/api/v5/codex/readiness`.
2. **Verifier lock:** make the release scripts run the Gatekeeper/Canary verifier before dashboard build/test steps, then lock that order in CI script tests.
3. **Redaction lock:** keep project roots, tokens, and auth-like environment values out of canary details and warnings.
4. **Cache discipline:** keep the route cache short-lived and keyed by project root plus login/doctor options.
5. **Contract fixtures:** keep reusable mocked states for skipped, passed, degraded, and failed canaries close to the dashboard tests.
6. **Operational docs:** link this spec from troubleshooting and readiness docs whenever the canary contract changes.

These are implementation-hardening steps, not a service rewrite. They should stay PR-sized and preserve the existing route and report shape unless a future epic explicitly version-bumps the contract.

---

## 6. Rollout Gates

The v1 feature is releasable only when all of these gates pass:

- Core readiness unit tests cover skipped, passed, and failed canaries with injected probes.
- Server route tests cover injected readiness builders, redaction, and `/api/v5/codex/readiness` shape.
- Dashboard component tests cover canary evidence in compact and full modes.
- Dashboard health and runner E2E tests mock `/api/v5/codex/readiness` and assert visible label/status/evidence.
- Package script tests prove the Gatekeeper/Canary verifier runs before dashboard build.
- Type-check and targeted Vitest suites pass under `corepack pnpm`.

Release notes should call the canary nonblocking. Operators should not interpret a failed canary as a failed Codex runtime unless a blocking check also fails.

---

## 7. Future Readiness-Service Boundary

A future readiness-service epic may replace route-local construction with a shared service, but that work must not block this epic. The future service owns:

- background probe scheduling and deduplication across dashboard, CLI, MCP, and autonomous gates;
- persistent readiness history and trend analysis;
- freshness metadata, stale-state policy, and operator override rules;
- multi-workspace readiness aggregation;
- richer eventing for dashboard live updates;
- service-level ownership of canary source, sampling, and retry policy.

That future boundary must preserve the v1 shape or publish a versioned migration. Until then, the current route remains the integration seam and tests continue to inject builders/probes instead of launching real Codex.

---

## 8. Planner Notes

Future epic planners should split work by consumer and file ownership:

- core report and redaction changes in one item;
- server API shape and cache changes in one item;
- dashboard component and E2E visibility in one item, with health and runner sequenced if they touch shared test helpers;
- release script verification in one item;
- readiness-service extraction only after v1 coverage is green.

Do not assign a child that declares readiness behavior without naming its consumer. The consumer must be a caller, route, CLI/MCP command, dashboard surface, or verifier path that exercises the change.
