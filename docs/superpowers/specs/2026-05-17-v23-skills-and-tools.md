---
title: v23 — Skills and Tools Capability Layer
status: draft
authors: [chief-architect]
created: 2026-05-17
supersedes: none
---

# v23 — Skills and Tools Capability Layer for AgentForge Specialists

## 0. TL;DR

AgentForge has 24 forged specialists today (`.agentforge/team.yaml`,
`.agentforge/agents/*.yaml`). Each one ships with a multi-paragraph
`system_prompt`, an `auto_include_files` list, and a `learnings_seed` array
baked in by Phase B of the forge pipeline
(`packages/core/src/team/engine/builder/synthesis.ts`). What they do NOT have is
a **structured, reusable capability layer** — every "know how to TDD",
"know how to verify before completion", "know how to dispatch parallel agents"
lesson lives only as inline prose in `system_prompt`.

This spec proposes a Skills layer that:

1. **Imports** the public Anthropic Claude Code skill catalog and the
   `superpowers:*` catalog as a forkable baseline at
   `packages/skills-catalog/`.
2. **Lets the forge synthesis phase tag each agent** with the skill IDs it
   needs (`skill_ids: [...]`), enforcing per-tier caps.
3. **Injects skill bodies into the system prompt at agent-load time** via a
   single extension to `loadAgentConfig` — one mechanism, equally valid for
   the CLI transport (`claude-code-compat-transport.ts`) and the SDK
   transport (`anthropic-sdk-transport.ts`).
4. **Keeps skills auditable** under git — every fork from the upstream
   catalog becomes a normal PR.

Pilot: equip `fastify-v5-engineer` with one adapted skill
(`af-test-driven-development.md`) end-to-end in a single ~300 LOC PR.

---

## 1. Patterns and Conventions Found

The injection plumbing we need already exists for memory and DMs; we are
adding a third sibling, not a new subsystem.

- **Per-agent YAML schema** is the canonical source of truth. Schema is
  written by `buildAgentYaml()` at
  `packages/core/src/team/engine/builder/synthesis.ts:261`. Every agent gets
  `name`, `model`, `system_prompt`, `auto_include_files`, `learnings`,
  `capability_tags`, `owns_subsystems`. There is **no** `skills` field with
  semantic meaning today — the existing top-level `skills:` array in each
  YAML (e.g. `.agentforge/agents/fastify-v5-engineer.yaml:63-68`) is a
  duplicate of `capability_tags` used only for keyword routing.

- **Prompt assembly happens once per dispatch** in `loadAgentConfig()` at
  `packages/core/src/agent-runtime/agent-factory.ts:33-72`. It currently
  composes `baseSystemPrompt` → `injectFreshContext` (memory slice) →
  `injectAgentDms` (queued DMs from the comms layer, ADR 0001). This is the
  natural splice point for a third injector: skills.

- **Both transports consume `ExecutionRequest.agent.systemPrompt` only**:
  - CLI: `claude-code-compat-transport.ts:394` passes
    `--system-prompt request.agent.systemPrompt` and nothing else as a
    system message.
  - SDK: `anthropic-sdk-transport.ts:262-267` puts
    `request.agent.systemPrompt` into the cached `system:` block
    (always-ephemeral, charged at 1.25× input on creation and 0.1× input on
    reads).

  This single shared field is the only thing both transports already know
  how to cache and bill correctly. Anything we attach to skills has to ride
  this field or pay for parallel plumbing in two transports.

- **Phase A→B forge pipeline** is the single source of agent design:
  Phase A is five recon agents (`code-archaeologist`, `dep-graph-analyst`,
  `convention-detective`, `domain-mapper`, `failure-historian`). Phase B is
  Opus synthesis at `synthesis.ts:378` (`synthesizeTeam`). Schema lives at
  `synthesis.ts:37-55` (`TeamPlanAgentSchema`). Skill assignment must go
  here — anywhere else and re-forging will silently drop it on every run.

- **Execute phase already supports per-dispatch allowed-tools list** at
  `packages/core/src/autonomous/phase-handlers/execute-phase.ts:149-156`
  (`EXECUTE_PHASE_DEFAULT_TOOLS = [Read, Write, Edit, Bash, Glob, Grep]`)
  and threads it through `RuntimeAdapter.run(agentId, task, { allowedTools })`
  at `runtime-adapter.ts:107`. The `Task` tool is intentionally excluded
  (line 147 comment) to prevent recursive subagent dispatch. Any
  AgentForge-specific tool we add must opt-in agent-by-agent.

- **No `--append-system-prompt` is used today.** The transport hardcoded
  `--setting-sources project,local` last sprint specifically to stop
  user-installed output-style plugins from injecting prose preambles
  (`claude-code-compat-transport.ts:389-393`). We must not undo that.

- **Cache pricing is real money.** The SDK transport caches the system
  prompt unconditionally at `anthropic-sdk-transport.ts:261-267`. Cache
  creation = 1.25× input, cache reads = 0.10× input. Skills shipped via the
  system prompt amortize over every dispatch of that agent — they cost
  meaningfully less than per-call prepends to `userContent`.

