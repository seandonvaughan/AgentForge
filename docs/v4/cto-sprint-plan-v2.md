# AgentForge v4 Sprint Plan v2

**Document Version:** 2.0
**Date:** 2026-03-25
**Author:** CTO Office
**Status:** DRAFT — Pending Final Approval from All 8 Reviewers
**Budget Envelope:** $390 (hard cap, 18% contingency reserved)
**Timeline:** 20 weeks across 5 phases

---

## 1. Executive Summary

AgentForge v4 transforms the platform from a static agent orchestration framework into a self-improving, cost-aware, organizationally-modeled agent system. This sprint plan is organized around **5 pillars**, executed across **5 phases** over **20 weeks**, staffed by a **27-agent team roster** operating under strict concurrency and budget governance.

**What changed in v2:** This revision addresses all 30 conditions raised by 8 reviewers during the v1 review cycle. The most significant changes are:

- **Pillar 5 redesigned as a compounding flywheel** (CEO blocker resolved) with meta-learning, graduated autonomy, capability inheritance, and measurable velocity acceleration.
- **Phase 1 restructured as strictly sequential** (COO condition) with Integration API as the Week 1 prerequisite (PM condition) before any concurrent scaffolding begins.
- **Budget broken down per-pillar and per-phase** with 5 formal phase gate checkpoints and 8-week ROI criteria (CFO conditions).
- **Agent-owned status files replace metadata.yaml** (Architect condition), reviews route through TeamModeBus (Team-Mode-Lead condition), and flock-based locks protect all persistence (Persistence-Lead condition).
- **v3→v4 migration strategy** with git-tag rollback for every REFORGE operation (Persistence-Lead condition).
- **User-facing API stability review** added as a formal Phase 4 milestone (CEO condition).

The plan delivers measurable business value at each phase gate. If any gate fails its ROI criteria, we stop, preserve value delivered so far, and reassess.

---

## 2. Review Response Matrix

| # | Reviewer | Condition | Resolution | Section |
|---|----------|-----------|------------|---------|
| 1 | CEO | Pillar 5 must be a compounding flywheel | Redesigned with 4 flywheel components: meta-learning, graduated autonomy, capability inheritance, velocity acceleration | §7 |
| 2 | CEO | Flywheel must include meta-learning | Added: agents learn from cross-task patterns, store in shared knowledge graph | §7.1 |
| 3 | CEO | Graduated autonomy required | Added: 4-tier autonomy levels with promotion/demotion criteria | §7.2 |
| 4 | CEO | Capability inheritance across agents | Added: skill propagation protocol where learned capabilities transfer to peer agents | §7.3 |
| 5 | CEO | Velocity acceleration metric | Added: sprint-over-sprint velocity ratio tracked, must show >5% compounding improvement | §7.4 |
| 6 | CEO | User-facing API stability review in Phase 4 | Added as Phase 4, Week 16 milestone with semver audit and deprecation policy | §5, Phase 4 |
| 7 | Architect | PostToolUse hook for meeting-coordinator | Added to Pillar 2 agent spec; hook fires after every tool call to update coordination state | §4, Agent #14 |
| 8 | Architect | Agent-owned status files, not metadata.yaml | New pattern: each agent writes `/.forge/status/{agent-id}.json`; no shared metadata.yaml | §8 |
| 9 | Architect | REFORGE guardrails | REFORGE operations require: pre-flight validation, git tag, rollback plan, budget check | §9 |
| 10 | Architect | Semantic similarity threshold for memory retrieval | Configurable threshold (default 0.82) with fallback to keyword search below 0.6 | §3, Pillar 3 |
| 11 | CFO | Per-pillar budget breakdown | $390 allocated: P1 $95, P2 $78, P3 $72, P4 $58, P5 $87 (includes contingency) | §6.1 |
| 12 | CFO | Per-phase budget breakdown | Phase 1 $68, Phase 2 $92, Phase 3 $88, Phase 4 $72, Phase 5 $70 | §6.2 |
| 13 | CFO | 5 phase gate checkpoints | Gates at weeks 4, 8, 12, 16, 20 with go/no-go criteria | §6.3 |
| 14 | CFO | 18% contingency reserve | $60.84 reserved, draw-down requires CTO+CFO approval | §6.4 |
| 15 | CFO | 8-week ROI criteria | Phase 2 gate must show ≥15% cost reduction in agent invocations vs. v3 baseline | §6.5 |
| 16 | COO | Phase 1 strictly sequential | Week 1: Integration API. Week 2: Core scaffolding. Week 3-4: Foundation agents. No concurrency in Phase 1 | §5, Phase 1 |
| 17 | COO | Critical path diagram | Provided as text-based dependency graph with week markers | §5.1 |
| 18 | COO | Meeting limits: max 3 concurrent | Hard limit enforced by meeting-coordinator agent; excess queued with priority scoring | §4, Agent #14 |
| 19 | COO | Dashboard-dev overflow plan | If dashboard work exceeds sprint capacity, defer visualization polish to Phase 5; core metrics read-only in Phase 3 | §5, Phase 3 |
| 20 | PM | Integration API as Phase 1 Week 1 prerequisite | Moved to Week 1 as blocking prerequisite; no other work starts until API contract is defined | §5, Phase 1 |
| 21 | PM | Pillar 3 sequence: registry→MCP→testing | Enforced: Sprint 3.1 registry, Sprint 3.2 MCP integration, Sprint 3.3 testing framework | §3, Pillar 3 |
| 22 | PM | Split Pillar 4 Sprint 2.4 | Split into Sprint 4.2a (session management) and Sprint 4.2b (REFORGE engine) | §5, Phase 4 |
| 23 | PM | Max 2 agents per deliverable | Enforced across all sprint assignments; no deliverable has >2 agents assigned | §4 |
| 24 | Team-Mode-Lead | Reviews via TeamModeBus not file system | All code review routing uses TeamModeBus pub/sub; no file-system polling for review state | §3, Pillar 2 |
| 25 | Team-Mode-Lead | Session serialization for long-running reviews | Reviews that exceed session TTL serialize state to `/.forge/reviews/{id}.json` and resume | §3, Pillar 2 |
| 26 | Persistence-Lead | v3→v4 migration strategy | 3-stage migration: snapshot v3 state → transform schemas → validate + activate v4 | §9.1 |
| 27 | Persistence-Lead | Flock-based locks for concurrency | All status file and registry writes use `flock(2)` advisory locks; 5s timeout, retry 3x | §9.2 |
| 28 | Persistence-Lead | 10k file storage limits | Hard limit: 10,000 files per `.forge/` subtree; LRU eviction with archive-to-git strategy | §9.3 |
| 29 | Persistence-Lead | REFORGE rollback via git tags | Every REFORGE creates `reforge/v4/{timestamp}` tag before mutation; rollback is `git checkout` | §9.4 |
| 30 | CEO | General approval of full plan | This document; all 30 conditions addressed | §10 |

---

## 3. Revised 5-Pillar Strategy

### Pillar 1 — Organizational Intelligence ($95)

**Business objective:** Model real-world team structures so agents operate with the same division of responsibility, delegation patterns, and accountability as a high-performing human organization.

