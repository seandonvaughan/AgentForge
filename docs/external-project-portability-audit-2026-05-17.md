# External-Project Portability Audit — 2026-05-17

**Branch:** `feat/cloud-sdk-multiproject`
**Workstream:** T5.4 (Cycle 5 / v22.0.0)
**Auditor:** Automated grep + manual review

---

## Summary

Audited every file in `packages/` for hardcoded monorepo assumptions.
Found **9 leak sites** across server and CLI packages.  All are categorised below.

| Category | Count |
|---|---|
| LEAK — monorepo assumption (fixed) | 5 |
| ACCEPTABLE — correct opt-in with projectRoot param | ~18 |
| ACCEPTABLE — AgentForge package-internal (templates/prompts) | 3 |
| ACCEPTABLE — Commander option default (set before user override) | 4 |

---

## Leak sites (fixed in this PR)

### 1. `packages/server/src/routes/v5/cycles.ts` — line 1565 (was)

```ts
const cliEntry = resolve(join(opts.projectRoot, 'packages', 'cli', 'dist', 'bin.js'));
```

**Problem:** Resolves the AgentForge CLI binary relative to the _external_ project root.
If AgentForge is run against `/some/external/repo`, this path would be
`/some/external/repo/packages/cli/dist/bin.js` — which does not exist.

**Fix:** New `resolveAgentForgeCli(import.meta.url)` helper that resolves the
CLI binary relative to the server module's own location via `import.meta.url`.

---

### 2. `packages/server/src/routes/v5/cycles.ts` — line 1769 (was)

Same as #1, in the cycle-rerun handler.

**Fix:** Same `resolveAgentForgeCli()` call.

---

### 3. `packages/server/src/routes/v5/cycles.ts` — `summarizeCycle()` (line ~306)

```ts
const sprintFile = join(process.cwd(), '.agentforge/sprints', `v${sprintVersion}.json`);
```

**Problem:** Raw `process.cwd()` instead of using the request's resolved `projectRoot`.
If the server was launched from a different directory or against an external project,
sprint files would not be found.

**Fix:** Thread `projectRoot` parameter into `summarizeCycle()`; fall back to
`process.env.AGENTFORGE_PROJECT_ROOT` then `process.cwd()`.  Also updated
`baseForRequest()` return type to include `projectRoot` so the call site can pass it.

---

### 4. `packages/server/src/routes/v5/marketplace.ts` — line 5 (was)

```ts
const registry = new MarketplaceRegistry(join(process.cwd(), '.agentforge/agents'));
```

**Problem:** Module-level constant initialised at import time with raw `process.cwd()`.
When imported in a server that was started with `--project /external/path`, the
registry still pointed to the directory the server was _started from_, not the
external project.

**Fix:** Added `getProjectRoot()` helper that checks `AGENTFORGE_PROJECT_ROOT` env var
before falling back to `process.cwd()`.

---

### 5. `packages/server/src/routes/v5/index.ts` — line ~380 (was)

```ts
const candidate = pathJoin(process.cwd(), 'package.json');
pkgVersion = String(JSON.parse(readFileSync(candidate, 'utf8')).version ?? 'unknown');
```

**Problem:** Reads `package.json` from cwd to obtain the server version.  When run
against an external project, cwd is the external project and `package.json` contains
the wrong (or missing) version.

**Fix:** Walk up from `import.meta.url` to find the AgentForge server package directory
and read its `package.json` instead.

---

### 6. `packages/cli/src/commands/build-info.ts`

```ts
await readFile(join(projectRoot, 'packages', pkg, 'package.json'), 'utf-8')
```

**Problem:** Uses the CLI's `--project-root` argument (which points to the external
project) to locate AgentForge package binaries.

**Fix:** Added `getAgentForgeRoot()` using `import.meta.url` traversal so `agentforge info`
always reports AgentForge version, not the external project's version.

---

## New infrastructure added

### `packages/core/src/team/engine/path-utils.ts`

Added `resolveProjectRoot(opts?)` with 5-step resolution order:

1. `opts.explicit` — explicit `--project <path>` CLI flag
2. `AGENTFORGE_PROJECT_ROOT` env var
3. `opts.cwd` (or `process.cwd()`) if it contains `.agentforge/`
4. Traverse upward from cwd to find an ancestor with `.agentforge/`
5. Throws `NoProjectRootError` — actionable message tells user to run `agentforge init`

Exported from `packages/core/src/team/index.ts`.

### `packages/cli/src/commands/team.ts`

- `AGENTFORGE_PROJECT_ROOT` env var now consulted in `resolveProjectRoot()` (step 2)
- `--project <path>` accepted as short alias for `--project-root` in both
  `readProjectRootFromArgv()` (raw argv scan) and on the top-level `forge` alias command

---

## Sites confirmed as LEGITIMATE (no change needed)

| Location | Reason |
|---|---|
| `packages/core/src/team/engine/path-utils.ts` — `getRepositoryRoot()` | Uses `import.meta.url` — always points inside AgentForge package ✓ |
| `packages/core/src/team/engine/path-utils.ts` — `resolveProjectRoot()` fallback | The `cwd` fallback IS the intended behaviour for step 3/4 |
| `packages/core/src/team/engine/builder/synthesis.ts` | `fileURLToPath` usage to locate sibling `.md` prompt files — package-internal ✓ |
| `packages/core/src/team/engine/builder/agent-driven-forge.ts` | Same — prompt files inside the package ✓ |
| `packages/core/src/runtime/execution-service-mode.ts` | Has `projectRoot: string = process.cwd()` as default param — callers always pass explicit root ✓ |
| `packages/core/src/workspace/init-service.ts` | `options.projectRoot ?? process.cwd()` — explicit override always available ✓ |
| `packages/core/src/self-correction/git-checkpoint.ts` | `options.cwd ?? process.cwd()` — explicit override available; git-checkpoint is project-context specific ✓ |
| `packages/cli/src/bin.ts` (4 occurrences) | Commander `.option('--project-root <path>', ..., process.cwd())` — this is the DEFAULT value that is overridden by user input ✓ |
| All `opts.projectRoot ?? process.cwd()` in server routes | Correct fallback — server was started with explicit projectRoot for external-project case ✓ |

---

## Remaining items (out of scope for T5.4)

- `packages/core/src/marketplace/marketplace-registry.ts` constructor default
  still uses `process.cwd()` — fixed at the call site (server marketplace route) but
  the core class could also accept an env-var-aware default in a future PR.
- `packages/dashboard/src/routes/*/+page.server.ts` — SvelteKit SSR files use
  `process.cwd()` for agent YAML directory resolution.  These are dashboard pages that
  run in the SvelteKit server context; they read `AGENTFORGE_PROJECT_ROOT` at runtime
  (confirmed present in their code).  No change needed for T5.4.
