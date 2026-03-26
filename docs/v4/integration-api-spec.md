# AgentForge v4 — Integration API Specification

**Sprint 1.0 Deliverable**
**Status:** Complete
**Owner:** integration-api-architect (Opus)
**Blocks:** All of Phase 1 Sprints 1.1–1.3 and all subsequent phases

---

## Overview

The Integration API is the stable internal contract that all v4 pillars build against. Defining it first prevents integration rework and guarantees that agents built in Sprints 1.1 through Phase 5 can communicate without breaking changes.

All types are implemented in `src/types/v4-api.ts` and exported from `src/types/index.ts`.

## Design Principles

1. **Single source of truth** — One file (`src/types/v4-api.ts`) for all v4 contract types.
2. **Generic envelope** — `MessageEnvelope<TPayload>` provides type-safe pub/sub without sacrificing flexibility.
3. **Agent-owned status files** — Agents write their own state; coordinators only read. Eliminates coordination bottlenecks and metadata.yaml race conditions.
4. **Backward compatibility** — All v3.2 types remain valid. Compatibility shims bridge `AutonomyLevel` → `AutonomyTier`.
5. **Stability guarantees** — Interfaces marked `@stable` follow semver. `@experimental` interfaces may change without notice.

---

## § 1 — Enumerations

| Type | Values | Used By |
|------|--------|---------|
| `AutonomyTier` | 1 (Supervised), 2 (Assisted), 3 (Autonomous), 4 (Strategic) | Flywheel, REFORGE, graduation |
| `AgentState` | idle, active, busy, suspended, offline | Status files, bus routing |
| `V4MessagePriority` | urgent, high, normal, low | All bus messages |
| `MessageCategory` | task, result, status, escalation, decision, direct, meeting, review, memory, reforge | Routing, display tier |
| `DisplayTierHint` | full, oneliner, marker, silent | Feed renderer |
| `ReviewStatus` | pending, assigned, in_review, responded, resolved, approved | Review lifecycle |
| `MemoryCategory` | learning, research, mistake, preference, relationship, context, capability, metric | Memory registry |
| `ToolPermission` | public, team, supervisor, opus | Tool registry |

---

## § 2 — Message Envelope

**Type:** `MessageEnvelope<TPayload>`

All TeamModeBus messages use this envelope. The `topic` field determines the payload type.

```
MessageEnvelope<TaskAssignPayload>          → topic: "agent.task.assign"
MessageEnvelope<TaskResultPayload>          → topic: "agent.task.result"
MessageEnvelope<ReviewLifecyclePayload>     → topic: "review.lifecycle.*"
MessageEnvelope<MeetingCoordinationPayload> → topic: "meeting.coordination.*"
```

Key fields: `id` (UUID), `version` ("4.0"), `from`/`to` (agent addresses), `topic`, `category`, `priority`, `payload`, `replyTo`, `conversationId`, `ttl`, `displayTierHint`.

---

## § 3 — Bus Topic Convention Reference

| Topic | Payload Type | Publisher | Consumers |
|-------|-------------|-----------|-----------|
| `agent.task.assign` | `TaskAssignPayload` | Any supervisor | Target agent |
| `agent.task.result` | `TaskResultPayload` | Any agent | Supervisor, COO, PM |
| `agent.status.update` | `AgentStatusPayload` | Any agent | meeting-coordinator, bus-perf-monitor |
| `review.lifecycle.assigned` | `ReviewLifecyclePayload` | review-router | Reviewer agent |
| `review.lifecycle.responded` | `ReviewLifecyclePayload` | Reviewer agent | review-router, author |
| `review.lifecycle.approved` | `ReviewLifecyclePayload` | CEO | All participants |
| `meeting.coordination.requested` | `MeetingCoordinationPayload` | Any agent | meeting-coordinator |
| `meeting.coordination.scheduled` | `MeetingCoordinationPayload` | meeting-coordinator | Participants |
| `meeting.coordination.completed` | `MeetingCoordinationPayload` | meeting-coordinator | COO, PM |
| `memory.query` | `MemoryQueryPayload` | Any agent | semantic-search-agent |
| `memory.result` | `MemoryResultPayload` | semantic-search-agent | Querying agent |
| `reforge.propose` | `ReforgeProposalPayload` | improvement-analyst | CTO, approvers |
| `reforge.approve` | `ReforgeApprovalPayload` | CTO / COO (by tier) | improvement-analyst |
| `reforge.apply` | `ReforgeApplicationPayload` | improvement-analyst | All agents, COO |
| `escalation.raised` | `EscalationPayload` | Any agent | Supervisor chain |
| `escalation.resolved` | `EscalationPayload` | Supervisor | Originator |