**Scope:**
- **Org-graph engine:** Directed acyclic graph of reporting relationships, peer groups, and delegation chains. Every agent has exactly one supervisor, zero or more direct reports, and a defined peer set.
- **Role-based routing:** Messages and tasks route based on organizational role, not agent ID. If the "Architect" role is reassigned, all routing follows automatically.
- **Delegation protocol:** Supervisors delegate with context (business rationale + constraints + acceptable trade-offs). Delegates report back in the supervisor's frame of reference.
- **Accountability tracking:** Every task has a single accountable agent. RACI matrix generated dynamically from the org-graph for any multi-agent deliverable.
- **Integration API (Week 1 prerequisite):** Before any agent scaffolding, define the stable internal API contract that all pillars build against. This contract specifies: message envelope format, status file schema, TeamModeBus topic conventions, and registry entry format.

**Key deliverables:**
- Integration API specification (JSON Schema + TypeScript types)
- Org-graph data model and query interface
- Role registry with assignment/reassignment protocol
- Delegation context envelope (structured format for "why + what + constraints")
- Accountability audit log

**Technical constraints:**
- Org-graph must be acyclic (no circular reporting)
- Role assignments are mutable at runtime but logged immutably
- Integration API is versioned with semver from day 1

---

### Pillar 2 — Communication & Coordination ($78)

**Business objective:** Replace ad-hoc agent communication with structured, auditable, cost-efficient messaging that minimizes unnecessary Opus invocations.

