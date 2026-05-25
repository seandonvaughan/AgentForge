# Agent Skills Tooling Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class skill and tool governance so AgentForge agents can self-improve across Codex CLI, Codex UI, and a later Claude host surface without coupling every host to one plugin wrapper.

**Architecture:** Keep skills host-neutral in `packages/skills-catalog`, attach them to agents through explicit YAML references, and let each runtime translate the resulting capabilities into its own transport/tool contract. The first wave should reuse the existing `skill_ids` injection path, the current memory JSONL feedback loop, and repo-local Codex MCP tools before adding new UI controls.

**Tech Stack:** TypeScript, Node.js, Vitest, SvelteKit dashboard, AgentForge CLI, Codex CLI transport, MCP tools, YAML-backed skills catalog, `.agentforge/memory/*.jsonl`.

---

## Current Baseline

AgentForge already has the core parts needed for a small, durable wave:

- `packages/skills-catalog` loads markdown skills with structured frontmatter.
- `packages/core/src/agent-runtime/agent-factory.ts` injects skill bodies into runtime prompts from `skill_ids`.
- `.agentforge/agents/*.yaml` currently uses a mix of agent capability fields; several agents expose `skills`, while the runtime injection path expects `skill_ids`.
- `packages/core/src/skills/flywheel` clusters low-quality memory entries and proposes skill files.
- `packages/cli/src/commands/skills.ts` exposes proposal, approval, and listing commands.
- `plugins/agentforge-codex` exposes a Codex host surface through MCP and uses the existing CLI/build outputs.
- Dashboard agent detail pages already load raw YAML and show memory/config surfaces, making them the right first UI home for skill attachment controls.

## Skill Categories

The first wave should define a small taxonomy before adding more skills. The taxonomy should be encoded in skill frontmatter tags and reflected in CLI/UI filters.

| Category | Purpose | Initial examples | Runtime impact |
| --- | --- | --- | --- |
| Planning | Improve task decomposition, risk discovery, and phased execution | `af-plan-wave`, `af-scope-check` | Prompt-only, no special tools required |
| Implementation | Improve code edits, local conventions, and host-specific runtime work | `af-codex-runtime`, `af-file-edit-discipline` | May request filesystem and shell tools |
| Verification | Force evidence before completion and align checks with changed surfaces | `af-verify-before-done`, `af-dashboard-check` | Requires shell/test tools |
| Review | Improve bug/security review and reduce stale findings | `af-code-review-grounding`, `af-security-review` | Requires file read and test result inspection |
| Memory | Convert cycle evidence into durable lessons and skill proposals | `af-memory-curation`, `af-learning-triage` | Requires memory read/write tools through approved AgentForge paths |
| Host Bridge | Map host differences without forcing one universal plugin wrapper | `af-codex-cli-bridge`, `af-codex-ui-bridge`, later `af-claude-bridge` | Runtime adapter translates capability requests |

Acceptance rule for categories: every approved skill must have at least one category tag, one task-fit tag, a token budget, and a declared tool requirement list, even when the list is empty.

## How Skills Attach To Agents

Use a two-layer attachment model:

1. **Agent baseline skills:** Stored in `.agentforge/agents/<agent-id>.yaml` under canonical `skill_ids`. These are always loaded when the agent runs.
2. **Cycle/task skills:** Added by planner or dispatcher for a specific run. These should not mutate the agent YAML unless the skill is promoted after review.

Implementation tasks:

- [ ] Add a compatibility read path in `loadAgentConfig` that accepts both `skill_ids` and legacy `skills`, with `skill_ids` taking precedence.
- [ ] Add a normalization helper that converts simple legacy names such as `code_review` to catalog ids such as `af-code-review-grounding` only through an explicit mapping file.
- [ ] Add a generated warning when an agent references a skill id that is not present in the catalog; keep the existing non-blocking behavior for runtime execution.
- [ ] Add dashboard display fields for resolved skills, missing skills, and inherited cycle/task skills.
- [ ] Keep host-specific commands out of shared skill bodies unless the skill is explicitly tagged as a Host Bridge skill.

Attachment precedence:

1. Explicit task override skills.
2. Planner-assigned cycle skills.
3. Agent `skill_ids`.
4. Domain/team default skills from templates.
5. Mandatory guardrail skills selected by runtime policy.

The runtime prompt order should remain stable:

```text
base system prompt
## Skills
## Learnings
## Fresh Context
## Direct Messages
```

## Memory Feedback Loop

The self-improvement loop should stay evidence-driven and local-first:

1. Execution and review phases emit `self-eval.jsonl`, `step-scores.jsonl`, `gate-verdict.jsonl`, and `skill-proposals.jsonl` entries.
2. `clusterLowQuality` groups repeated low-score capability tags.
3. `proposeSkill` creates a proposed skill under `packages/skills-catalog/skills/agentforge/_proposed/`.
4. A human or policy-approved agent reviews the proposal.
5. Approval moves the skill to an approved catalog path and records an audit row.
6. The planner can attach the approved skill to agents or cycle tasks.
7. Later runs measure whether the skill improves scores for the same capability tag.

Minimum memory schema additions for this wave:

```json
{
  "type": "skill-effect",
  "skillId": "af-verify-before-done",
  "agentId": "code-reviewer",
  "cycleId": "cycle-abc123",
  "capabilityTag": "verification",
  "beforeScore": 0.48,
  "afterScore": 0.72,
  "acceptedAt": "2026-05-25T00:00:00.000Z"
}
```

The learning loop should not auto-promote a skill based on one successful run. Promotion should require at least three comparable observations or one explicit user approval.

## CLI Controls

Extend the existing `agentforge skills` command family before adding new standalone commands.

| Command | Purpose |
| --- | --- |
| `agentforge skills list --json` | List catalog skills, categories, required tools, and approval status. |
| `agentforge skills attach --agent <id> --skill <id>` | Add a baseline skill to an agent YAML file after validating the skill exists. |
| `agentforge skills detach --agent <id> --skill <id>` | Remove a baseline skill while preserving unrelated YAML fields. |
| `agentforge skills recommend --agent <id> --from-memory` | Read recent low-quality clusters and recommend candidate skills. |
| `agentforge skills propose-from-learnings --dry-run` | Keep the existing proposal path as the no-write preview. |
| `agentforge skills approve-proposal <id>` | Keep approval gated by typecheck and audit logging. |

CLI behavior requirements:

- Use structured YAML parsing/writing with `js-yaml`, never regex edits to agent YAML.
- Preserve unrelated agent YAML fields and comments where feasible; if comment preservation is not practical, call that out in command output before writing.
- Support `--project-root` and `AGENTFORGE_PROJECT_ROOT`.
- Print machine-readable output with `--json` for Codex UI and MCP callers.
- Validate that required tools are supported by the selected runtime before launching the agent.

## Codex UI Controls

The first UI controls should be narrow and operational:

- Agent detail Config tab: show resolved skill ids, missing skill ids, categories, and required tools near the raw YAML editor.
- Agent detail Memory tab: show low-quality clusters and skill recommendations filtered to the selected agent.
- Cycle launch: allow optional task-scope skills for the run, separate from baseline agent skills.
- Settings or Skills page: list catalog skills, proposals, approval status, and recent effect measurements.
- MCP tools: add read-only skill catalog and recommendation tools first; defer write tools until CLI attach/detach behavior is covered.

Codex UI must keep destructive actions explicit. Attaching, detaching, approving, and rejecting skills should be separate commands with visible previews and no hidden bulk mutation.

## Host Controls

Host-specific wrappers should stay thin:

- **Codex CLI:** pass selected skills through `loadAgentConfig`, translate tool requirements into Codex-compatible runtime options, and respect Codex sandbox constraints.
- **Codex UI:** use CLI JSON and MCP read tools for catalog/recommendation display; call CLI write commands only after preview and confirmation.
- **Later Claude:** add a Claude bridge that maps the same catalog metadata to Claude Code concepts, without changing the shared skill markdown format unless the shared contract genuinely needs a new field.

The shared contract is the skill catalog, agent YAML attachment, and memory evidence. The host wrappers own manifest, packaging, launch semantics, and tool translation.

## Acceptance Tests

Run focused tests during each task and the broader gate before merging.

### Catalog And Attachment

- `corepack pnpm exec vitest run packages/skills-catalog/__tests__/catalog.test.ts`
- `corepack pnpm exec vitest run tests/agent-runtime/skills-injection.test.ts`
- Add tests proving:
  - `skill_ids` still injects known skills.
  - legacy `skills` can be resolved through an explicit mapping.
  - `skill_ids` takes precedence when both fields exist.
  - unknown skill ids warn and do not block config loading.

### CLI

- `corepack pnpm exec vitest run tests/cli/skills-coverage.test.ts`
- Add command tests proving:
  - `skills list --json` includes category tags and required tools.
  - `skills attach` validates catalog ids and writes canonical `skill_ids`.
  - `skills detach` removes only the requested skill id.
  - `skills recommend --from-memory` ranks skills by matching capability tags.

### Memory Loop

- `corepack pnpm exec vitest run tests/core/skills/flywheel/cluster-low-quality.test.ts`
- `corepack pnpm exec vitest run tests/core/skills/flywheel/propose-skill.test.ts`
- Add tests proving:
  - skill-effect rows are parsed defensively.
  - promotion recommendations require enough observations.
  - proposals include category, applies-to, and required-tool metadata.

### Dashboard