- **Existing baseline guard.** Synthesis injects a hardcoded
  `BASELINE_PR_MERGE_MANAGER` if Opus omits it (`synthesis.ts:218-227`).
  This is the exact pattern for "agents need at least one skill from a
  required set" — we'll reuse it for mandatory skills (see §3.3).

- **`.claude/agents/*.md` Claude Code subagent files** are written
  alongside YAML at `synthesis.ts:296-309`. The frontmatter currently
  hardcodes `tools: Read,Edit,Write,Bash,Grep,Glob`. We're not going to
  edit this file — it's only used when AgentForge specialists are invoked
  *from inside Claude Code itself* via `/agentforge:*` slash commands, not
  during autonomous cycles. v1 of skills is autonomous-cycle only; subagent
  surface is v2.

---

## 2. Architecture Decision

**Skills are versioned markdown documents stored in the repo, picked
per-agent during forge synthesis, and injected into `systemPrompt` at
`loadAgentConfig` time as a third sibling section after fresh-context and
DMs.**

Committed trade-offs:

| Decision | Choice | Why |
|---|---|---|
| Storage layout | `packages/skills-catalog/skills/{anthropic,superpowers,agentforge}/<id>.md` | Workspace package = standard build/test/version flow; tri-namespace makes upstream provenance visible at a glance. |
| Assignment authority | Opus during Phase B synthesis | The team plan is already the single source of truth; skills are part of the plan. |
| Injection mechanism | Append to `systemPrompt` after fresh-context block, before DMs | Re-uses existing caching (1.25×/0.10× via SDK; CLI's `--system-prompt`); works for both transports unchanged. |
| Format | YAML frontmatter + markdown body (Anthropic skill format) | Drop-in copy from the upstream catalog; no parser to invent. |
| Per-tier caps | opus≤4, sonnet≤6, haiku≤8 | Stricter for big-model agents to keep per-cycle Opus cache-creation cost bounded; haiku gets more because each skill body is small and the cache amortizes over many short calls. |
| AgentForge-internal "tools" | Claude Code tools list (`allowedTools`) only for v1; no new MCP servers | The CLI's `--allowed-tools` and the existing `allowedTools` arg on `ExecutionRequest` already work; we don't need an MCP/RPC surface yet. |

Rejected alternatives:

- **`--append-system-prompt`** — only available on CLI transport, would
  require parallel plumbing for SDK, and is not currently in the
  `buildClaudeArgs` set. Skips caching benefits.
- **Per-call prepend to `userContent`** — defeats SDK caching, costs more
  per dispatch, and is invisible to the CLI's session-context display.
- **MCP server per skill** — out of scope for v1; would force a CLI
  change we don't control. Revisit at v25+ once the MCP model stabilises.
- **`tool_use` blocks** — possible but requires the agent to elect to
  invoke each skill, which neither the current Opus prompt nor most
  models do reliably without prodding. Skills must be ambient.

---

## 3. Skill Inventory (curated, per-agent assignment)

All names are AgentForge-namespaced (`af-`) once forked from upstream, so
upstream upgrades remain explicit PRs. Token counts are rough estimates
based on Anthropic's published skill bodies (~600–1200 tokens each).

### 3.1 From the Anthropic Claude Code catalog

| Upstream | AF id | Est. tokens | Assigned to (24 agents) |
|---|---|---|---|
| `coding` | `af-coding-conventions` | ~900 | every implementation agent (14) |
| `frontend-design` | `af-frontend-design` | ~1100 | svelte-cycles, svelte-agents, svelte-runner, svelte-component-atoms (4) |
| `debugging` | `af-debugging` | ~800 | all 14 implementation + test-engineer + auth-security (16) |
| `test-driven-development` | `af-tdd` | ~700 | every implementation + test-engineer + ci-build (16) |
| `code-review` | `af-code-review` | ~900 | strategic (3) + quality (3) (6) |
| `git-workflow` | `af-git-workflow` | ~600 | every implementation + pr-merge-manager (15) |

### 3.2 From `superpowers:*`

| Upstream | AF id | Est. tokens | Assigned to |
|---|---|---|---|
| `using-superpowers` | `af-superpowers-meta` | ~500 | strategic agents only (3) — primer on how the rest compose |
| `systematic-debugging` | `af-systematic-debug` | ~1000 | autonomy-strategist + executor-runtime + test-engineer + ci-build (4) |
| `brainstorming` | `af-brainstorming` | ~700 | chief-architect + forge-engine-architect + autonomy-strategist (3) |
| `writing-plans` | `af-writing-plans` | ~900 | strategic (3) only |
| `executing-plans` | `af-executing-plans` | ~800 | every implementation (14) |
| `dispatching-parallel-agents` | `af-parallel-dispatch` | ~1100 | autonomy-strategist + executor-runtime-engineer (2) |
| `verification-before-completion` | `af-verify-before-done` | ~600 | every agent (24) — universal mandatory skill |
| `finishing-a-development-branch` | `af-finish-branch` | ~700 | pr-merge-manager + every implementation (15) |
| `writing-skills` | `af-writing-skills` | ~800 | chief-architect + forge-engine-architect (2) — meta |
| `using-git-worktrees` | `af-git-worktrees` | ~700 | executor-runtime-engineer + pr-merge-manager (2) |
| `subagent-driven-development` | `af-subagent-driven` | ~900 | autonomy-strategist + executor-runtime-engineer (2) |
| `condition-based-waiting` | `af-condition-waiting` | ~400 | executor-runtime + ci-build (2) |
| `root-cause-tracing` | `af-root-cause` | ~600 | quality (3) + autonomy-strategist (4) |

### 3.3 AgentForge-native skills (no upstream)

These encode AgentForge-specific facts. They're net-new, written by us,
shipped in `packages/skills-catalog/skills/agentforge/`.

| AF id | Est. tokens | Purpose | Assigned to |
|---|---|---|---|
| `af-cycle-runner-phases` | ~600 | 9-phase pipeline contract (`audit→plan→assign→execute→test→review→gate→release→learn`); inputs/outputs of each. Critical for any agent that emits artifacts. | autonomy-strategist + executor-runtime + test-engineer + ci-build (4) |
| `af-gate-verdict-format` | ~400 | JSONL row schema for `gate-verdict.jsonl`; what counts as `pass`/`fail`/`approve_with_concerns`. | autonomy-strategist + test-engineer + auth-security (3) |
| `af-memory-jsonl-layout` | ~500 | Layout of `.agentforge/memory/*.jsonl` (cycle-outcome, gate-verdict, review-finding); recipe for writing a new entry that the curator will keep. | memory-curator + every reviewer (5) |
| `af-workspace-adapter-contract` | ~700 | The "all SQLite goes through WorkspaceAdapter; never raw sqlite3" rule + `appendAuditEntry()` requirement. | fastify-v5 + fastify-v6 + db-workspace + auth-security (4) |
| `af-yaml-dump-safety` | ~300 | "Use `js-yaml.dump()` not template strings" (CodeQL ReDoS lesson #3). Mandatory for yaml-doctor; recommended for every agent writing YAML. | yaml-doctor + reforge-genesis + memory-curator (3) |
| `af-execfile-not-exec` | ~300 | Lesson #4. Mandatory for any agent that calls Node child_process. | cli-engineer + executor-runtime + ci-build + scanner (4) |
| `af-sveltekit-plus-prefix` | ~250 | Lesson #5. Required for svelte-* agents only. | 4 svelte agents |
| `af-cost-aware-fallback` | ~500 | When to downgrade tier mid-task; how `modelCap`/`effortCap` interact with `enableFallback`. | strategic (3) + executor-runtime + pr-merge-manager (5) |

### 3.4 Per-agent skill assignments (the table the forge will reproduce)

Computed from §3.1–3.3, capped per tier (opus≤4, sonnet≤6, haiku≤8). Where
a candidate skill exceeds the cap, the synthesis prompt is instructed to
drop the lowest-priority entry (priority order: mandatory-universal →
domain-specific → meta).

| Agent | Tier | Final skills (≤cap) |
|---|---|---|
| chief-architect | opus | af-verify-before-done, af-writing-plans, af-brainstorming, af-superpowers-meta |
| forge-engine-architect | opus | af-verify-before-done, af-writing-plans, af-writing-skills, af-brainstorming |
| autonomy-strategist | opus | af-verify-before-done, af-cycle-runner-phases, af-parallel-dispatch, af-systematic-debug |
| fastify-v5-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-coding-conventions, af-workspace-adapter-contract, af-executing-plans |
| fastify-v6-shim-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-coding-conventions, af-workspace-adapter-contract, af-executing-plans |
| db-workspace-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-coding-conventions, af-workspace-adapter-contract, af-executing-plans |
| embeddings-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-coding-conventions, af-executing-plans, af-git-workflow |
| plugin-sdk-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-coding-conventions, af-executing-plans, af-git-workflow |
| executor-runtime-engineer | sonnet | af-verify-before-done, af-cycle-runner-phases, af-parallel-dispatch, af-git-worktrees, af-execfile-not-exec, af-subagent-driven |
| cli-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-execfile-not-exec, af-coding-conventions, af-git-workflow |
| scanner-engineer | sonnet | af-verify-before-done, af-tdd, af-debugging, af-execfile-not-exec, af-coding-conventions, af-executing-plans |
| reforge-genesis-engineer | sonnet | af-verify-before-done, af-tdd, af-coding-conventions, af-yaml-dump-safety, af-executing-plans, af-git-workflow |
| svelte-cycles-engineer | sonnet | af-verify-before-done, af-tdd, af-frontend-design, af-sveltekit-plus-prefix, af-coding-conventions, af-executing-plans |
| svelte-agents-engineer | sonnet | af-verify-before-done, af-tdd, af-frontend-design, af-sveltekit-plus-prefix, af-coding-conventions, af-executing-plans |
| svelte-runner-engineer | sonnet | af-verify-before-done, af-tdd, af-frontend-design, af-sveltekit-plus-prefix, af-coding-conventions, af-executing-plans |
| auth-security-engineer | sonnet | af-verify-before-done, af-debugging, af-code-review, af-gate-verdict-format, af-workspace-adapter-contract, af-tdd |
| test-engineer | sonnet | af-verify-before-done, af-tdd, af-systematic-debug, af-cycle-runner-phases, af-gate-verdict-format, af-root-cause |
| ci-build-engineer | sonnet | af-verify-before-done, af-execfile-not-exec, af-cycle-runner-phases, af-condition-waiting, af-systematic-debug, af-root-cause |
| pr-merge-manager | sonnet | af-verify-before-done, af-finish-branch, af-git-workflow, af-git-worktrees, af-cost-aware-fallback, af-code-review |
| svelte-component-atoms-engineer | haiku | af-verify-before-done, af-frontend-design, af-sveltekit-plus-prefix, af-coding-conventions |
| shared-utils-engineer | haiku | af-verify-before-done, af-tdd, af-coding-conventions, af-debugging |
| yaml-doctor | haiku | af-verify-before-done, af-yaml-dump-safety, af-coding-conventions |
| memory-curator | haiku | af-verify-before-done, af-memory-jsonl-layout, af-yaml-dump-safety |
| file-reader | haiku | af-verify-before-done |

Universal skill: `af-verify-before-done` ships to **all 24** agents (it's
short — ~600 tokens — and high-leverage).

---

## 4. Storage and Discovery

```
packages/skills-catalog/
  package.json              # @agentforge/skills-catalog (private workspace pkg)
  src/
    index.ts                # exports loadSkill(id) and listSkills()
    types.ts                # SkillManifest, SkillFrontmatter zod schemas
    catalog.ts              # build-time index of every skill file
  skills/
    anthropic/
      af-coding-conventions.md
      af-frontend-design.md
      af-debugging.md
      af-tdd.md
      af-code-review.md
      af-git-workflow.md
    superpowers/
      af-superpowers-meta.md
      af-systematic-debug.md
      af-brainstorming.md
      af-writing-plans.md
      af-executing-plans.md
      af-parallel-dispatch.md
      af-verify-before-done.md
      af-finish-branch.md
      af-writing-skills.md
      af-git-worktrees.md
      af-subagent-driven.md
      af-condition-waiting.md
      af-root-cause.md
    agentforge/
      af-cycle-runner-phases.md
      af-gate-verdict-format.md
      af-memory-jsonl-layout.md
      af-workspace-adapter-contract.md
      af-yaml-dump-safety.md
      af-execfile-not-exec.md
      af-sveltekit-plus-prefix.md
      af-cost-aware-fallback.md
  __tests__/
    catalog.test.ts          # every advertised skill is loadable; frontmatter parses
    token-budget.test.ts     # no skill > 1500 tokens (hard cap)
```

Skill file format (drop-in from Anthropic):

```markdown
---
id: af-tdd
version: 1.0.0
upstream: anthropic/test-driven-development
upstream_ref: <commit-or-tag-when-forked>
tags: [implementation, quality]
applies_to: [implementation, quality]   # agent categories
mandatory_for: []                       # agent ids that MUST get it
max_tokens: 700
---
# Test-Driven Development

Body markdown the agent reads as part of its system prompt...
```

**Discovery:** at synthesis time (Phase B), `synthesizeTeam` calls
`listSkills()` and passes the catalog descriptors to Opus in the
synthesis prompt. The synthesis prompt is extended to require Opus to
output `skill_ids: string[]` on every agent in `TeamPlanAgentSchema`.

**Validation:** Phase C deterministic check is extended with a sixth
rule: "every `skill_ids[]` entry resolves to a real catalog file, and the
per-tier cap is respected." Cap violations fail the forge.

---

## 5. Runtime Mechanism

**Chosen mechanism:** in `packages/core/src/agent-runtime/agent-factory.ts`,
extend `loadAgentConfig` to read `parsed.skill_ids: string[]` from the
agent YAML, resolve each via `@agentforge/skills-catalog`, and splice the
concatenated bodies into the system prompt **between** the base prompt
and the fresh-context block.

Effective composition order becomes:

```
[base system_prompt from YAML]
  ↓
## Skills
<skill 1 body>
---
<skill 2 body>
---
...
  ↓
## Fresh Context (this cycle)   ← injectFreshContext (existing)
  ↓
## Direct Messages              ← injectAgentDms (existing, ADR 0001)
```

Why this point in the call stack:

1. **One mechanism for both transports.** Both
   `claude-code-compat-transport.ts:394` and
   `anthropic-sdk-transport.ts:262` consume
   `ExecutionRequest.agent.systemPrompt` exactly once. Whatever we put
   into that string is identical across CLI and SDK — no per-transport
   branch.
2. **Cache amortization.** The SDK transport already attaches
   `cache_control: { type: 'ephemeral' }` to the system prompt
   unconditionally. Skills become part of the cached block at 1.25×
   input the first time, 0.10× input every call afterwards — much
   cheaper than per-call user-content prepends.
3. **Skill content is bigger than memory or DMs.** With 4 skills × ~700
   tokens = ~2800 tokens of skill body, the skills section will dominate
   the dynamic part of the prompt. Putting it ABOVE memory/DMs keeps the
   stable prefix stable (skills change at forge time only; memory/DMs
   change every dispatch), which is exactly what prefix-caching wants.
4. **No CLI flag changes.** The CLI compat transport doesn't gain or
   lose any args. We don't need `--append-system-prompt`. We don't
   touch `--setting-sources project,local` (the output-style guard).

What we are **NOT** doing:

- ❌ `--allowed-tools` changes (those stay scoped to runtime-decided
  tools; skills are not tools).
- ❌ Per-call user-content prepends (defeats cache, costs more,
  invisible to session display).
- ❌ MCP server registration (out of scope for v1).
- ❌ Editing `.claude/agents/*.md` frontmatter (subagent surface is v2).

**Hot reload:** skills are read from disk on every `loadAgentConfig`
call. The `RuntimeAdapter` already caches `AgentRuntime` instances
per-agent per-cycle, so re-load only happens on first use of each
agent per cycle. Operators can edit a skill md and see it take effect
on the next cycle without re-running the forge — useful while iterating.

---

## 6. Customization Workflow

How an operator forks upstream and adapts a skill:

1. **Fork:** copy the upstream file (Anthropic catalog or
   `superpowers:*`) into `packages/skills-catalog/skills/{ns}/<id>.md`,
   prefixing the id with `af-`.
2. **Edit frontmatter** to add `upstream:` + `upstream_ref:` (commit
   hash from upstream at time of fork). This is how reviewers see the
   provenance in a PR.
3. **Edit body** to:
   - Replace generic file paths with AgentForge-specific paths.
   - Add cross-references to AgentForge concepts (`.agentforge/memory/`,
     `gate-verdict.jsonl`, `WorkspaceAdapter`, `appendAuditEntry`,
     `pnpm verify:gates`).
   - Strip examples that don't apply (e.g. drop CRA examples from
     `af-frontend-design`; AgentForge is SvelteKit).
   - Add one "AgentForge specifics" section at the bottom citing the
     relevant cycle phase or memory file.
4. **Test budget:** `pnpm --filter @agentforge/skills-catalog test`
   enforces `max_tokens ≤ 1500` and frontmatter parsability.
5. **Open PR.** PR template requires: upstream ref, diff rationale,
   list of agents affected (re-run forge in dry-run on the PR to show
   token-delta per agent in the PR description).
6. **Re-forge:** after merge, `agentforge team forge` re-synthesises
   and the new skill body lands in every assigned agent's YAML on the
   next cycle.

Upgrades from upstream: a small `scripts/skills-upstream-diff.ts` (out
of scope for v1; v23.1) compares each `af-*.md` against its
`upstream_ref` and produces a sync report.

---

## 7. Cost Model

Per-dispatch added cost depends on whether cache is warm:

- **Cold (first call this hour for an agent):** ~2800 tokens × 1.25× input
  price → with Sonnet input at $3/Mtok, that's ~$0.0105 extra per cold
  agent boot. With 24 agents × 1 cold each per cycle, that's ~$0.25
  added per cycle.
- **Warm (subsequent calls within cache TTL):** ~2800 tokens × 0.10× input
  → ~$0.00084 per call. Negligible.

Per-tier caps prevent runaway costs:

| Tier | Skill cap | Worst-case skill tokens | Cold cost per agent |
|---|---|---|---|
| opus | 4 | ~3600 | ~$0.0675 |
| sonnet | 6 | ~5400 | ~$0.0203 |
| haiku | 8 | ~5600 | ~$0.0056 |

Hard caps are enforced two ways:

1. Phase C validator rejects any agent that exceeds tier cap.
2. `token-budget.test.ts` in the skills-catalog package rejects any
   individual skill body over 1500 tokens.

---

## 8. Migration Path — Smallest Pilot PR

**Pilot:** equip `fastify-v5-engineer` with `af-tdd` and nothing else.
This proves the full pipeline (catalog → synthesis → YAML → loadAgentConfig
→ both transports) on ONE agent with ONE skill.

### PR scope (single PR, ~300 LOC):

1. New package `packages/skills-catalog/` with:
   - `package.json`, `tsconfig.json` wired into root project references.
   - `src/index.ts` exporting `loadSkill(id)` and `listSkills()`.
   - `src/types.ts` with `SkillFrontmatterSchema` (zod).
   - One real skill: `skills/anthropic/af-tdd.md` (forked + adapted).
   - Token-budget test.
2. Schema extension in
   `packages/core/src/team/engine/builder/synthesis.ts:37-46`:
   add optional `skill_ids: z.array(z.string()).optional()` to
   `TeamPlanAgentSchema`. `buildAgentYaml` writes the field through.
3. `agent-factory.ts:33-72` extension: read `parsed.skill_ids`, call
   `loadSkill()` for each, splice bodies as `## Skills` section between
   base prompt and `injectFreshContext`. Skip silently if catalog package
   is unresolvable (defensive).
4. Manual one-line edit to
   `.agentforge/agents/fastify-v5-engineer.yaml`: append
   `skill_ids: [af-tdd]`. (Pilot only; full assignment table from §3.4
   ships in the follow-up forge run.)
5. New test
   `tests/agent-runtime/skills-injection.test.ts`: asserts that loading
   `fastify-v5-engineer` produces a system prompt containing both the
   base text and the skill body.
6. Update `CLAUDE.md` "Forge pipeline" section with a one-paragraph
   note about skills.

### Follow-up sprints:

- **v23.1:** wire synthesis prompt to pick `skill_ids` for all 24 agents
  per §3.4 table; deterministic-fallback path picks from a hardcoded
  map when running in legacy/no-LLM mode.
- **v23.2:** ship all remaining `af-*` skills + adapt every upstream
  body.
- **v23.3:** subagent surface — propagate skills into
  `.claude/agents/*.md`.
- **v23.4:** `scripts/skills-upstream-diff.ts` for upstream sync.

---

## 9. Critical Details

### Error handling
- Missing skill id in YAML → log warning, omit silently from prompt.
  Never fail the cycle on a missing skill.
- Malformed frontmatter at load time → log error, skip skill.
- Skills catalog package missing entirely → `loadAgentConfig` proceeds
  with no skills section.

### State management
- Skills are **stateless** by design. They never read from
  `.agentforge/memory/` (that's `injectFreshContext`'s job) and they
  never write anywhere.

### Testing
- Catalog: `token-budget.test.ts`, `catalog.test.ts`.
- Synthesis: extend `synthesis.test.ts` with `skill_ids` round-trip case.
- Runtime: `skills-injection.test.ts` proves the prompt contains
  the expected `## Skills` block.

### Performance
- Skill bodies are read fresh on every `loadAgentConfig` call. With
  24 agents × ~6 skills × ~3 KB each = ~430 KB of file I/O per cycle.
  Negligible against the ~$30/cycle budget.
- SDK cache: the system prompt prefix is **deterministic per agent**.
  Don't accidentally interpolate timestamps or per-call IDs into the
  skills section — that would explode cache creation cost.

### Security
- Skills are arbitrary markdown loaded from a **first-party workspace
  package**, never from user-controlled paths.
- Skill bodies become part of the system prompt and are treated as
  trusted by the model. Upstream forks must be reviewed before merge.

### Observability
- New SSE event topic `skill.injected` with
  `{ agentId, skillIds[], totalTokens }`.
- Optional JSONL append to `.agentforge/memory/skill-injection.jsonl`
  for cross-cycle usage analysis.

---

## 10. Decisions (user, 2026-05-18)

1. **Operator CLI surface — YES (v23.1).** Ship `agentforge skills list`,
   `agentforge skills add <id> --agent=<name>`, `agentforge skills
   diff-upstream`. Treat the catalog the same way as the team —
   first-class operator-managed state.

2. **`af-verify-before-done` universal placement — KEEP for v1, measure.**
   Operator's call: best judgement. Default to assigning it to all 24
   (including `file-reader`) because (a) it's small (~600 tokens),
   (b) it amortizes via cache after first cold boot, and (c) even
   read-only agents benefit from "double-check before declaring done"
   when emitting structured outputs. Re-evaluate after one full sprint of
   skill-injection telemetry shows real cache-hit ratios.

3. **`learnings_seed` becomes a generative input for skills (v23.5).**
   Don't retire learnings — instead extend the curator so it can:
   - **Refine an existing skill** when a recurring learning maps onto its
     domain (e.g. a repeated "use `execFile` not `exec`" lesson updates
     `af-execfile-not-exec.md`'s body and bumps its version).
   - **Propose a new skill** when 3+ cycles converge on the same
     evidence-rich pattern that doesn't fit any existing skill body. The
     proposal lands as a draft `.md` file under
     `packages/skills-catalog/skills/agentforge/_proposed/` for human
     review; a `agentforge skills approve-proposal <id>` command moves
     it into the live catalog.

   This makes the flywheel literal: cycles → learnings → curator
   decision → either skill refinement or new skill → next cycle's
   agents are stronger. See §11 for the full loop diagram.

4. **No cap on Opus skill count — measure instead.** Drop the opus≤4
   rule. Strategic agents can carry whatever skills their job actually
   needs. Sonnet keeps ≤6 (default; can be overridden by a strong
   rationale in the synthesis prompt) and Haiku keeps ≤8 as a soft
   guidance. Hard guarantees move to **observability + budget alerts**:
   - SSE event `skill.injected` with `totalTokens` per dispatch.
   - Per-cycle cost-attribution that breaks out "skill cache creation"
     vs "task input/output". Dashboard surfaces top 5 cost-heavy agents.
   - Alert when an agent's monthly skill-related spend exceeds 1.5×
     its rolling 30-day median.

5. **Skills can declare required tools — YES.** Extend the skill
   frontmatter with `requires_tools: string[]` (e.g.
   `[Bash, WebFetch]`). At dispatch time, the runtime takes the union of
   the agent's default `allowedTools`, the phase's defaults
   (`EXECUTE_PHASE_DEFAULT_TOOLS`), and every assigned skill's
   `requires_tools`. The recursive-Task guard
   (`execute-phase.ts:147`) stays intact — `Task` is never added by a
   skill. See new §6.5 below for the tool-widening contract.

6. **v23 ships BOTH skills AND tools. Continue refining both.**
   Reframe v23 as the "skills + tools capability layer." Tools v1 = the
   existing Claude Code `allowedTools` widening per #5 — no new MCP
   server yet. v24+ adds the MCP surface for AgentForge-native tools
   (agent dispatch, KB lookup, memory query, cost-aware fallbacks).
   The catalog package is renamed/scoped so future MCP wrappers live
   alongside skills: `packages/capabilities-catalog/{skills,tools}/`.

7. **No minimum-skill requirement — selective injection.** Agents that
   run a single scripted task or pure-data passthrough (file-reader,
   yaml-doctor, some utility haiku agents) should receive ZERO skills
   when synthesis judges they don't need them. But:
   - **Don't pre-block opportunities.** If a coding agent normally
     needs planning + brainstorming skills only for design tasks, give
     it those skills but let the dispatch path **opt-in per-task**
     (skill receives a `applies_to_tasks: [...]` predicate in
     frontmatter and is only injected when the current task matches).
   - **Phase C validator** removes the "min 1 skill" rule. It only
     enforces that referenced skill IDs resolve, that per-tier
     guidance caps are respected (with allowed override), and that
     `requires_tools` references real Claude Code tool names.

---

## 11. Flywheel: Learnings → Skill Refinement (v23.5)

```
.agentforge/memory/*.jsonl  (curator-curated lessons)
        │
        ▼
┌──────────────────────────────────────────┐
│ SkillCurator (new, runs in `learn` phase)│
│ - Group learnings by topic + agent       │
│ - For each group:                        │
│   • Match against existing skill bodies  │
│     by tag overlap + cosine similarity   │
│   • If match (≥0.75 sim):                │
│       → refine: open PR amending the     │
│         skill body + bumping `version:`  │
│   • If no match + ≥3 cycles converge:    │
│       → propose: write draft to          │
│         skills-catalog/_proposed/<id>.md │
│         and surface in dashboard inbox   │
└──────────────────────────────────────────┘
        │
        ▼
Operator reviews PR / approves proposal
        │
        ▼
Catalog updated → next forge re-synthesises
        │
        ▼
Affected agents reload with refined skill bodies
```

Operator commands (v23.5):

```bash
agentforge skills propose-from-learnings    # batch run the curator
agentforge skills approve-proposal af-new-x # accept a draft
agentforge skills diff-versions af-tdd      # view body change history
```

This is the missing closed-loop link: today's `learnings_seed` ends as
inline prose in the system prompt, never gets explicitly versioned, and
operators can't see what changed across cycles. After v23.5, every
cycle's lessons either improve an existing skill (visible PR) or
propose a new one (visible draft).

---

## 12. Tools Surface (v23 scope clarification)

Tools land in two tiers:

### Tier 1 — Claude Code tool widening (v23, ships with skills)

Today the executor passes `allowedTools: ['Read','Write','Edit','Bash',
'Glob','Grep']` (`execute-phase.ts:149`). v23 adds:

- **Per-skill `requires_tools: string[]` in frontmatter.** Resolved at
  `loadAgentConfig` time; runtime takes the union with the phase
  defaults.
- **Per-agent override** in YAML: `allowed_tools_extra: ['WebFetch']`
  for agents that need ambient access regardless of skill.
- **Never adds `Task`.** Recursive subagent dispatch stays guarded.

### Tier 2 — AgentForge-native MCP servers (v24+)

Out of scope for v23. Future MCP wrappers will live at
`packages/capabilities-catalog/tools/` and follow the same versioning +
per-agent assignment pattern as skills. Candidates:

- `af-mcp-agent-dispatch` — programmatic agent invocation from inside
  another agent's session.
- `af-mcp-kb-lookup` — query the knowledge bases (Subsystem C) without
  loading a full file.
- `af-mcp-memory-query` — structured access to `.agentforge/memory/*.jsonl`
  with filters.
- `af-mcp-cost-fallback` — let an agent self-downgrade Opus→Sonnet
  mid-task when it judges the work simpler than estimated.

The framework should be designed so these can be added incrementally —
each as a separate `packages/capabilities-catalog/tools/<name>/` package
with a stable MCP manifest.

---

## 13. UI & Reporting (user request, 2026-05-18)

Skills and tools must be **first-class citizens** in every reporting
surface, with cost attribution at the input/output/tool/skill level.

### 13.1 Backend data model

Extend `cycle.json`, `phase-*.json`, and `agent-run` records with:

```ts
interface CostBreakdown {
  inputTokens:  { count: number; usd: number };
  outputTokens: { count: number; usd: number };
  cacheCreation: { tokens: number; usd: number };  // cache writes (system prompt, skills)
  cacheRead:     { tokens: number; usd: number };  // cache hits
  toolUse: {
    [toolName: string]: { invocations: number; usd: number };
  };
  skillsLoaded: {
    [skillId: string]: { tokens: number; cacheCreationUsd: number; cacheReadUsd: number };
  };
  totalUsd: number;
}
```

New JSONL: `.agentforge/memory/cost-attribution.jsonl` — one record per
agent-run with the full breakdown. Curator reads this for the §11
flywheel: "this agent's `Bash` tool use exceeded N$ across M cycles —
worth optimizing?"

### 13.2 New v5 API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v5/cycles/:id/cost-breakdown` | full per-phase + per-agent + per-skill rollup for one cycle |
| `GET /api/v5/agents/:id/cost-history?since=` | rolling cost-per-agent over N days, with per-tool + per-skill split |
| `GET /api/v5/skills/cost-summary` | total usd attributed to each skill across all cycles (drives "is this skill worth its tokens?" decisions) |
| `GET /api/v5/tools/cost-summary` | total usd attributed to each tool name (`Bash`, `WebFetch`, etc.) |

### 13.3 Dashboard surfaces

| Page | New UI |
|---|---|
| `/cycles/:id` — Overview | Cost tile shows 4 sub-bars: input · output · tool · skill cache. Hover for breakdown. |
| `/cycles/:id` — new **Skills tab** | Table of every skill injected this cycle: id · agents loaded into · cold-boot $ · warm-call $ · total $. |
| `/cycles/:id` — new **Tools tab** | Table of every Claude Code tool invoked: name · invocations · total $ · agents that used it. |
| `/agents/:id` — Overview KPI strip | Add "Skills equipped" count + "Tools used (30d)" pill. |
| `/agents/:id` — new **Capabilities tab** | List assigned skills (with body preview, version, upstream provenance) + `requires_tools` derived widening. |
| `/cost` | New stacked-area chart: cost split by (input vs output vs cache-create vs cache-read vs tool-use). New top-10 list of "most expensive skills" and "most expensive tools." |
| `/flywheel` | New section "Skill Refinement Pipeline": how many proposed skills are pending review, how many refinement PRs are open, average time-to-merge. |
| `/skills` (new page) | Catalog browser. Per-skill: body, frontmatter, upstream ref, agents that have it, lifetime cost, recent refinement PRs. Operator can run `agentforge skills add` from here. |
| `/tools` (new page) | Mirror of `/skills` but for Claude Code tools + future MCP tools. |

### 13.4 Status line + topbar

Topbar adds a `Skills: <N>` pill next to existing `Agents: <N>` /
`Cycles: <N>` pills, click navigates to `/skills`.

Status line at the bottom adds a 5th tile: rolling 1-hour skill-related
spend (so operators see if a skill catalog change is unexpectedly
expensive in real time).

### 13.5 Where the data comes from

- **Per-token costs** — already produced by transports (`anthropic-sdk-transport.ts:350-385` for SDK; CLI returns `total_cost_usd` per response). Add input/output split (SDK has it; CLI rolls it into `total_cost_usd` — need to read `usage.input_tokens` + `usage.output_tokens` from the structured response and recompute the split using `MODEL_PRICING`).
- **Cache costs** — SDK transport already breaks out `cache_creation_input_tokens` and `cache_read_input_tokens`. CLI returns them in the `usage` block.
- **Tool-use costs** — currently invisible. Need to instrument: each
  `tool_use` content block carries an output_token cost (the model's
  thinking tokens before the tool call). Sum these per-tool-name.
- **Skill costs** — derivable: when `loadAgentConfig` injects skills,
  it records `{ agentRunId, skillIds, totalTokens }`. The cache-creation
  cost of that prompt prefix is then attributed pro-rata across the
  injected skill IDs based on their token contributions.

### 13.6 Scope (which spec / which sprint)

This UI work doesn't fit cleanly in the v23 implementation sprint —
the data model has to land first. Sequence:

1. **v23 sprint 1** — catalog package + injection mechanism + pilot
   (PR per §8). Skills work; no UI yet; cost attribution still flat.
2. **v23 sprint 2** — extend `CostBreakdown` schema + record `skillsLoaded` and `toolUse` rollups in cycle.json + new v5 endpoints (13.2).
3. **v23 sprint 3** — dashboard surfaces (13.3), `/skills` + `/tools`
   pages, topbar/statusline integration (13.4).
4. **v23.5** — flywheel/curator integration (§11) lights up the
   `/flywheel` skill-refinement pipeline view.

Each sprint is a separate PR; the UI changes are not blocked on the
flywheel curator (§11) and can land in parallel.

---

## Strongest Recommendations (5 bullets)

- **Ship skills as cached system-prompt prefix injected at
  `loadAgentConfig`** — one mechanism for both transports, uses
  existing ephemeral caching, no CLI flag changes, no transport
  branches, mirrors the established `injectFreshContext` +
  `injectAgentDms` pattern.
- **Store skills under `packages/skills-catalog/skills/{anthropic,
  superpowers,agentforge}/af-<id>.md`** with YAML frontmatter and a
  `upstream`/`upstream_ref` field — gives every fork a visible
  provenance and a normal git diff workflow for upgrades.
- **Make skill assignment Opus's job in Phase B synthesis**, add
  `skill_ids: string[]` to `TeamPlanAgentSchema`, enforce per-tier caps
  (opus≤4, sonnet≤6, haiku≤8) plus a 1500-token-per-skill hard limit in
  Phase C validation.
- **Pilot with one agent + one skill** (`fastify-v5-engineer` +
  `af-tdd`) in a ~300 LOC PR that introduces the catalog package, the
  schema field, the injection point, and one integration test —
  before adapting all 24 specialists.
- **Defer `tool_use`, MCP servers, and `.claude/agents/*.md` subagent
  propagation to v24.** v23 ships skills only; AgentForge-native
  "tools" should be designed against a stable MCP surface after the
  skills layer has been observed in two cycles.