---

## § 4 — Status File Schema

**Path:** `/.forge/status/{agent-id}.json`
**Type:** `AgentStatusFile`

Each agent is the **sole writer** of its own status file. flock(2) advisory lock on write. Reads are lock-free.

Status files are considered **stale** if `heartbeatAt` is more than 2 minutes old → agent state becomes `"offline"`.

Key fields: `agentId`, `agentName`, `modelTier`, `autonomyTier`, `state`, `heartbeatAt`, `startedAt`, `activeTask?`, `capabilities[]`.

---

## § 5 — Registry Entry Formats

| Registry | Entry Type | Path |
|----------|-----------|------|
| Tools | `ToolRegistryEntry` | `/.forge/registry/tools/{id}.json` |
| Memory | `MemoryRegistryEntry` | `/.forge/registry/memory/{id}.json` |
| Capabilities | `AgentCapabilityEntry` | `/.forge/registry/capabilities/{agentId}/{skillId}.json` |
| Roles | `RoleRegistryEntry` | `/.forge/registry/roles/{roleId}.json` |

All registry entries share: `id`, `version`, `createdAt`, `updatedAt`, `ownerAgentId`, `active`.

---

## § 6 — Org-Graph Types

- **`OrgNode`** — agent's position in the DAG: supervisor, direct reports, peers, delegation targets.
- **`DelegationContext`** — wraps every task assignment with business rationale, constraints, acceptable trade-offs, and expected output format.

---

## § 7 — Flywheel Metric Types (Pillar 5, @experimental)

- **`SprintVelocityRecord`** — tracks `outputPerDollar` and `velocityRatio` sprint-over-sprint. Alert fires when ratio < 1.0.
- **`LearnedPattern`** — pattern extracted by meta-learning engine with evidence, confidence, and propagation tracking.

---

## § 8 — Versioning

Current API version: **4.0.0**

| Interface | Stability |
|-----------|-----------|
| `MessageEnvelope` | stable |
| `AgentStatusFile` | stable |
| `*RegistryEntry` | stable |
| `OrgNode`, `DelegationContext` | stable |
| `*Payload` types | stable |
| `SprintVelocityRecord`, `LearnedPattern` | experimental |
| `ApiVersionManifest` | stable |

Served at `/.forge/api-version.json` at runtime.

---

## § 9 — v3.2 Compatibility

| v3.2 Type | v4 Equivalent | Migration |
|-----------|---------------|-----------|
| `AutonomyLevel` ("full"\|"supervised"\|"guided") | `AutonomyTier` (1-4) | `autonomyLevelToTier()` / `tierToAutonomyLevel()` |
| `MessagePriority` | `V4MessagePriority` | Same values — rename only |
| `TeamModeMessage` | `MessageEnvelope<*Payload>` | Wrapped format — backward compatible via `metadata` |
| `HibernatedSession` | `AgentStatusFile` (state: "suspended") | Status file replaces hibernation snapshot |

---

## Phase 1 Gate Criteria (Week 4)

- [x] This specification complete — `src/types/v4-api.ts` compiles clean
- [ ] Org-graph supports ≥30 agent nodes with sub-100ms query (Sprint 1.1)
- [ ] All Pillar 1 unit and integration tests pass (Sprint 1.3)
- [ ] Budget spend ≤ $68

*Sprint 1.0 complete. Integration API contract signed off. Sprints 1.1a (org-graph-builder) and 1.1b (role-registry-agent) unblocked.*
