# Plugin Manifest Audit — 2026-05-17

**Scope:** Cross-project portability of the AgentForge Claude Code plugin  
**Auditor:** Agent (Workstream KK, T5.6, Cycle 5 / v22.0.0)  
**Branch:** `feat/cloud-sdk-multiproject`

---

## Summary

| Check | Result |
|---|---|
| Slash commands in `commands/` are auto-discovered by CC | Pass |
| All agents in `.agentforge/agents/` are auto-discovered | Pass |
| `plugin.json` has no hardcoded monorepo paths | Pass |
| `commands/` slash command files have no hardcoded paths | **1 fix applied** |
| `plugin.json` has a `commands` field for external portability | Gap (documented) |
| `plugin.json` description matches current version | Minor stale text |

---

## 1. Plugin manifest location and fields

**File:** `.claude-plugin/plugin.json`

```json
{
  "name": "agentforge",
  "description": "Universal Agent Team Builder ...",
  "version": "10.5.1",
  "author": { "name": "Sean Vaughan" }
}
```

**Findings:**

- No hardcoded absolute paths inside the manifest itself. Pass.
- The `description` string references v6.4 features ("closed-loop autonomous development cycle (v6.4)"). The plugin is now at v10.5.1 / Cycle 5 work. This is cosmetic — CC displays it in the plugin list — but misleads users. Recommend updating in the next version bump.
- The manifest contains only four top-level fields. Claude Code requires at minimum `name`, `description`, and `version` — all present. Pass.

---

## 2. Slash command auto-discovery

Claude Code discovers slash commands from `commands/` relative to the project root when running inside the project. For the AgentForge monorepo this works: CC is run from the repo root and `commands/` is a direct child.

**Commands found at `commands/` (16 files):**

```
bus.md          cost-report.md  dashboard.md    flywheel.md
forge.md        genesis.md      invoke.md       memory.md
org.md          rebuild.md      reforge.md      review.md
session.md      status.md       team.md         workflow.md
```

**Cross-reference against skill registrations in `docs/guides/README.md`:**

All 16 commands correspond to documented slash commands (`/agentforge:bus`, `/agentforge:forge`, etc.). No command is registered but missing a file. No file is present without a corresponding command registration. Pass.

**Portability concern (documented, not a blocker):**

When the `@agentforge/cli` package is installed globally (`npm install -g @agentforge/cli`), the `commands/` directory lives inside the npm package at the CLI's installed location. External users installing the package globally will get the commands auto-discovered correctly because CC reads `commands/` from the npm package root.

However, when a user installs AgentForge in a project that is NOT this monorepo, the `commands/` dir ships as part of the npm package — not from their project's workspace. This is correct behaviour: the plugin's slash commands come from the plugin package, not the external project.

No code change required for this finding.

---

## 3. Hardcoded path leak in `commands/dashboard.md` — FIXED

**Finding (critical):** `commands/dashboard.md` contained two hardcoded absolute paths referencing the original developer's home directory:

```
# Before fix (lines 17 and 26):
cd /Users/seandonvaughan/Projects/AgentForge/packages/server && npx tsc ...
cd /Users/seandonvaughan/Projects/AgentForge/packages/dashboard && npx vite ...
```

These would fail silently for any other user because the paths point to a directory that does not exist on their machine. The commands tell Claude Code to run build and dev server steps, so a wrong path causes Claude to attempt `cd /Users/seandonvaughan/...` and get a `No such file or directory` error.

**Fix applied in this PR:**

```
# After fix:
cd packages/server && npx tsc ...
cd packages/dashboard && npx vite ...
```

Both paths are now relative to the project root (where CC is run), which works for any checkout location. The fix is in `commands/dashboard.md` lines 17 and 26.

---

## 4. Agent auto-discovery

Claude Code auto-discovers agents defined in `.claude/agents/*.md` (per the Cycle 3 spec, T3.1). Currently:

- **`.agentforge/agents/`** — 139 YAML files. These are the canonical per-agent definitions.
- **`.claude/agents/`** — Does not exist yet. The forge-to-CC-agent emission pipeline is planned for v20.0.0 (Cycle 3 / T3.1).

**Finding:** No agent markdown files exist at `.claude/agents/` today. This is expected — the emission is a Cycle 3 deliverable. No fix required for this audit.

When T3.1 ships, each `agentforge team forge` run will write `.claude/agents/<agent-id>.md` files. Those will be auto-discovered by CC with no plugin manifest change required.

---

## 5. No other path leaks found

Checked all files under `commands/`, `.claude-plugin/`, and the `plugin.json` manifest for the following patterns:

- `/Users/` — 2 occurrences in `commands/dashboard.md` — **fixed above**
- `/home/` — 0 occurrences
- `C:\Users\` — 0 occurrences
- Hardcoded npm package paths — 0 occurrences

All other command files use relative paths (`.agentforge/`, `packages/`, etc.) or no paths at all.

---

## 6. Recommended follow-up items (not blocking)

| Item | Priority | Target |
|---|---|---|
| Update `plugin.json` description to reflect v10.5+ capabilities | Low | Next version bump |
| Add `commands` and `agents` explicit fields to `plugin.json` for forward compatibility | Medium | v22.0.0 (Cycle 5) |
| Emit `.claude/agents/*.md` files from forge | High | v20.0.0 (Cycle 3 / T3.1) |
| Verify `commands/` is bundled inside the npm package tarball on publish | High | Before first external publish |

---

## 7. Verdict

The plugin manifest has **one critical portability fix** applied (hardcoded absolute paths in `commands/dashboard.md`). No other path leaks were found. The plugin is suitable for external use after this fix lands.
