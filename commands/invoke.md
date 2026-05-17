---
description: Invoke an agent as a real Claude Code subagent
argument-hint: <agent-name> "<task description>"
---

# AgentForge Invoke

Dispatch a real Claude Code subagent using the specified agent's YAML configuration.
The agent runs with its own system prompt and model, producing a tracked session record.

## Usage

```
/agentforge:invoke <agent-name> "<task description>"
```

Example:
```
/agentforge:invoke cto "assess technical feasibility of v4.4"
```

## What to Do

1. **Read the agent YAML** from `.agentforge/agents/<agent-name>.yaml`:
   - Extract `name`, `system_prompt`, `model`, and `skills`
   - If the file does not exist, stop and report: "Agent '<name>' not found at .agentforge/agents/<name>.yaml"

2. **Map model field to Claude model ID**:
   - `opus`   → `claude-opus-4-6`
   - `sonnet` → `claude-sonnet-4-6`
   - `haiku`  → `claude-haiku-4-5`
   - Any unrecognized value defaults to `claude-sonnet-4-6`

3. **Dispatch a subagent** using the Agent tool with:
   - `description`: `"Running <AgentName> agent: <first 80 chars of task>"`
   - `prompt`: The user's task description verbatim
   - `model`: The mapped Claude model ID (from step 2)
   - The agent's `system_prompt` as the subagent's context/instructions

   The subagent prompt should be structured as:
   ```
   <system>
   <agent-system-prompt-here>
   </system>

   <task>
   <user-task-here>
   </task>
   ```

4. **Capture the result** — the subagent's full response text.

5. **Write a session record** to disk:
   - Generate a session ID: `session-<timestamp>-<random-6-chars>`
   - Write `.agentforge/sessions/<sessionId>.json`:
     ```json
     {
       "sessionId": "<id>",
       "agentId": "<agent-name>",
       "agentName": "<name from yaml>",
       "model": "<mapped model id>",
       "task": "<user task>",
       "response": "<subagent response>",
       "startedAt": "<ISO timestamp>",
       "completedAt": "<ISO timestamp>",
       "estimatedTokens": <rough estimate: (system_prompt.length + task.length + response.length) / 4>
     }
     ```
   - Append a summary entry to `.agentforge/sessions/index.json` (create the array if file doesn't exist):
     ```json
     [
       {
         "sessionId": "<id>",
         "agentId": "<agent-name>",
         "model": "<mapped model id>",
         "task": "<first 120 chars of task>",
         "status": "completed",
         "completedAt": "<ISO timestamp>"
       }
     ]
     ```

6. **Emit bus events** (if a `V4MessageBus` instance is available in context):
   - `agent.invoked` — published before the subagent runs
   - `agent.responded` — published after the subagent returns
   - `agent.error` — published if the subagent throws

7. **Display the result**:
   ```
   ✓ Agent: <AgentName> (<model>)
   ✓ Task: <task description>
   ✓ Session: <sessionId>

   <subagent response>

   Session saved to .agentforge/sessions/<sessionId>.json
   ```

## Flags (future)

- `--budget <usd>` — Optional spend cap (not enforced in v4.4, recorded only)
- `--parallel <agent1,agent2,...>` — Fan-out to multiple agents (P1-3, not yet implemented)

## Model Routing

| YAML `model` | Claude Model ID       | Use When                         |
|-------------|----------------------|----------------------------------|
| `opus`      | `claude-opus-4-6`    | Strategic, complex reasoning     |
| `sonnet`    | `claude-sonnet-4-6`  | General tasks, balanced cost     |
| `haiku`     | `claude-haiku-4-5`   | Simple, fast, low-cost tasks     |

Always respect the agent's configured model. Do not upgrade or downgrade without explicit instruction.

## V4 Integration

- Sessions written to `.agentforge/sessions/` are read by the dashboard Session Timeline
- Bus events from invocations feed the Bus Monitor (when `BusFileAdapter` is active)
- `MetaLearningEngine` reads `sessions/index.json` for flywheel promotion decisions
- Delegation authority checks (`DelegationProtocol`) apply when an agent sub-delegates

---

## Memory parity (T3.3)

When invoking an agent via CC's native `Agent` tool, the `.claude/agents/<id>.md` file is
static (emitted at forge time). To ensure the agent still receives up-to-date memory
context, **prepend a prologue to the task** before passing it to the `Agent` tool.

### How to inject the prologue

Use `prepareCcAgentTask()` from `packages/core/src/agent-runtime/cc-prologue-builder.ts`:

```ts
import { prepareCcAgentTask } from '@agentforge/core/agent-runtime/cc-prologue-builder.js';

const { fullTask } = await prepareCcAgentTask(
  agentId,        // agent identifier (matches .agentforge/agents/<id>.yaml)
  projectRoot,    // workspace root (contains .agentforge/)
  userTask,       // the original user task string
  adapter,        // optional WorkspaceAdapter — enables pending-DM injection
);

// Pass `fullTask` as the `prompt` argument to the CC Agent tool.
```

The returned `fullTask` is structured as:

```
# Fresh context (this cycle)

<recent memory bullets>

# Pending DMs (if any)

<DM block from the comms layer>

---

# Your task

<original user task>
```

### Rules

- **Only prepend when `CLAUDE_CODE_RUNTIME=1`** (i.e. the CC-native invocation path is
  active). The CLI fallback path already injects context into the system prompt via
  `injectFreshContext()` inside `loadAgentConfig()` — do **not** double-inject.
- **Prologue cap:** 16 000 characters (~4 000 tokens). Older memory bullets are dropped
  first if the budget is exceeded. DMs are always preserved in full.
- **DM delivery side-effect:** By default, DMs included in the prologue are marked
  `delivered_at` so they are not re-injected on the next call. Pass
  `{ markDmsDelivered: false }` to suppress this (e.g. dry-run or preview modes).
- **No adapter → no DM block.** When no `WorkspaceAdapter` instance is available, the DM
  section is silently omitted. The memory block is still built from
  `.agentforge/memory/*.jsonl` on disk (no adapter required for memory reading).