- `corepack pnpm --filter @agentforge/dashboard check`
- `corepack pnpm --filter @agentforge/dashboard build`
- Add dashboard tests proving:
  - agent detail shows resolved and missing skills.
  - cycle launch can add task-scope skills without mutating agent YAML.
  - proposal lists render approved/proposed/rejected states without duplicate keys.

### Codex Runtime And MCP

- `corepack pnpm build`
- `node packages/cli/dist/bin.js codex readiness --project-root . --skip-login`
- `AGENTFORGE_RUNTIME=codex-cli node packages/cli/dist/bin.js run invoke --project-root . --runtime codex-cli --agent code-reviewer --task "Return a short skill readiness summary."`
- Add MCP tests proving:
  - skill catalog read tool returns deterministic JSON.
  - recommendation tool refuses project roots outside `AGENTFORGE_PROJECT_ROOT`.
  - launch preview includes task-scope skills and required tools.

### Full Gate

- `corepack pnpm lint`
- `corepack pnpm build`
- `corepack pnpm exec vitest run --reporter=dot`
- `corepack pnpm --filter @agentforge/dashboard check`
- `corepack pnpm --filter @agentforge/dashboard build`
- `git diff --check`

## Rollout Phases

### Phase 0: Contract Freeze

- [ ] Document the canonical skill frontmatter fields and category taxonomy.
- [ ] Decide the explicit legacy `skills` to `skill_ids` mapping for existing agents.
- [ ] Confirm Codex CLI, Codex UI, and later Claude wrappers can consume the same catalog metadata.

Exit criteria: the taxonomy and attachment precedence are documented, and no code path requires a universal host wrapper.

### Phase 1: Runtime Attachment

- [ ] Implement `skill_ids` plus legacy `skills` compatibility in `loadAgentConfig`.
- [ ] Add tests for prompt order, missing skills, and precedence.
- [ ] Add required-tool compatibility checks to runtime launch preview.

Exit criteria: agents receive the expected skill bodies in Codex CLI runs, and unknown skills do not block execution.

### Phase 2: CLI Management

- [ ] Add `skills list --json`.
- [ ] Add `skills attach`.
- [ ] Add `skills detach`.
- [ ] Add `skills recommend --from-memory`.
- [ ] Extend command tests for YAML preservation and validation errors.

Exit criteria: all baseline skill attachment can be managed through the CLI without manual YAML edits.

### Phase 3: Memory Measurement

- [ ] Add `skill-effect` memory rows.
- [ ] Record skill ids used during each agent run.
- [ ] Link step scores to active skills.
- [ ] Require enough observations before recommending promotion.

Exit criteria: recommendations can explain why a skill should be created, refined, attached, or left alone.

### Phase 4: Codex UI And MCP Read Surfaces

- [ ] Add skill catalog read endpoint or MCP tool.
- [ ] Add agent-level resolved skill display.
- [ ] Add proposal and recommendation views.
- [ ] Add cycle launch task-scope skill selector.

Exit criteria: Codex UI can inspect and stage skill changes while preserving CLI as the write authority.

### Phase 5: Controlled Writes From UI

- [ ] Wire UI attach/detach actions through CLI-equivalent server handlers.
- [ ] Show previews before writing agent YAML.
- [ ] Add audit rows for UI-originated mutations.
- [ ] Add Playwright coverage for attach/detach and proposal approval.

Exit criteria: UI writes produce the same file changes and audit evidence as CLI writes.

### Phase 6: Claude Bridge

- [ ] Add Claude host bridge metadata only where the shared catalog cannot describe a host need.
- [ ] Keep Claude manifest/package changes outside the Codex plugin wrapper.
- [ ] Add bridge tests proving shared skills render correctly for Claude and Codex agents.

Exit criteria: Claude support reuses shared skills and memory evidence while keeping host-specific launch semantics isolated.

## Risks And Guardrails

- Do not auto-approve or auto-attach generated skills without review evidence.
- Do not let a host bridge skill leak Codex-only commands into general-purpose agents.
- Do not mutate `.agentforge/agents/*.yaml` through ad hoc string edits.
- Do not collapse Codex and Claude packaging into one wrapper unless their manifest and runtime contracts converge.
- Do not count a proposal as successful until later memory shows improved scores for the target capability tag.

## First Concrete Slice

The next implementation slice should be Phase 1 plus the smallest part of Phase 2:

1. Add compatibility for `skill_ids` and mapped legacy `skills`.
2. Add tests in `tests/agent-runtime/skills-injection.test.ts`.
3. Add `agentforge skills list --json`.
4. Add a read-only dashboard/MCP skill catalog surface only after the CLI JSON shape is stable.

This slice is small enough to verify locally and useful immediately for Codex CLI and Codex UI. It also leaves Claude support as a later bridge instead of forcing premature cross-host abstraction.
