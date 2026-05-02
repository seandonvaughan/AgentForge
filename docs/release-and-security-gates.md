# Release and Security Gates

**Last reviewed:** May 1, 2026

This document is the current release gate policy for AgentForge's package-canonical stack.

## Node Policy

AgentForge requires Node.js `>=20.19.0`.

- Supported CI and release lanes are Node `20.19.x` and `22.13.x`.
- Node 18 is not a compatibility target for new releases.
- Major dependency upgrades must stay green on both supported lanes before merge.
- If a dependency requires a newer Node major, update `engines.node`, CI matrices, this document, and README in the same change.
- Do not keep fallback code or docs solely for Node 18 compatibility.

## Required Product Gates

The product gate is split so failures identify the broken surface quickly:

- `corepack pnpm lint`
- `corepack pnpm check:versions`
- `corepack pnpm build`
- `corepack pnpm dashboard:check`
- `corepack pnpm dashboard:build`
- `corepack pnpm check:help`
- `corepack pnpm check:changelog`
- `corepack pnpm audit:deps`
- `corepack pnpm test:run`
- `corepack pnpm test:e2e:dashboard` for runner streaming, live events, and health status

`corepack pnpm verify:gates` covers the release truth gate and dashboard check/build. Vitest and Playwright remain explicit CI/release steps so test artifacts are easier to inspect.

## CI Posture

`.github/workflows/ci.yml` runs the core product lanes on Node `20.19.x` and `22.13.x`:

- lint
- release truth gates
- Vitest
- TypeScript build
- dashboard check/build
- dashboard Playwright e2e for runner streaming, live events, and health status
- type-check

The Playwright lane installs Chromium in CI and uploads the HTML report on failure or success. The broad legacy dashboard suite remains available through `corepack pnpm test:e2e`; do not add it to the release gate until stale route and API-shape expectations are repaired.

## Security Posture

`.github/workflows/security.yml` is the dedicated security workflow:

- `pnpm audit:all` runs on Node `20.19.x` and `22.13.x` with low-severity enforcement.
- OSV Scanner runs recursively and fails on known vulnerable dependency findings.
- Gitleaks scans full git history with redaction enabled and fails on detected secrets.
- `pnpm sbom:ci` writes a CycloneDX SBOM to `artifacts/sbom/cyclonedx.json` and uploads it as a workflow artifact.

`.github/workflows/codeql.yml` runs GitHub CodeQL analysis for JavaScript and TypeScript on pushes, pull requests, weekly schedule, and manual dispatch.

## Release Gate

`.github/workflows/release.yml` runs release validation on Node `20.19.x` and `22.13.x` before creating a GitHub release:

- install with `pnpm install --frozen-lockfile`
- run `pnpm verify:gates`
- run Vitest
- run `tsc --noEmit`
- install Chromium
- run dashboard Playwright gates for runner streaming, live events, and health status

The release artifact build currently uses Node `20.19.x` after both validation lanes pass.

## Durable Jobs and Realtime Direction

AgentForge's operator model is package-first:

- `packages/server` owns `/api/v5/*` orchestration.
- `packages/dashboard` consumes package API responses and `/api/v5/stream`.
- `.agentforge/cycles/*`, `.agentforge/sessions/*`, and `.agentforge/v5/*` remain the durable artifact roots.

Future job work should make state restart-safe before adding UI affordances. The expected direction is durable job records plus resumable workers, with realtime status published over the shared SSE stream. Dashboard routes should prefer `/api/v5/stream` for incremental status and use polling only as a recovery or historical-load fallback.
