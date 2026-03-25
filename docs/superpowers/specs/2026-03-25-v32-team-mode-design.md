# v3.2 Team Mode Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Approach:** B — Session Runtime First (extend AgentForgeSession)
**Version Target:** v3.2.0

---

## Overview

v3.2 introduces **Team Mode** — a persistent runtime where Claude Code drops to a minimal tier (Haiku or Sonnet), agents communicate peer-to-peer via the MessageBus, and autonomy level adapts to team composition. The user activates the team, gives tasks naturally, watches a structured activity feed, and deactivates when done.

### Core Problem

Current flow: User → Claude Code (Opus) → launches agent → reviews results (Opus) → passes to next agent (Opus) → repeat. Every handoff burns Opus tokens on relay work, defeating the cost model.

Target flow: User → Claude Code (Haiku conduit) → activates session → Sonnet leads dispatch Haiku agents → results route peer-to-peer → Opus only on strategic escalation.

### Design Principles

- **No new architecture.** Extend AgentForgeSession, MessageBus, and control loop. Everything needed exists; v3.2 wires it differently.
- **Team composition determines autonomy.** The presence of strategic Opus agents enables full autonomy. Coding-only teams need human supervision.
- **Claude Code is a conduit, not a coordinator.** In team mode, it routes messages, formats the feed, and handles user interaction. It does not reason about agent work.
- **Opus is for strategy, not coordination.** CTO frames missions and resolves conflicts. It never relays results or dispatches Haiku coders.

---

## 1. Activation & Lifecycle

### Commands

- `/agentforge:activate` — Enters team mode. Loads `team.yaml`, instantiates a persistent `AgentForgeSession`, drops Claude Code tier, wires peer-to-peer messaging. Prints team roster and autonomy level.
- `/agentforge:deactivate` — Exits team mode. Serializes session state to disk (hibernation), restores Claude Code to its original tier.

### Autonomy Detection

On activation, the session inspects team composition:

| Team Composition | Autonomy Level | Claude Code Tier |
|---|---|---|
| Has Opus strategic agents (CTO, VPs, Lead Architect) | Full | Haiku — just routing messages |
| Has Sonnet leads but no Opus strategists | Supervised — surfaces decision points for user approval | Sonnet |
| All Haiku coders | Guided — runs in bursts, waits for user direction | Current tier (unchanged) |

Override with flag: `/agentforge:activate --mode full|supervised|guided`

### Session Lifecycle States

```
inactive → activating → active → hibernating → hibernated
                                ↘ deactivating → inactive
```

- `activating` — loading team, detecting autonomy, wiring bus, dropping tier
- `active` — control loop running, bus draining continuously
- `hibernating` — serializing state to disk
- `hibernated` — state on disk, session not running, resumable
- `deactivating` — restoring Claude Code tier, cleaning up

### Claude Code Tier Escalation

During full autonomy, Claude Code runs as Haiku. If the user asks a direct question that requires reasoning (not a feed query), Claude Code escalates itself to Sonnet for that one response, then drops back to Haiku. This is the only scenario where Claude Code self-escalates.

---

## 2. Peer-to-Peer Messaging

### Agent Addressing

Each agent gets an address on the MessageBus: `agent:{agent-name}` (e.g., `agent:cto`, `agent:core-platform-lead`). Claude Code gets `conduit:user`. User messages go through the conduit, not directly on the bus.

### Message Types

| Type | Purpose | Example |
|---|---|---|
| `task` | Work assignment | Lead dispatches coding task to Haiku report |
| `result` | Completed work flowing back | Haiku coder returns implementation to lead |
| `escalation` | Agent can't handle it | Coder escalates to lead, lead escalates to CTO |
| `decision` | Strategic choice to be logged | CTO picks JWT over sessions for auth |
| `status` | Progress update for feed | Agent reports 50% through task |
| `direct` | DM between any two agents or user-to-agent | User DMs the CTO |

### Routing Rules

