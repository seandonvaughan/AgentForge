---
description: Run a predefined multi-agent workflow
argument-hint: <workflow-name> [--param key=value ...]
---

# AgentForge Workflow

Run a predefined multi-agent workflow that coordinates multiple agents through a sequence of stages with dependency management.

## Usage

```
/agentforge:workflow <workflow-name> --param key=value [--param key2=value2 ...]
```

Examples:
```
/agentforge:workflow code-review --param targetFile=src/foo.ts --param targetDescription="Add error handling"
/agentforge:workflow bug-investigation --param bugDescription="Null pointer in parser module"
/agentforge:workflow feature-design --param featureDescription="Add caching layer to knowledge store"
/agentforge:workflow knowledge-sync --param topic="test infrastructure"
```

List available workflows:
```
/agentforge:workflow
```

## What to Do

### If no workflow name is provided:

1. List all available workflows with their descriptions:
   ```
   Available workflows:
     code-review         — End-to-end code review: gather context, implement changes, review, and address feedback.
     bug-investigation   — Systematic bug investigation: reproduce, root-cause analysis, fix, and verify.
     feature-design      — Feature design pipeline: architect designs, CTO approves, coder implements, reviewer validates.
     knowledge-sync      — Knowledge synchronization: scan codebase, extract patterns, produce strategic summary.
   ```

2. For each workflow, show the required parameters:
   ```
   Usage: /agentforge:workflow <name> --param key=value

   code-review:
     Required: targetFile, targetDescription

   bug-investigation:
     Required: bugDescription

   feature-design:
     Required: featureDescription

   knowledge-sync:
     Required: topic
   ```

### If a workflow name is provided:

1. **Validate the workflow exists**. If not, show the available workflows list.

2. **Parse parameters** from `--param key=value` arguments. Validate all required parameters are present.

3. **Show the execution plan** before running:
   ```
   Workflow: code-review
   Stages:
     1. gather-context (researcher) — Gather context for: <description>
     2. implement (coder) — Implement: <description> [depends on: gather-context]
     3. review (team-reviewer) — Review implementation [depends on: implement]
     4. address-feedback (coder) — Address feedback [depends on: review]
   ```

4. **Execute each stage** by invoking the assigned agent (via `/agentforge:invoke`):
   - Execute stages in dependency order
   - Independent stages (no shared dependencies) can run in parallel
   - Pass upstream stage results as context to dependent stages
   - Show progress after each stage completes:
     ```
     [1/4] gather-context (researcher) ... completed (2.3s)
     [2/4] implement (coder) ... completed (5.1s)
     [3/4] review (team-reviewer) ... completed (3.8s)
     [4/4] address-feedback (coder) ... completed (4.2s)
     ```

5. **Report final results**:
   ```
   Workflow complete: code-review
   Stages: 4/4 completed
   Total time: 15.4s

   --- Stage Results ---

   [gather-context] (researcher):
   <result>

   [implement] (coder):
   <result>

   [review] (team-reviewer):
   <result>

   [address-feedback] (coder):
   <result>
   ```

## Available Workflows

### code-review
End-to-end code review pipeline.
- **Stages:** gather-context (researcher) -> implement (coder) -> review (team-reviewer) -> address-feedback (coder)
- **Parameters:** `targetFile`, `targetDescription`

### bug-investigation
Systematic bug investigation pipeline.
- **Stages:** reproduce (debugger) -> root-cause (researcher) -> fix (coder) -> verify (linter)
- **Parameters:** `bugDescription`

### feature-design
Feature design and implementation pipeline.
- **Stages:** design (architect) -> approve (cto) -> implement (coder) -> review (team-reviewer)
- **Parameters:** `featureDescription`

### knowledge-sync
Knowledge synchronization and strategic analysis.
- **Stages:** scan (researcher) -> extract-patterns (meta-architect) -> strategic-summary (ceo)
- **Parameters:** `topic`

## Error Handling

- If a stage fails, skip dependent stages and report partial completion
- Show the error message from the failed stage
- Still display results from completed stages

## Model Routing

Each stage uses the agent's configured model from their YAML. The workflow respects model routing:
- Strategic agents (architect, cto, ceo) use Opus
- Implementation agents (coder, debugger) use Sonnet
- Utility agents (researcher, linter) use Haiku