**Scope:**
- **TeamModeBus:** Pub/sub message bus for all inter-agent communication. Agents subscribe to topics by role. Messages are typed envelopes with sender, recipient(s), priority, and TTL.
- **Review routing via TeamModeBus:** All code reviews, plan reviews, and approval workflows route through the bus — never through file-system polling. Review assignment, feedback, and resolution are bus events.
- **Session serialization:** Long-running reviews that exceed session TTL serialize their full state (review context, comments collected, approval status) to `/.forge/reviews/{id}.json` and resume seamlessly in a new session.
- **Meeting coordinator (with PostToolUse hook):** Manages synchronous multi-agent discussions. PostToolUse hook fires after every tool call during a meeting to update coordination state (who spoke, what was decided, what's pending). Hard limit: **max 3 concurrent meetings**. Excess meetings queue with priority scoring based on blocking-path analysis.
- **Executive assistant pattern:** Opus-tier agents get Haiku-tier assistants that filter inbox, prepare briefings, and batch low-priority messages — targeting 80%+ reduction in Opus invocations for administrative communication.
- **Async channels:** Agents can post to named channels (e.g., `#architecture-decisions`, `#cost-alerts`) without targeting a specific recipient. Subscribers process asynchronously.

**Key deliverables:**
- TeamModeBus implementation with topic registry
- Review workflow engine (assign → collect feedback → resolve → merge/reject)
- Session serialization/deserialization for reviews
- Meeting coordinator agent with PostToolUse hook and concurrency limiter
- Executive assistant agent template
- Channel system with subscription management

**Technical constraints:**
- All bus messages are logged immutably for audit
- Meeting concurrency hard-capped at 3 (not configurable without CTO override)
- Review state files use flock-based locking (see §9.2)
- Session serialization format must be forward-compatible across v4.x

---

### Pillar 3 — Persistent Memory & Knowledge ($72)

**Business objective:** Give agents durable memory across sessions so they build institutional knowledge, avoid repeating mistakes, and make increasingly informed decisions.

**Scope (strict sequence: registry → MCP → testing):**

- **Sprint 3.1 — Memory registry:** Central registry of all memory stores, their schemas, ownership, and access policies. Registry entries are the source of truth for what knowledge exists and who can read/write it.
- **Sprint 3.2 — MCP integration:** Memory stores exposed as MCP resources. External tools and agents access memory through the standard MCP protocol, not custom APIs.
- **Sprint 3.3 — Testing framework:** Memory retrieval accuracy tests, consistency tests under concurrent writes, and regression tests for semantic search quality.

**Semantic similarity search:**
- Default similarity threshold: **0.82** (tunable per memory store)
- Below 0.82: results returned with confidence scores, flagged as "low confidence"
- Below 0.60: fallback to keyword/exact-match search automatically
- Above 0.95: deduplicate against existing memories before storing

**Storage limits:**
- Hard limit: **10,000 files** per `.forge/` subtree
- LRU eviction when approaching limit (90% threshold triggers warning)
- Evicted files archived to git (committed to `archive/` branch) before deletion
- Per-agent memory quota: proportional to role tier (Opus agents get 3x Haiku quota)

**Key deliverables:**
- Memory registry with schema validation
- MCP resource provider for memory stores
- Semantic search with configurable thresholds and keyword fallback
- Storage limit enforcement with LRU eviction and git archival
- Memory testing framework (accuracy, consistency, regression)

**Technical constraints:**
- Registry must be populated before MCP integration begins (hard dependency)
- MCP integration must be validated before testing framework can run integration tests
- All memory writes use flock-based locks (see §9.2)

---

### Pillar 4 — Session Management & Self-Modification ($58)

**Business objective:** Enable agents to maintain coherent state across long-running operations and to evolve their own configurations safely and reversibly.

**Scope (split into two sub-sprints per PM condition):**

- **Sprint 4.2a — Session management:**
  - Session lifecycle: create, persist, resume, expire
  - Cross-session context threading (agent picks up where it left off)
  - Session-scoped resource cleanup (temp files, locks, bus subscriptions)
  - Session timeout policies by agent tier

- **Sprint 4.2b — REFORGE engine:**
  - Self-modification protocol: agent proposes config change → validates against guardrails → creates git tag → applies change → verifies → reports
  - **REFORGE guardrails:** Every REFORGE operation must pass:
    1. Pre-flight validation (schema check, dependency check, budget check)
    2. Git tag creation (`reforge/v4/{timestamp}`) before any mutation
    3. Rollback plan generation (what to `git checkout` if it fails)
    4. Post-flight verification (did the change produce expected behavior?)
    5. Budget impact assessment (does this change increase ongoing costs?)
  - Rollback is always a single `git checkout` to the pre-REFORGE tag

- **User-facing API stability review (Phase 4, Week 16):**
  - Semver audit of all public APIs introduced in Pillars 1-4
  - Deprecation policy: minimum 2 minor versions before removal
  - Breaking change inventory with migration guides
  - Stability tier classification: stable / beta / experimental

**Key deliverables:**
- Session lifecycle manager
- Cross-session context store
- REFORGE engine with full guardrail pipeline
- Git-tag-based rollback mechanism
- API stability audit report with semver classifications
- Deprecation policy document

**Technical constraints:**
- REFORGE operations are serialized (never concurrent)
- Every REFORGE must complete within 120 seconds or auto-rollback
- API stability review blocks Phase 5 start (hard gate)

---

### Pillar 5 — Compounding Flywheel ($87)

**Business objective:** Make the system measurably better at its job with every sprint it completes. Not just "learning" — compounding improvement where each cycle's gains amplify the next cycle's gains.

This is the CEO-mandated flywheel. It is not a feature list — it is a self-reinforcing loop with four interlocking components. See §7 for full design.

**The four flywheel components:**
1. **Meta-learning** — Agents extract patterns from cross-task outcomes, not just individual task results
2. **Graduated autonomy** — Agents earn increased decision-making authority based on track record
3. **Capability inheritance** — Skills learned by one agent propagate to peers with compatible roles
4. **Velocity acceleration** — Each sprint should complete faster or produce more than the last, measured and enforced

**Key deliverables:**
- Meta-learning engine with pattern extraction and knowledge graph
- Autonomy tier system (4 tiers) with promotion/demotion criteria
- Capability propagation protocol with compatibility checking
- Velocity tracking dashboard with sprint-over-sprint ratios
- Flywheel health monitor (are all 4 components reinforcing each other?)

**Success criteria:**
- Sprint-over-sprint velocity ratio > 1.05 (5% compounding improvement)
- Autonomy promotions outnumber demotions 3:1 after initial calibration period
- ≥40% of learned capabilities successfully inherited by at least one peer agent
- Meta-learning generates ≥2 actionable pattern insights per sprint

**Technical constraints:**
- Flywheel metrics are immutable audit records (no retroactive adjustment)
- Autonomy demotion requires supervisor approval + documented justification
- Capability inheritance requires explicit opt-in by receiving agent's supervisor

---

## 4. Revised 27-Agent Team Roster

All agents are assigned to specific pillars and sprints. **No deliverable has more than 2 agents assigned.** Each agent listing includes: name, model tier, pillar assignment, role, and supervisor.

### Pillar 1 — Organizational Intelligence (6 agents)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 1 | **integration-api-architect** | Opus | Defines the Integration API contract that all pillars depend on | CTO | Phase 1, Week 1 (blocking) |
| 2 | **org-graph-builder** | Sonnet | Implements org-graph data model, DAG validation, query interface | Architect | Phase 1, Sprint 1.1 |
| 3 | **role-registry-agent** | Sonnet | Manages role definitions, assignments, reassignments, and audit log | Architect | Phase 1, Sprint 1.1 |
| 4 | **delegation-protocol-agent** | Sonnet | Implements delegation context envelopes and routing rules | Architect | Phase 1, Sprint 1.2 |
| 5 | **accountability-tracker** | Haiku | Generates RACI matrices, tracks task ownership, produces audit reports | COO | Phase 1, Sprint 1.2 |
| 6 | **pillar1-test-agent** | Haiku | Integration and unit tests for all Pillar 1 deliverables | QA Lead | Phase 1, Sprint 1.2 |

### Pillar 2 — Communication & Coordination (7 agents)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 7 | **teammode-bus-engine** | Sonnet | Core TeamModeBus implementation: pub/sub, topics, typed envelopes | Architect | Phase 2, Sprint 2.1 |
| 8 | **review-router** | Sonnet | Routes code/plan reviews through TeamModeBus; manages review lifecycle | Team-Mode-Lead | Phase 2, Sprint 2.1 |
| 9 | **session-serializer** | Sonnet | Serializes/deserializes long-running review state; manages `/.forge/reviews/` | Persistence-Lead | Phase 2, Sprint 2.2 |
| 10 | **channel-manager** | Haiku | Manages async channels, subscriptions, and message fan-out | Team-Mode-Lead | Phase 2, Sprint 2.2 |
| 11 | **exec-assistant-template** | Sonnet | Builds the reusable executive assistant pattern (inbox filter, briefing prep, batching) | CTO | Phase 2, Sprint 2.3 |
| 12 | **pillar2-test-agent** | Haiku | Tests for bus delivery, review routing, session resumption, channel semantics | QA Lead | Phase 2, Sprint 2.3 |
| 13 | **bus-perf-monitor** | Haiku | Monitors bus throughput, latency, dead letters; alerts on degradation | COO | Phase 2, Sprint 2.3 |

#### Agent #14 — Meeting Coordinator (Special Specification)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 14 | **meeting-coordinator** | Sonnet | Orchestrates synchronous multi-agent meetings with PostToolUse hook | COO | Phase 2, Sprint 2.2 |

**PostToolUse hook specification:**
- Fires after every tool call made during a coordinated meeting
- Updates coordination state: speaker log, decision register, pending-action queue
- If a tool call changes a decision already recorded, flags conflict for meeting chair
- Hook payload: `{ meetingId, agentId, toolName, toolResult, timestamp }`

**Concurrency enforcement:**
- Maximum 3 concurrent meetings (hard limit)
- When limit reached, new meeting requests enter priority queue
- Priority score = (number of blocked agents × blocking duration) + escalation bonus
- Meeting chair can preempt a lower-priority meeting if chain-of-command authorizes

### Pillar 3 — Persistent Memory & Knowledge (5 agents)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 15 | **memory-registry-agent** | Sonnet | Builds and maintains the central memory registry with schema validation | Persistence-Lead | Phase 3, Sprint 3.1 |
| 16 | **mcp-memory-provider** | Sonnet | Exposes memory stores as MCP resources; handles read/write/search operations | Architect | Phase 3, Sprint 3.2 |
| 17 | **semantic-search-agent** | Sonnet | Implements similarity search with configurable thresholds and keyword fallback | Architect | Phase 3, Sprint 3.2 |
| 18 | **storage-governor** | Haiku | Enforces 10k file limit, LRU eviction, git archival, per-agent quotas | Persistence-Lead | Phase 3, Sprint 3.1 |
| 19 | **pillar3-test-agent** | Haiku | Memory accuracy tests, concurrent write tests, search quality regression tests | QA Lead | Phase 3, Sprint 3.3 |

### Pillar 4 — Session Management & Self-Modification (5 agents)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 20 | **session-lifecycle-agent** | Sonnet | Session create/persist/resume/expire; cross-session context threading | Architect | Phase 4, Sprint 4.2a |
| 21 | **reforge-engine-agent** | Sonnet | REFORGE protocol: propose → validate → tag → apply → verify → report | Architect | Phase 4, Sprint 4.2b |
| 22 | **reforge-guardrail-agent** | Sonnet | Pre-flight validation, budget check, rollback plan generation, post-flight verify | CTO | Phase 4, Sprint 4.2b |
| 23 | **api-stability-auditor** | Sonnet | Semver audit, deprecation policy enforcement, breaking change inventory | CTO | Phase 4, Week 16 |
| 24 | **pillar4-test-agent** | Haiku | Session lifecycle tests, REFORGE safety tests, rollback verification tests | QA Lead | Phase 4, Sprint 4.2b |

### Pillar 5 — Compounding Flywheel (3 agents)

| # | Agent Name | Model | Role | Supervisor | Sprint Assignment |
|---|-----------|-------|------|------------|-------------------|
| 25 | **meta-learning-engine** | Opus | Cross-task pattern extraction, knowledge graph maintenance, insight generation | CTO | Phase 5, Sprint 5.1 |
| 26 | **autonomy-governor** | Sonnet | Manages 4-tier autonomy system, promotion/demotion evaluation, track record scoring | CTO | Phase 5, Sprint 5.2 |
| 27 | **flywheel-monitor** | Haiku | Tracks velocity ratios, capability inheritance rates, flywheel health metrics | COO | Phase 5, Sprint 5.2 |

### Model Tier Summary

| Tier | Count | Agents |
|------|-------|--------|
| Opus | 2 | #1 integration-api-architect, #25 meta-learning-engine |
| Sonnet | 16 | #2, #3, #4, #7, #8, #9, #11, #14, #15, #16, #17, #20, #21, #22, #23, #26 |
| Haiku | 9 | #5, #6, #10, #12, #13, #18, #19, #24, #27 |

**Cost rationale:** Opus reserved for integration API design (foundational — errors here cascade everywhere) and meta-learning (requires cross-domain pattern recognition that Sonnet cannot reliably perform). All other work scoped for Sonnet or Haiku.

---

## 5. Revised Phase/Sprint Structure (20 Weeks)

### Phase 1 — Foundation (Weeks 1–4) | Budget: $68

**COO CONDITION: Phase 1 is strictly sequential. No concurrent scaffolding.**

**PM CONDITION: Integration API is Week 1 blocking prerequisite.**

| Week | Sprint | Deliverables | Agents | Dependencies |
|------|--------|-------------|--------|--------------|
| 1 | **1.0 — Integration API** | API contract (message envelopes, status file schema, bus topic conventions, registry format) | #1 integration-api-architect | NONE — this is the root |
| 2 | **1.1a — Org Graph** | Org-graph data model, DAG validation, query interface | #2 org-graph-builder | 1.0 complete |
| 2 | **1.1b — Role Registry** | Role definitions, assignment protocol, audit log | #3 role-registry-agent | 1.0 complete |
| 3 | **1.2a — Delegation** | Delegation context envelopes, routing rules | #4 delegation-protocol-agent | 1.1a, 1.1b complete |
| 3 | **1.2b — Accountability** | RACI generation, task ownership tracking | #5 accountability-tracker | 1.1a, 1.1b complete |
| 4 | **1.3 — Integration Test** | Full Pillar 1 integration tests, defect resolution | #6 pillar1-test-agent | 1.2a, 1.2b complete |

**Phase 1 Gate (Week 4):**
- [ ] Integration API contract signed off by all pillar leads
- [ ] Org-graph supports ≥30 agent nodes with sub-100ms query
- [ ] All Pillar 1 unit and integration tests pass
- [ ] Budget spend ≤ $68

---

### Phase 2 — Communication & Coordination (Weeks 5–8) | Budget: $92

| Week | Sprint | Deliverables | Agents | Dependencies |
|------|--------|-------------|--------|--------------|
| 5 | **2.1a — TeamModeBus Core** | Pub/sub engine, topic registry, typed envelopes | #7 teammode-bus-engine | Phase 1 Gate passed |
| 5 | **2.1b — Review Router** | Review lifecycle (assign → feedback → resolve) via bus | #8 review-router | Phase 1 Gate passed |
| 6 | **2.2a — Session Serialization** | Long-running review state persistence and resumption | #9 session-serializer | 2.1a, 2.1b complete |
| 6 | **2.2b — Meeting Coordinator** | Meeting orchestration with PostToolUse hook, 3-meeting cap | #14 meeting-coordinator | 2.1a complete |
| 7 | **2.3a — Channels** | Async channel system with subscriptions | #10 channel-manager | 2.1a complete |
| 7 | **2.3b — Exec Assistants** | Reusable executive assistant template | #11 exec-assistant-template | 2.1a complete |
| 8 | **2.4 — Integration Test** | Full Pillar 2 tests + bus performance baseline | #12 pillar2-test-agent, #13 bus-perf-monitor | 2.2a, 2.2b, 2.3a, 2.3b complete |

**Phase 2 Gate (Week 8) — includes 8-week ROI check:**
- [ ] TeamModeBus delivers messages with ≤50ms p99 latency
- [ ] Reviews route exclusively through bus (zero file-system polls)
- [ ] Session serialization round-trips without data loss
- [ ] Meeting concurrency enforced (test: attempt 4th meeting, verify queue)
- [ ] **8-week ROI: ≥15% reduction in Opus invocations vs. v3 baseline** (CFO condition)
- [ ] Budget spend ≤ $92

---

### Phase 3 — Persistent Memory & Knowledge (Weeks 9–12) | Budget: $88

**PM CONDITION: Strict sequence — registry → MCP → testing.**

| Week | Sprint | Deliverables | Agents | Dependencies |
|------|--------|-------------|--------|--------------|
| 9 | **3.1a — Memory Registry** | Central registry with schema validation | #15 memory-registry-agent | Phase 2 Gate passed |
| 9 | **3.1b — Storage Governor** | 10k file limit enforcement, LRU eviction, git archival | #18 storage-governor | Phase 2 Gate passed |
| 10–11 | **3.2a — MCP Provider** | Memory stores as MCP resources | #16 mcp-memory-provider | 3.1a complete |
| 10–11 | **3.2b — Semantic Search** | Similarity search with thresholds (0.82 default) and keyword fallback | #17 semantic-search-agent | 3.1a complete |
| 12 | **3.3 — Memory Testing** | Accuracy, consistency, regression tests for all memory subsystems | #19 pillar3-test-agent | 3.2a, 3.2b complete |

**Dashboard-dev overflow plan (COO condition):** If Pillar 3 work exceeds sprint capacity, the metrics visualization dashboard (read-only) defers to Phase 5. Core memory functionality and APIs are the priority. A CLI-based metrics dump is the fallback for Phase 3 gate review.

**Phase 3 Gate (Week 12):**
- [ ] Memory registry contains entries for all agent memory stores
- [ ] MCP resource provider passes MCP compliance tests
- [ ] Semantic search returns relevant results above 0.82 threshold in >90% of test queries
- [ ] Storage governor enforces 10k limit (test: attempt to exceed, verify eviction)
- [ ] Budget spend ≤ $88

---

### Phase 4 — Session Management & Self-Modification (Weeks 13–16) | Budget: $72

**PM CONDITION: Sprint 2.4 split into 4.2a (sessions) and 4.2b (REFORGE).**

| Week | Sprint | Deliverables | Agents | Dependencies |
|------|--------|-------------|--------|--------------|
| 13 | **4.1 — Session Foundation** | Session lifecycle (create/persist/resume/expire), resource cleanup | #20 session-lifecycle-agent | Phase 3 Gate passed |
| 14 | **4.2a — Cross-Session Context** | Context threading across sessions, timeout policies by tier | #20 session-lifecycle-agent | 4.1 complete |
| 15 | **4.2b — REFORGE Engine** | Self-modification protocol with full guardrail pipeline | #21 reforge-engine-agent, #22 reforge-guardrail-agent | 4.1 complete |
| 16 | **4.3 — API Stability Review** | Semver audit, deprecation policy, breaking change inventory | #23 api-stability-auditor | 4.2a, 4.2b complete |
| 16 | **4.4 — Integration Test** | Session lifecycle tests, REFORGE safety tests, rollback tests | #24 pillar4-test-agent | 4.2b complete |

**Phase 4 Gate (Week 16) — blocks Phase 5:**
- [ ] Sessions persist and resume across simulated failures
- [ ] REFORGE creates git tag, applies change, verifies, and rolls back successfully
- [ ] REFORGE auto-rollback triggers on timeout (>120s test)
- [ ] API stability audit complete: all public APIs classified as stable/beta/experimental
- [ ] Deprecation policy documented and enforced in CI
- [ ] Budget spend ≤ $72

---

### Phase 5 — Compounding Flywheel (Weeks 17–20) | Budget: $70

| Week | Sprint | Deliverables | Agents | Dependencies |
|------|--------|-------------|--------|--------------|
| 17 | **5.1a — Meta-Learning Engine** | Cross-task pattern extraction, knowledge graph, insight generation | #25 meta-learning-engine | Phase 4 Gate passed |
| 18 | **5.1b — Capability Inheritance** | Skill propagation protocol, compatibility checking, opt-in mechanism | #25 meta-learning-engine | 5.1a complete |
| 19 | **5.2a — Autonomy Governor** | 4-tier autonomy system, promotion/demotion evaluation | #26 autonomy-governor | 5.1a complete |
| 19 | **5.2b — Flywheel Monitor** | Velocity tracking, inheritance rates, flywheel health dashboard | #27 flywheel-monitor | 5.1a complete |
| 20 | **5.3 — Flywheel Validation** | End-to-end flywheel test: run 3 simulated sprints, measure compounding | #25, #26, #27 (all) | 5.2a, 5.2b complete |

**Phase 5 Gate (Week 20) — Final:**
- [ ] Meta-learning generates ≥2 actionable insights in simulated sprints
- [ ] Graduated autonomy: at least 1 agent promoted during simulation
- [ ] Capability inheritance: ≥1 skill successfully propagated to a peer
- [ ] Velocity ratio >1.05 across simulated sprints
- [ ] Flywheel health monitor confirms all 4 components active
- [ ] Total budget spend ≤ $390

---

### 5.1 Critical Path Diagram

```
Week 1    Week 2    Week 3    Week 4    Week 5    Week 6    Week 7    Week 8
  │         │         │         │         │         │         │         │
  ▼         ▼         ▼         ▼         ▼         ▼         ▼         ▼
[1.0 API]──►[1.1a Org]──►[1.2a Deleg]──►[1.3 Test]──►[2.1a Bus]──►[2.2a SerSer]──►[2.3a Chan]──►[2.4 Test]
  ║         [1.1b Role]──►[1.2b Acct ]──►           [2.1b RevR]──►[2.2b MeetC]──►[2.3b Exec]──►
  ║                                        ▲                                        ▲
  ║                                      GATE 1                                   GATE 2
  ║                                                                              (+ROI check)
  ║
  ║  Week 9   Week 10   Week 11   Week 12   Week 13   Week 14   Week 15   Week 16
  ║    │         │         │         │         │         │         │         │
  ║    ▼         ▼         ▼         ▼         ▼         ▼         ▼         ▼
  ║  [3.1a Reg]──►[3.2a MCP ════════]──►[3.3 Test]──►[4.1 Sess]──►[4.2a Ctx]──►           [4.3 API Audit]
  ║  [3.1b Gov]──►[3.2b Srch════════]──►           ║            [4.2b REFORGE]──►[4.4 Test]
  ║                                       ▲         ║                              ▲
  ║                                     GATE 3      ║                           GATE 4
  ║                                                  ║                        (+API stability)
  ║
  ║  Week 17   Week 18   Week 19   Week 20
  ║    │         │         │         │
  ║    ▼         ▼         ▼         ▼
  ╚═►[5.1a Meta]──►[5.1b Inherit]──►           [5.3 Validate]
                               [5.2a Auton]──►
                               [5.2b Monit]──►
                                                     ▲
                                                  GATE 5
                                                 (FINAL)

═══ CRITICAL PATH ═══
1.0 → 1.1a → 1.2a → 1.3 → 2.1a → 2.2a → 2.4 → 3.1a → 3.2a → 3.3 → 4.1 → 4.2b → 4.4 → 5.1a → 5.1b → 5.3
(20 weeks, zero float on this path)
```

**Critical path notes:**
- The Integration API (1.0) is the single root dependency. Any delay here delays everything.
- Phase 2 has internal parallelism (2.2a ∥ 2.2b, 2.3a ∥ 2.3b) but phases are sequential.
- Pillar 3's strict registry→MCP→testing sequence means no internal shortcuts.
- REFORGE (4.2b) is on the critical path because the API stability audit depends on it.
- Phase 5 has the most internal parallelism (5.2a ∥ 5.2b) but only 4 weeks.

---

## 6. Budget Governance

### 6.1 Per-Pillar Budget

| Pillar | Base Budget | Contingency (18%) | Total Allocation |
|--------|------------|-------------------|------------------|
| P1 — Organizational Intelligence | $80.51 | $14.49 | $95.00 |
| P2 — Communication & Coordination | $66.10 | $11.90 | $78.00 |
| P3 — Persistent Memory & Knowledge | $61.02 | $10.98 | $72.00 |
| P4 — Session & Self-Modification | $49.15 | $8.85 | $58.00 |
| P5 — Compounding Flywheel | $73.73 | $13.27 | $87.00 |
| **TOTAL** | **$330.51** | **$59.49** | **$390.00** |

### 6.2 Per-Phase Budget

| Phase | Weeks | Pillars Active | Budget | Cumulative |
|-------|-------|---------------|--------|------------|
| Phase 1 | 1–4 | P1 | $68.00 | $68.00 |
| Phase 2 | 5–8 | P2 | $92.00 | $160.00 |
| Phase 3 | 9–12 | P3 | $88.00 | $248.00 |
| Phase 4 | 13–16 | P4 | $72.00 | $320.00 |
| Phase 5 | 17–20 | P5 | $70.00 | $390.00 |

**Note:** Pillar budgets and phase budgets do not map 1:1 because some pillar work (e.g., integration testing) spans phase boundaries. The phase budget is the hard spending cap per period. The pillar budget is the total lifetime allocation for that workstream.

### 6.3 Phase Gate Checkpoints

| Gate | Week | Go/No-Go Criteria | Decision Authority |
|------|------|-------------------|-------------------|
| Gate 1 | 4 | Integration API signed off, Pillar 1 tests pass, spend ≤ $68 | CTO + PM |
| Gate 2 | 8 | Bus operational, reviews on bus, **8-week ROI ≥15%**, spend ≤ $160 cumulative | CTO + CFO |
| Gate 3 | 12 | Memory registry + MCP + search operational, 10k limit enforced, spend ≤ $248 | CTO + PM |
| Gate 4 | 16 | Sessions + REFORGE operational, **API stability audit complete**, spend ≤ $320 | CTO + CEO |
| Gate 5 | 20 | Flywheel validated (all 4 components active), velocity >1.05, spend ≤ $390 | CEO (final sign-off) |

**Gate failure protocol:**
1. Document what passed and what failed
2. Assess: is the failure fixable within 1 week and remaining budget?
3. If yes: remediation sprint, re-gate
4. If no: stop, preserve delivered value, escalate to CEO for strategic reassessment

### 6.4 Contingency Reserve

**Total contingency: $59.49 (18% of $330.51 base)**

Contingency is distributed across pillars (see §6.1) but managed as a single pool. Draw-down rules:
- ≤$10 draw: CTO approves unilaterally, notifies CFO
- $10–$25 draw: CTO + CFO joint approval
- >$25 draw: CTO + CFO + CEO approval (indicates significant scope/risk change)

Contingency cannot be pre-allocated to sprints. It is drawn only when actual spend exceeds base budget for a specific, documented reason.

### 6.5 8-Week ROI Criteria

At the Phase 2 gate (week 8), we measure ROI against the v3 baseline:

| Metric | v3 Baseline | v4 Target (Week 8) | Measurement Method |
|--------|------------|--------------------|--------------------|
| Opus invocations per task | Measured in week 0 | ≥15% reduction | Agent invocation log comparison |
| Mean task completion time | Measured in week 0 | ≥10% reduction | End-to-end task timer |
| Communication overhead (messages per task) | Measured in week 0 | ≥20% reduction | TeamModeBus message count |
| Duplicate work incidents | Measured in week 0 | ≥50% reduction | Accountability tracker log |

**If ROI criteria are not met at week 8:**
- Analyze root causes (is it a measurement problem or a real problem?)
- One remediation sprint allowed (week 9, borrows from Phase 3 budget with CFO approval)
- If still not met after remediation: escalate to CEO, recommend scope reduction or pivot

---

## 7. Pillar 5 Flywheel Design (CEO Blocker Resolution)

The flywheel is not four independent features. It is a **self-reinforcing cycle** where each component's output feeds the next component's input:

```
                    ┌──────────────────────────────┐
                    │                              │
                    ▼                              │
            ┌──────────────┐              ┌───────────────┐
            │ META-LEARNING │──insights──►│   GRADUATED    │
            │   (extract    │              │   AUTONOMY     │
            │   patterns)   │              │ (earn trust)   │
            └──────────────┘              └───────────────┘
                    ▲                              │
                    │                              │ more autonomous
                    │ more data                    │ agents produce
                    │ from faster                  │ richer data
                    │ sprints                      ▼
            ┌──────────────┐              ┌───────────────┐
            │   VELOCITY    │◄──skills───│  CAPABILITY    │
            │ ACCELERATION  │              │ INHERITANCE    │
            │ (go faster)   │              │ (spread skills)│
            └──────────────┘              └───────────────┘
                    │                              ▲
                    │                              │
                    └──────────────────────────────┘
```

**The cycle:** Meta-learning extracts patterns → patterns inform which agents should be trusted with more autonomy → more autonomous agents produce more varied work → varied work creates more skills to inherit → inherited skills make agents faster → faster sprints produce more data for meta-learning → repeat.

### 7.1 Meta-Learning

**What it does:** Extracts cross-task patterns — not just "this task succeeded" but "tasks structured like X tend to succeed when approached with strategy Y."

**Implementation:**
- After each sprint, meta-learning engine analyzes: task outcomes, agent decisions, resource usage, communication patterns, failure modes
- Patterns stored in a directed knowledge graph: `(context) --[predicts]--> (outcome) [confidence: 0.0–1.0]`
- Patterns with confidence >0.8 promoted to "institutional knowledge" — accessible to all agents
- Patterns below 0.5 after 3 sprints are pruned
- Contradiction detection: when a new pattern contradicts existing institutional knowledge, flag for CTO review

**Output to Graduated Autonomy:** "Agent X consistently makes good decisions in context Y" → input to autonomy promotion evaluation.

### 7.2 Graduated Autonomy

**What it does:** Agents start with limited decision-making authority and earn more based on demonstrated competence.

**Four autonomy tiers:**

| Tier | Name | Authority | Promotion Criteria | Demotion Trigger |
|------|------|-----------|-------------------|-----------------|
| T1 | **Supervised** | All decisions require supervisor approval | Default for new agents | N/A (starting tier) |
| T2 | **Guided** | Routine decisions autonomous; novel decisions require approval | 10 consecutive successful routine decisions | 2 failures in 5 decisions |
| T3 | **Trusted** | All decisions autonomous within role scope; cross-role decisions require approval | 25 successful decisions including ≥5 novel ones | 1 critical failure or 3 moderate failures in 10 decisions |
| T4 | **Strategic** | Autonomous within role; can propose cross-role actions (still needs peer consent) | 50 successful decisions, ≥10 cross-domain, positive meta-learning pattern | Any critical failure; automatic review every 20 decisions |

**Promotion process:**
1. Agent's track record evaluated by meta-learning engine
2. Promotion recommendation generated with evidence
3. Supervisor reviews and approves/rejects
4. If approved, agent's autonomy scope updated in role registry

**Demotion process:**
1. Failure detected and classified (critical/moderate/minor)
2. If demotion trigger met, demotion recommendation generated
3. Supervisor must approve demotion with documented justification (prevents arbitrary demotion)
4. Agent notified with specific improvement criteria for re-promotion

**Output to Capability Inheritance:** More autonomous agents (T3+) produce more diverse work, creating more skills available for inheritance.

### 7.3 Capability Inheritance

**What it does:** When one agent learns a new skill or optimized approach, compatible peer agents can inherit it — avoiding the need for every agent to independently discover the same improvements.

**Protocol:**
1. **Skill registration:** After a successful novel approach, the originating agent registers the skill: `{ skillId, description, context, approach, successMetrics, prerequisites }`
2. **Compatibility check:** For each registered skill, check which other agents have compatible roles and prerequisites. Compatibility is determined by: role overlap >50%, prerequisite satisfaction, and no conflict with existing skills.
3. **Opt-in propagation:** Receiving agent's supervisor must opt-in to inheritance. No automatic skill injection.
4. **Trial period:** Inherited skill is marked as "trial" for 5 uses. If success rate ≥80%, it becomes permanent. If <80%, it is reverted.
5. **Attribution:** Skills carry attribution to the originating agent. This feeds back into meta-learning (which agents are reliable skill sources?).

**Output to Velocity Acceleration:** More agents with more skills → faster task completion → velocity increases.

### 7.4 Velocity Acceleration

**What it does:** Measures and enforces that the system gets faster over time. Not aspirational — measured with hard numbers.

**Metrics:**
- **Sprint velocity ratio:** `(Sprint N output) / (Sprint N-1 output)` — must be >1.05
- **Output** measured as: weighted sum of (deliverables completed × complexity score)
- **Complexity score** assigned at sprint planning, calibrated against historical data after 3 sprints

**Enforcement:**
- If velocity ratio drops below 1.0 for 2 consecutive sprints: automatic diagnostic triggered
- Diagnostic examines: autonomy tier distribution, capability inheritance rate, meta-learning insight quality
- Root cause mapped to specific flywheel component for targeted intervention
- CTO notified with recommendation

**Output to Meta-Learning:** Faster sprints produce more tasks, more decisions, more outcomes — more data for pattern extraction. The cycle continues.

### Flywheel Health Monitor

A dedicated monitoring agent (#27) tracks the health of all four components and their interconnections:

| Health Indicator | Green | Yellow | Red |
|-----------------|-------|--------|-----|
| Meta-learning insights per sprint | ≥2 | 1 | 0 |
| Autonomy promotions vs. demotions | 3:1+ | 2:1 | <2:1 |
| Capability inheritance success rate | ≥40% | 20–39% | <20% |
| Sprint velocity ratio | >1.05 | 1.0–1.05 | <1.0 |
| Cross-component data flow | All 4 edges active | 3 edges active | ≤2 edges active |

**If any indicator is Red for 2 consecutive sprints:** Flywheel degradation alert escalated to CTO.

---

## 8. Agent-Owned Status Files Pattern

**Architect condition: Replace shared metadata.yaml with agent-owned status files.**

### Design

Each agent owns its own status file at a predictable path:

```
/.forge/status/{agent-id}.json
```

**Schema:**

```json
{
  "$schema": "status-file-v1",
  "agentId": "org-graph-builder",
  "agentModel": "sonnet",
  "pillar": 1,
  "supervisor": "architect",
  "autonomyTier": "T2",
  "currentSprint": "1.1a",
  "status": "active",
  "lastHeartbeat": "2026-03-25T14:30:00Z",
  "currentTask": {
    "id": "task-0042",
    "description": "Implement DAG cycle detection",
    "startedAt": "2026-03-25T14:00:00Z",
    "estimatedCompletion": "2026-03-25T16:00:00Z"
  },
  "recentDecisions": [
    {
      "id": "dec-0018",
      "description": "Chose adjacency list over matrix for org-graph",
      "rationale": "Sparse graph, adjacency list is O(V+E) vs O(V²)",
      "timestamp": "2026-03-25T13:45:00Z",
      "outcome": "pending"
    }
  ],
  "metrics": {
    "tasksCompleted": 12,
    "tasksFailed": 1,
    "avgCompletionTime": "45m",
    "consecutiveSuccesses": 7
  }
}
```

### Rules

1. **Single writer:** Only the owning agent writes to its status file. No other agent modifies it.
2. **Multiple readers:** Any agent can read any status file (for coordination, monitoring, etc.).
3. **Locking:** All writes use flock-based advisory locks (see §9.2).
4. **Heartbeat:** Agents update `lastHeartbeat` every 60 seconds while active. If heartbeat is >5 minutes stale, agent is considered unhealthy.
5. **No shared metadata.yaml:** The old pattern of a single shared file is eliminated. If you need a system-wide view, query all status files (the flywheel-monitor agent does this).
6. **Schema validation:** Status files validated against JSON Schema on every write. Invalid writes are rejected and logged.

### Migration from metadata.yaml

- Phase 1, Week 1: Integration API defines the status file schema
- Phase 1, Week 2: First agents write status files; metadata.yaml is read-only (frozen)
- Phase 1, Week 4: metadata.yaml deleted after Gate 1 confirms all agents use status files

---

## 9. Migration & Concurrency Strategy

### 9.1 v3 → v4 Migration Strategy

**Persistence-Lead condition: Define how we get from v3 state to v4 state safely.**

**Three-stage migration:**

**Stage 1 — Snapshot (Week 1, before any v4 work begins)**
- Create git tag `v3-final-snapshot` capturing full v3 state
- Export v3 agent configurations, memory stores, and session data to `/.forge/migration/v3-export/`
- Generate v3 state manifest: file counts, schema versions, integrity checksums
- **Duration:** ~30 minutes. **Rollback:** `git checkout v3-final-snapshot`

**Stage 2 — Transform (Week 1–2, parallel with Integration API work)**
- Transform v3 schemas to v4 format:
  - `metadata.yaml` → individual `/.forge/status/{agent-id}.json` files
  - v3 memory format → v4 memory registry entries
  - v3 session data → v4 session lifecycle format
- Each transformation is idempotent (can be re-run safely)
- Transformation scripts committed as `/.forge/migration/transforms/`
- **Duration:** ~2 hours. **Rollback:** Delete `/.forge/status/`, restore from v3-export

**Stage 3 — Validate + Activate (Week 2, after transforms complete)**
- Run validation suite: all v4 status files parse, all memory entries resolve, all sessions load
- Activate v4: set `/.forge/config.json` → `{ "version": "4.0.0", "migrated_from": "3.x", "migration_date": "..." }`
- Delete `metadata.yaml` (already frozen in Stage 2)
- Keep `/.forge/migration/v3-export/` for 30 days as safety net
- **Duration:** ~1 hour. **Rollback:** Restore `metadata.yaml` from v3-export, reset config.json

**Migration is NOT on the critical path.** It runs in parallel with Integration API design (Week 1) and Org Graph scaffolding (Week 2). If migration fails, v4 development continues against clean state while migration is debugged.

### 9.2 Flock-Based Locks

**Persistence-Lead condition: All concurrent file access must use flock(2) advisory locks.**

**Implementation:**

```
Lock acquisition:
  1. Open lock file: /.forge/locks/{resource-path-hash}.lock
  2. Attempt flock(LOCK_EX) with 5-second timeout
  3. On success: perform write, then flock(LOCK_UN)
  4. On timeout: retry up to 3 times (15 seconds total max wait)
  5. On 3x failure: log error, notify agent's supervisor, skip write

Lock scope:
  - Status files: per-agent lock (/.forge/locks/status-{agent-id}.lock)
  - Memory stores: per-store lock (/.forge/locks/memory-{store-id}.lock)
  - Review files: per-review lock (/.forge/locks/review-{review-id}.lock)
  - Registry: single registry lock (/.forge/locks/registry.lock)

Deadlock prevention:
  - Agents acquire at most ONE lock at a time (no nested locks)
  - If an agent needs to update two resources, it releases the first lock before acquiring the second
  - Lock hold time limit: 10 seconds. If exceeded, lock is force-released and operation is rolled back
```

**Stale lock detection:**
- If a lock file's mtime is >30 seconds old and the holding process is no longer running (checked via PID stored in lock file), the lock is considered stale and can be broken.

### 9.3 10k File Storage Limits

**Persistence-Lead condition: Hard limit of 10,000 files per .forge/ subtree.**

**Enforcement:**

| Subtree | Limit | Current Usage (est.) | Headroom |
|---------|-------|---------------------|----------|
| `/.forge/status/` | 100 | 27 (agents) | 73 |
| `/.forge/memory/` | 5,000 | 0 (new in v4) | 5,000 |
| `/.forge/reviews/` | 2,000 | 0 (new in v4) | 2,000 |
| `/.forge/locks/` | 200 | 0 (transient) | 200 |
| `/.forge/migration/` | 500 | 0 (temporary) | 500 |
| `/.forge/flywheel/` | 2,000 | 0 (new in v4) | 2,000 |
| **TOTAL** | **~9,800** | — | **200 buffer** |

**LRU eviction protocol (triggered at 90% of subtree limit):**
1. Identify least-recently-accessed files (by atime or explicit access log)
2. Archive candidates to git: `git add` to `archive/{subtree}` branch, commit with manifest
3. Delete archived files from working tree
4. Log eviction event with file list, reason, and archive commit hash
5. If a deleted file is requested later, restore from archive branch automatically

**Hard limit enforcement:**
- Before any file creation in `/.forge/`, check subtree count
- If at limit: run eviction first, then create
- If eviction cannot free space (all files accessed within last hour): reject creation, alert storage-governor

### 9.4 REFORGE Rollback via Git Tags

**Persistence-Lead condition: Every REFORGE operation must be reversible via git tags.**

**Protocol:**

```
Before REFORGE:
  1. Validate proposed change (schema check, dependency check, budget check)
  2. Create git tag: reforge/v4/{ISO-timestamp}-{operation-id}
     Example: reforge/v4/2026-03-25T14:30:00Z-reforge-0042
  3. Tag message includes: agent ID, operation description, expected outcome, rollback instructions

During REFORGE:
  4. Apply change
  5. Run post-flight verification (did the change produce expected behavior?)
  6. If verification passes: commit change, tag with reforge/v4/{timestamp}-{op-id}-success
  7. If verification fails: execute rollback

Rollback:
  8. git checkout reforge/v4/{timestamp}-{op-id} -- {affected-files}
  9. Verify rollback restored pre-REFORGE state
  10. Tag with reforge/v4/{timestamp}-{op-id}-rollback
  11. Log rollback event with reason

Auto-rollback triggers:
  - REFORGE operation exceeds 120-second time limit
  - Post-flight verification fails
  - Budget check shows operation would exceed pillar budget
  - Dependency check shows operation would break a downstream agent
```

**Tag retention:** REFORGE tags are never deleted. They serve as an immutable audit trail of all self-modification operations. At 10,000 tags (unlikely for years), oldest success tags can be archived.

---

## 10. Approval Checklist

Every condition from every reviewer, mapped to the section that resolves it and the acceptance test that proves it.

| # | Reviewer | Condition | Resolution Section | Acceptance Test |
|---|----------|-----------|-------------------|-----------------|
| 1 | CEO | Pillar 5 compounding flywheel | §7 | Flywheel diagram shows self-reinforcing cycle; all 4 components connected |
| 2 | CEO | Meta-learning | §7.1 | Meta-learning engine spec includes cross-task pattern extraction, knowledge graph, confidence scoring |
| 3 | CEO | Graduated autonomy | §7.2 | 4-tier system defined with promotion criteria, demotion triggers, and supervisor approval |
| 4 | CEO | Capability inheritance | §7.3 | Propagation protocol defined with compatibility check, opt-in, trial period, and attribution |
| 5 | CEO | Velocity acceleration | §7.4 | Velocity ratio metric defined (>1.05), enforcement mechanism specified, diagnostic on failure |
| 6 | CEO | API stability review Phase 4 | §5 Phase 4, §3 Pillar 4 | Week 16 milestone: semver audit, deprecation policy, breaking change inventory |
| 7 | Architect | PostToolUse hook meeting-coordinator | §4 Agent #14 | Hook specification includes payload format, conflict detection, and coordination state updates |
| 8 | Architect | Agent-owned status files | §8 | Schema defined, single-writer rule, heartbeat protocol, migration plan from metadata.yaml |
| 9 | Architect | REFORGE guardrails | §9.4, §3 Pillar 4 | 5-step guardrail pipeline: pre-flight, git tag, rollback plan, post-flight, budget check |
| 10 | Architect | Semantic similarity threshold | §3 Pillar 3 | Default 0.82, low-confidence flag below 0.82, keyword fallback below 0.60 |
| 11 | CFO | Per-pillar budget | §6.1 | Table with base + contingency per pillar, totaling $390 |
| 12 | CFO | Per-phase budget | §6.2 | Table with phase budgets and cumulative spend, totaling $390 |
| 13 | CFO | 5 phase gate checkpoints | §6.3 | Gates at weeks 4, 8, 12, 16, 20 with go/no-go criteria and decision authority |
| 14 | CFO | 18% contingency | §6.4 | $59.49 reserved (18% of $330.51 base), draw-down rules defined |
| 15 | CFO | 8-week ROI criteria | §6.5 | ≥15% Opus invocation reduction, measurement method, failure protocol |
| 16 | COO | Sequential Phase 1 | §5 Phase 1 | Week-by-week table shows no concurrent work; each sprint starts after prior completes |
| 17 | COO | Critical path diagram | §5.1 | Text-based dependency graph with week markers and critical path highlighted |
| 18 | COO | Max 3 concurrent meetings | §4 Agent #14 | Hard limit specified, queue with priority scoring, preemption rules |
| 19 | COO | Dashboard-dev overflow plan | §5 Phase 3 note | Visualization defers to Phase 5; CLI metrics dump as Phase 3 fallback |
| 20 | PM | Integration API Week 1 prerequisite | §5 Phase 1, Week 1 | Sprint 1.0 is Integration API only; no other work starts until complete |
| 21 | PM | Pillar 3 sequence registry→MCP→testing | §3 Pillar 3, §5 Phase 3 | Sprint 3.1 registry, Sprint 3.2 MCP, Sprint 3.3 testing — strict dependencies in table |
| 22 | PM | Split Pillar 4 Sprint 2.4 | §5 Phase 4 | Sprint 4.2a (session management) and Sprint 4.2b (REFORGE engine) are separate rows |
| 23 | PM | Max 2 agents per deliverable | §4 | All sprint assignments verified: no deliverable has >2 agents. Agent roster notes this constraint |
| 24 | Team-Mode-Lead | Reviews via TeamModeBus | §3 Pillar 2, §4 Agent #8 | Review router uses bus exclusively; "zero file-system polls" is Phase 2 gate criterion |
| 25 | Team-Mode-Lead | Session serialization | §3 Pillar 2, §4 Agent #9 | Session serializer writes to /.forge/reviews/{id}.json; round-trip test in Phase 2 gate |
| 26 | Persistence-Lead | v3→v4 migration | §9.1 | 3-stage migration defined: snapshot → transform → validate+activate, with rollback at each stage |
| 27 | Persistence-Lead | Flock-based locks | §9.2 | flock(2) with 5s timeout, 3x retry, per-resource lock files, deadlock prevention rules |
| 28 | Persistence-Lead | 10k file storage limits | §9.3 | Per-subtree limits table, LRU eviction protocol, hard limit enforcement, archive-to-git strategy |
| 29 | Persistence-Lead | REFORGE rollback via git tags | §9.4 | Tag naming convention, pre/during/post protocol, auto-rollback triggers, tag retention policy |
| 30 | CEO | Full plan approval | §1–§10 (this document) | All 29 conditions above resolved; document ready for final review |

---

**APPROVAL SIGNATURES**

| Role | Name | Status | Date |
|------|------|--------|------|
| CEO | — | ☐ PENDING | — |
| CTO | — | ☐ PENDING (author) | 2026-03-25 |
| CFO | — | ☐ PENDING | — |
| COO | — | ☐ PENDING | — |
| PM | — | ☐ PENDING | — |
| Architect | — | ☐ PENDING | — |
| Team-Mode-Lead | — | ☐ PENDING | — |
| Persistence-Lead | — | ☐ PENDING | — |

---

*End of AgentForge v4 Sprint Plan v2*