- Messages between agents go direct on the bus. No Claude Code intermediation.
- Sonnet leads dispatch to their Haiku reports directly. Results flow back to the lead, not to Opus.
- Opus agents only receive `escalation` and `decision` messages, plus direct tasks from the user.
- The delegation graph from `team.yaml` validates routing — agents dispatch to their reports by default. Peer collaboration is allowed (`peer_collaboration: true` in team.yaml). CTO can pull and re-delegate any task regardless of graph position.

### Delivery

- Messages queued on the bus with priority (existing infrastructure).
- In team mode, `drain()` runs continuously in the control loop instead of one-shot.
- Failed deliveries (agent errors, budget exhaustion) generate an `escalation` message to the sender's lead.

### User ↔ Agent Communication

- `@cto what's our testing strategy?` → conduit publishes `direct` message to `agent:cto`
- `build the auth module` → conduit publishes `task` message, smart router picks recipient
- Any agent can publish `status` messages that surface in the feed

---

## 3. Activity Feed & Observability

### Feed Display

A structured, scrolling log of team activity — like watching a Slack workspace:

```
[CTO → Lead Architect]  decision: Auth module should use JWT, not sessions
[core-platform-lead]    dispatched 3 agents for type system work
[type-implementer]      ✓ completed: AgentAddress type
[budget]                $0.08 spent / $1.00 cap (8%)
```

### Feed Rules

| Source | Display Treatment |
|---|---|
| `decision` and `escalation` messages | Full content always |
| `task` dispatch from leads | One-liner ("dispatched N agents for X") |
| `result` from Haiku coders | Completion marker only, unless failed |
| `status` updates | Inline, collapse consecutive from same agent |
| `direct` messages involving user | Full content always |
| Cost milestones (25%, 50%, 75%, 90%) | Always surface |

### Feed Storage

Feed entries append to `.agentforge/sessions/{sessionId}/feed.jsonl`. One JSON object per line:

```json
{
  "timestamp": "2026-03-25T15:30:00Z",
  "source": "agent:core-platform-lead",
  "target": "agent:type-implementer",
  "type": "task",
  "summary": "Implement AgentAddress type",
  "content": "..."
}
```

Survives hibernation. Replayable on resume.

### Feed Queries

User can ask about team activity without invoking agents. Claude Code reads recent feed entries: "what's the CTO working on?" scans the feed, doesn't invoke the CTO.

---

## 4. Task Routing & CTO Framing

### First Task — CTO Framing

The first task after activation goes to the CTO. The CTO frames the mission: breaks it into workstreams, assigns to leads, sets success criteria, logs the decision. One Opus invocation that pays for itself by setting direction for all downstream work.

### Subsequent Tasks — Smart Router

A Sonnet-tier router (extending `TaskComplexityRouter`) analyzes the task and picks an entry point:

| Task Signal | Routes To |
|---|---|
| Strategic/architectural ("change our approach to...") | CTO |
| Domain-specific coding ("add validation to the scanner") | Relevant Sonnet lead |
| Simple/mechanical ("fix the typo in config.ts") | Haiku coder directly |
| Research ("what frameworks support X?") | R&D lead |
| Cross-cutting ("refactor how teams communicate") | Lead Architect |
| Ambiguous | CTO (safe default) |

### Direct Messaging

User bypasses routing entirely: `@core-platform-lead add a new scanner for Docker` goes straight to that agent. No CTO invocation, no router invocation.

### CTO Pull

The CTO agent subscribes to the feed. If it sees misrouted work or conflicting decisions between leads, it can pull the task and re-delegate. This happens peer-to-peer on the bus — not through Claude Code.

### Cost Guard

For tasks where the target agent is explicitly named or the pattern is clearly mechanical, routing is skipped entirely — zero overhead.

---

## 5. Session Hibernation

### Trigger

Session hibernates on:
- Conversation ends (Claude Code exit)
- User runs `/agentforge:deactivate`
- Budget exhaustion

### Serialized State

Written to `.agentforge/sessions/{sessionId}/`:

