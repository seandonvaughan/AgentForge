# reforge

Manage agent runtime overrides and tuning mutations.

## Overview

The `reforge` command handles agent runtime tuning and behavioral adjustments. It operates on agent-level mutations (prompt tweaks, effort adjustments, model tier overrides) and tracks all changes for review and rollback.

The `--upgrade` flag moved to the `rebuild` command.

## Subcommands

### reforge apply

Review and apply a structural reforge proposal to the team.

```bash
agentforge reforge apply <proposal-id>
```

**Behavior:**
- Searches `.agentforge/reforge-proposals/` for a matching proposal file
- Displays the proposal in human-readable format
- Without `--yes`, prompts for confirmation
- With `--yes`, applies immediately and archives the proposal

**Example:**
```bash
agentforge reforge apply 20250325-fix-architect --yes
```

### reforge list

List all pending and applied structural proposals, as well as active agent overrides.

```bash
agentforge reforge list
```

**Output sections:**
- **Structural Proposals**: Pending (`.md` files) and applied (`.applied.md` files)
- **Active Agent Overrides**: Current agent mutations with version, type, and timestamp

### reforge rollback

Rollback an agent override to its previous version.

```bash
agentforge reforge rollback <agent>
```

**Behavior:**
- Looks up the override for the specified agent
- Shows current version
- Reverts to the previous version (if available)
- Prints confirmation

**Example:**
```bash
agentforge reforge rollback code-writer
```

### reforge status

Show reforge override status for all agents in the team.

```bash
agentforge reforge status
```

**Output per agent:**
- Override version (e.g., v2/5)
- Applied timestamp
- Session ID where applied
- Available rollback status
- Detailed mutation list (type, field, old value, new value)
- System prompt preamble preview (if present)
- Model tier override (if present)
- Effort override (if present)

**Example output:**
```
=== Reforge Status ===

code-writer:
  Version:    2/5
  Applied:    2025-03-25T14:32:00Z
  Session:    sess-abc123
  Rollback:   available
  Mutations:
    - [prompt] system_prompt_suffix: "..." → "..."
    - [effort] effort_level: 3 → 4
  Preamble:   "Focus on security-first implementations..."
  Model:      → claude-3-5-sonnet

Total: 1 agent(s) with 2 mutation(s) active.
```

## Flags

- `--yes` — Apply proposal or change without confirmation prompt (used with `apply`)

## Storage

- **Proposals**: `.agentforge/reforge-proposals/{id}.md` (pending) or `.{id}.applied.md` (archived)
- **Overrides**: `.agentforge/agent-overrides/{agent-name}.json`

## Notes

- Reforge mutations are v3 Phase 3f features for runtime agent tuning
- All changes are versioned and reversible
- Escalations during agent runs can trigger automatic reforge proposals

## Exit Codes

- `0` — Success
- `1` — Error (proposal not found, override missing, rollback failed)