| File | Contents |
|---|---|
| `session.json` | Session config, autonomy mode, Claude Code tier, activation time |
| `state.json` | Active agents, in-flight tasks, message bus queue |
| `feed.jsonl` | Full activity feed (persisted in real-time) |
| `knowledge.json` | KnowledgeStore entries from this session |
| `decisions.json` | DecisionLog entries |
| `cost-entry-*.json` | Cost artifacts (already persisted) |
| `delegation-state.json` | Open delegation chains, pending results |

### Resume

`/agentforge:activate` with no flags checks for a hibernated session:

```
> Found hibernated session abc123 (3 tasks in flight, $0.12 spent)
> Resume this session? [Y/n]
```

On resume: deserialize state, re-queue pending messages, restore agent contexts, continue control loop. Feed shows a `[session resumed]` marker.

### Staleness Detection

If the codebase changed since hibernation (git commits touching files that in-flight tasks reference):

```
> ⚠ 4 files modified since hibernation. Affected tasks:
>   - type-implementer: AgentAddress type (src/types/message.ts changed)
> Re-dispatch affected tasks? [Y/n]
```

### Cleanup

Old sessions expire after 7 days. `/agentforge:sessions` lists all sessions (active, hibernated, completed) with cost summaries.

### North Star: Background Execution

Session hibernation is the foundation for true async execution. The serialized session format becomes the contract — a background process picks up `session.json` and runs the control loop without Claude Code in the path. CTO owns this roadmap item. Target: v3.3+.

---

## 6. Sprint Structure

### Sprint 1 — Activation Core

- Activate/deactivate commands with lifecycle state machine
- Claude Code tier drop (Haiku/Sonnet/current based on autonomy detection)
- Peer-to-peer messaging: agent addressing (`agent:{name}`), message types, bus routing
- Delegation graph validation on the bus (agents only dispatch to their reports)
- Continuous drain loop (control loop runs the bus instead of one-shot)
- Basic activity feed (all messages print, no tiered formatting yet)

### Sprint 2 — Intelligence & Routing

- Autonomy detection from team composition (full/supervised/guided)
- Manual override flag (`--mode`)
- CTO framing for first task
- Smart router for subsequent tasks (extends TaskComplexityRouter)
- Direct messaging (`@agent-name` syntax)
- CTO pull (subscribe to feed, re-delegate misrouted work)
- Tiered feed formatting (decisions full, dispatches one-liner, completions marker-only)
- Cost milestones in feed

### Sprint 3 — Persistence & Polish

- Session hibernation (serialize/deserialize full state)
- Resume with staleness detection
- Session listing and cleanup (`/agentforge:sessions`)
- Feed storage to `feed.jsonl` with replay on resume
- `@agent` listing/completion
- North star roadmap item: background execution via remote triggers (CTO-owned)

### Test Targets

Each sprint ships with tests covering its surface area. Sprint 1 is heaviest — it changes the execution model.

### Version

v3.2.0 on completion of Sprint 3.

---

## Dependencies

- **v3.1 must be complete.** v3.2 assumes Genesis is the authority, v3 session is the default CLI path, and the control loop is wired. Gaps M1, M5, M6 from the gap matrix must be closed.
- **Existing infrastructure used:** MessageBus, AgentForgeSession, control-loop.ts, delegation-manager.ts, CostAwareRunner, BudgetEnvelope, KnowledgeStore, DecisionLog, TaskComplexityRouter, SpeakerSelector.
- **New files anticipated:** activation command, session lifecycle manager, agent address registry, feed formatter, smart task router, session serializer/deserializer.

---

## Cost Model

| Scenario | Current (v3.1) | v3.2 Team Mode |
|---|---|---|
| Claude Code tier during agent work | Opus (max) | Haiku (full autonomy) |
| Agent-to-agent relay | Through Opus Claude Code | Direct on MessageBus |
| Result review | Opus reads every result | Sonnet lead reviews, Opus only on escalation |
| Task routing | User manually picks agent | Sonnet router or direct @mention |
| Coordination overhead | ~40% of session cost | ~5% of session cost |

Estimated savings: 60-80% reduction in coordination token spend on top of v3.1's model routing savings.
