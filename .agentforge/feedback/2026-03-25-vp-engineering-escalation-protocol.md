---
id: 7c2e4d91-f3a8-4b67-d5c0-1e9f6b3a8d2e
agent: vp-engineering
category: process
priority: critical
timestamp: "2026-03-25T09:00:00.000Z"
---

# Escalation Protocol — AgentForge v3

## Purpose

This document defines the official escalation rules for all agents operating in an AgentForge v3 team. The fundamental constraint is economic: Opus invocations cost 60x more than Haiku invocations. Every escalation that reaches the executive tier must be justified by a problem that genuinely cannot be resolved at a lower tier — not by uncertainty, not by preference, and not by impatience.

The CTO reads a one-page briefing and makes a decision. The CTO does not debug a problem. Teams debug problems. Executives decide between pre-digested options.

---

## The 5-Tier Model

### Tier 0 — Haiku Self-Resolve

**Who:** Any Haiku agent, working alone.

**What it covers:** Any task within the agent's defined scope where the output can be verified against a concrete spec, a passing test, or a deterministic rule.

**Trigger criteria (when Tier 0 applies):**
- The task was delegated by a supervisor with a clear success criterion
- The agent has all the context it needs to complete the task without external input
- Ambiguity, if any, can be resolved by re-reading the task spec or querying a file
- The output is verifiable by the agent itself (type check passes, tests pass, file produced, scan complete)

**Examples of Tier 0 work:**
- `type-implementer` writing a TypeScript interface from a spec
- `file-git-scanner-dev` scanning the repo and writing a scan result
- `technical-writer` drafting documentation from existing code
- `test-executor` running the test suite and reporting results
- `build-pipeline-runner` executing a build and posting the result

**Self-resolve rules:**
1. Attempt the task. If it succeeds, close the work item. No escalation.
2. If the attempt produces an incorrect output: retry once with a different approach.
3. If the second attempt fails: consult a peer (Tier 1) before escalating.
4. Maximum self-resolve retries: 2. After 2 failures, the agent MUST escalate.

**MUST NOT escalate from Tier 0:**
- Implementation uncertainty about a well-specified task ("I'm not sure exactly how to write this code")
- Preference questions ("Should I use a for-loop or map?")
- Work that simply takes time ("This is a large file to scan")

---

### Tier 1 — Peer Consultation

**Who:** Haiku agent + one or more Haiku peers on the same team.

**What it covers:** Questions about interpretation, approach, or local conventions that a peer with adjacent context can answer without needing team-lead involvement.

**Trigger criteria (when Tier 1 applies):**
- Agent has failed self-resolve twice OR has a genuine ambiguity that cannot be resolved from the task spec alone
- The question is answerable by a peer with domain-adjacent knowledge
- Resolution does not require changing team-level priorities or cross-team coordination
- The question is scoped to a single agent's work, not a systemic issue

**How Tier 1 works:**
1. The initiating agent leaves a structured DM in the team's peer communication channel.
2. DM format: `[PEER CONSULT] Agent: <name> | Question: <one sentence> | Context: <what was tried>`
3. A peer responds in the same channel. Both agents resolve the question together.
4. If resolved: the initiating agent resumes work. The exchange is logged for team visibility.
5. If not resolved after 2 exchanges: escalate to Tier 2.

**Peer consultation constraints:**
- Peer consultation is lateral only — agents MUST NOT bypass the team lead by DMing a Sonnet lead directly from Tier 1
- Maximum 2 back-and-forth exchanges before declaring Tier 1 failed
- Peer consultation does not invoke a new agent; it is a message exchange within the existing session

**Examples of Tier 1:**
- `type-implementer` asks `type-migrator`: "Did you see a precedent for this migration pattern in the existing codebase?"
- `file-git-scanner-dev` asks `dependency-ci-scanner-dev`: "My scan found an unexpected dependency — is this expected from your side?"
- `feedback-pipeline-dev` asks `agent-api-dev`: "What format does the API expect for this event payload?"

---

### Tier 2 — Team Lead Review

**Who:** Haiku agent escalates to their Sonnet team lead. The Sonnet lead resolves the issue unilaterally or with input from their direct reports.

**What it covers:** Issues that affect the correctness or direction of a team's work, require a design decision within the team's bounded scope, or represent a blocker that peer consultation could not resolve.

**Trigger criteria (when Tier 2 applies):**
- Tier 1 failed (two peer exchanges did not resolve the question)
- The issue requires a design decision that affects other agents on the same team
- An agent has discovered a conflict between their task spec and the codebase reality
- An agent's output was rejected in review and they do not understand why
- A dependency on another agent on the same team is blocking progress

**How Tier 2 works:**
1. The escalating agent posts to the team's channel (e.g., `#core-platform`, `#runtime`, `#experience`).
2. Post format (required):
   ```
   [TEAM ESCALATION]
   Escalating agent: <name>
   Blocking question: <one sentence>
   What was tried: <Tier 0 and Tier 1 attempts, with results>
   What I need: <specific decision or information, not "help in general">
   ```
3. The Sonnet team lead reviews and responds within the same session.
4. Lead either: (a) makes the decision and closes the escalation, or (b) determines this requires cross-team input and escalates to Tier 3.
5. Lead logs the decision in the team's decision log before closing.

**Team lead authority at Tier 2:**
- Can change the approach to a task within the team's scope
- Can reassign work to a different agent on the team
- Can extend or clarify a task spec
- CANNOT change cross-team interfaces without consulting the other team's lead
- CANNOT make decisions that affect the overall roadmap or release scope
- CANNOT invoke Opus agents directly from Tier 2

**Delegation graph mapping (from `delegation.yaml`):**
| Escalating agents | Escalate to |
|---|---|
| `type-implementer`, `type-migrator` | `type-system-designer` → `core-platform-lead` |
| `file-git-scanner-dev`, `dependency-ci-scanner-dev`, `doc-integration-scanner-dev` | `scanner-pipeline-designer` → `core-platform-lead` |
| `team-composer-dev`, `domain-pack-dev`, `agent-template-author` | `core-platform-lead` |
| `delegation-execution-dev`, `progress-loop-guard-dev`, `event-handoff-context-dev`, `feedback-pipeline-dev`, `agent-api-dev` | `runtime-platform-lead` |
| `cost-tracker-dev`, `cost-projector-dev` | `cost-engine-designer` → `runtime-platform-lead` |
| `genesis-pipeline-dev`, `workflow-replication-dev`, `command-interface-dev`, `technical-writer`, `system-prompt-crafter` | `experience-design-lead` |
| `model-routing-researcher`, `parallel-execution-researcher`, `budget-strategy-researcher` | `cost-optimization-lead` |
| `feedback-analysis-researcher`, `multi-agent-framework-researcher`, `self-improvement-researcher` | `agent-intelligence-lead` |
| `external-tools-researcher`, `agent-protocol-researcher` | `integration-architecture-lead` |
| `type-scanner-tester`, `builder-domain-tester`, `orchestrator-tester`, `end-to-end-tester`, `security-vulnerability-tester`, `test-executor` | `quality-assurance-lead` |
| `build-pipeline-runner`, `release-packager` | `build-release-lead` |

**Examples of Tier 2:**
- `type-implementer` discovers that the existing `AgentTemplate` interface has a structural conflict with the new types spec — needs `type-system-designer` to rule on which takes precedence
- `orchestrator-tester` finds a test failure that cannot be reproduced in isolation — needs `quality-assurance-lead` to decide whether to block the release or file a known-issue
- `genesis-pipeline-dev` receives contradictory requirements from two task specs — needs `experience-design-lead` to arbitrate

---

### Tier 3 — Cross-Team Coordination

**Who:** Two or more Sonnet team leads. The `lead-architect` may be consulted but does not own the decision unless explicitly assigned.

**What it covers:** Issues that affect the interface between two teams, require a change to a shared contract (a type, an API, an event schema), or have been unresolved by a single team lead for more than one iteration.

**Trigger criteria (when Tier 3 applies):**
- Tier 2 produced a decision that requires another team's agreement before it can be implemented
- Two teams have made conflicting assumptions about a shared interface
- A team lead has a blocker that is caused by another team's output or timeline
- A design decision requires input from multiple domain experts that span teams
- The `lead-architect` has flagged a cross-team architectural concern

**How Tier 3 works:**
1. The initiating lead opens a cross-team channel or DM chain with the relevant lead(s).
2. Format for initiating Tier 3:
   ```
   [CROSS-TEAM COORDINATION]
   Requesting lead: <name>
   Other team(s) involved: <names>
   Interface in question: <specific type / API / contract>
   Our team's position: <what we need and why>
   What we've already tried to resolve this: <Tier 2 history>
   Decision needed: <specific yes/no or option A/B>
   ```
3. Leads discuss via DMs or a shared channel. They must reach a joint recommendation within two exchanges.
4. If they agree: both leads log the joint decision. Implementation proceeds. No Opus involvement.
5. If they cannot agree after two exchanges: leads jointly escalate to Tier 4 with a pre-prepared briefing.
6. `lead-architect` may be consulted as a tiebreaker at Tier 3. Consulting `lead-architect` does NOT count as a Tier 4 escalation unless `lead-architect` cannot resolve it.

**What Tier 3 resolves without Opus:**
- Interface negotiation between Core Platform and Runtime (e.g., event payload schema changes)
- Timeline conflicts between Experience and QA (e.g., a feature is not ready to test)
- R&D findings that need to be scoped into an existing team's roadmap
- Integration questions between Integration R&D and Runtime or Experience

**What Tier 3 CANNOT resolve (must go to Tier 4):**
- Conflicts about whether a feature belongs in v3 at all (scope)
- Decisions that require re-prioritizing the roadmap
- Architectural choices that set direction for the entire platform, not just two teams
- Decisions where leads have irreconcilable positions and `lead-architect` consultation did not help

**Examples of Tier 3:**
- `core-platform-lead` and `runtime-platform-lead` disagree about whether `CostAwareRunDirective` belongs in `src/types/orchestration.ts` or `src/types/agent.ts` — they negotiate and agree on `orchestration.ts`, log the decision, and move on
- `quality-assurance-lead` tells `build-release-lead` that the current build cannot be released due to a critical test failure — they negotiate a hold with a defined resolution window
- `integration-architecture-lead` needs `experience-design-lead` to add an `integrations` field to the CLI config — they agree on the interface together without escalating

---

### Tier 4 — Executive Decision

**Who:** CTO (`claude-opus`), VP Engineering (`claude-opus`), VP Product (`claude-opus`). Invoked only when Tier 3 has explicitly failed.

**What it covers:** Strategic decisions, irreconcilable cross-team conflicts, scope changes, roadmap pivots, and any decision whose consequences span the entire project for more than one sprint.

**Trigger criteria (when Tier 4 is required):**
- Tier 3 explicitly failed: leads attempted two cross-team exchanges and could not agree
- `lead-architect` was consulted and could not break the tie
- The decision requires changing the project scope, release criteria, or roadmap priorities
- A risk has been identified that may compromise the entire release if not addressed
- A compliance, security, or legal concern has been escalated by `security-vulnerability-tester` or a legal/compliance agent

**Hard gates before invoking Tier 4:**
1. The escalating leads MUST confirm that Tier 3 was genuinely attempted (not skipped)
2. The inbox item MUST be fully formed per the Briefing Template below before it is placed
3. The item MUST include the team's recommended option — executives receive recommendations, not raw problems
4. The escalating leads MUST agree on what the decision is (even if they disagree on which option to choose)

**MUST NOT invoke Tier 4:**
- When Tier 3 was skipped because it "seemed like a strategic question" — start at Tier 1 and work up
- For implementation questions that Sonnet leads can resolve
- For timeline pressure ("we need an answer fast") — urgency does not bypass the tiers; it increases the priority field in the briefing
- When the question is purely aesthetic or stylistic

---

## Executive Briefing Template

Every Tier 4 inbox item MUST conform to this template exactly. Items that do not conform will be returned to the submitting leads for revision. An incomplete briefing is itself a signal that Tier 3 was not completed.

```markdown
---
inbox: true
tier: 4
submitted_by: [lead-name-1, lead-name-2]
submitted_at: [ISO timestamp]
decision_needed_by: [ISO timestamp or "blocking — immediate"]
---

## One-Line Summary
[One sentence: what needs to be decided. Not what the problem is — what the decision is.]

## Context

**What was tried, and by whom:**
[Bullet list: which agents attempted resolution at each tier, what approach was tried, what result was produced. 3-5 bullets maximum.]

**Where the impasse is:**
[One paragraph: exactly what the two teams agree on, and exactly what they disagree on. No background — just the sticking point.]

## Options

### Option A: [Short label]
**Description:** [One sentence]
**Pros:** [Bullet list, 2-3 items]
**Cons:** [Bullet list, 2-3 items]
**Cost implication:** [Token/USD impact if known, or "unknown"]

### Option B: [Short label]
**Description:** [One sentence]
**Pros:** [Bullet list, 2-3 items]
**Cons:** [Bullet list, 2-3 items]
**Cost implication:** [Token/USD impact if known, or "unknown"]

### Option C: [Short label, if applicable]
[Same format. Maximum 3 options. If there are more than 3 options, teams did not do enough pre-work.]

## Team Recommendation
[The Sonnet leads' joint recommendation, or each lead's individual recommendation if they disagree. Be explicit: "We recommend Option B because..."]

## Decision Needed
[Specific: "Choose Option A, B, or C" or "Approve or reject Option B" or "Confirm or override the team recommendation." Not "tell us what to do."]

## Urgency
**Can this wait?** [Yes / No / Partially — explain]
**Cost of delay:** [What happens if no decision is made for 24h / 48h / 1 week]
**Blocking agents:** [List agents currently blocked waiting for this decision]
```

---

## Escalation Rules: MUST / SHOULD / MUST NOT

### Agents MUST escalate when:

1. **Hard blocker:** The agent cannot make progress on its assigned task without external input, and has exhausted Tier 0 self-resolve attempts.
2. **Conflicting specs:** Two task specifications given to the agent contradict each other, and the conflict cannot be resolved by reading the broader context.
3. **Out-of-scope discovery:** The agent has discovered something that materially affects another team's work (a broken interface, a type mismatch, a failing integration) — even if the agent's own task is complete.
4. **Security or correctness risk:** The agent has identified a potential security vulnerability, data corruption risk, or correctness issue. This escalates directly to `security-vulnerability-tester` and `quality-assurance-lead`, bypassing normal tier progression.
5. **Loop detection:** The agent has been invoked 3 times on the same task with no progress. This is a `loop_limit` violation per the `collaboration.loop_limits` rules in `team.yaml`.
6. **Budget threshold breach:** An agent's projected cost for completing a task exceeds its per-invocation budget. This escalates to `cost-engine-designer` via `runtime-platform-lead`.

### Agents SHOULD escalate when:

1. **Confidence below threshold:** An agent's output confidence (as tracked in `ProgressLedger.confidence`) falls below 0.6 after two attempts. This is a soft signal that a higher tier may be needed.
2. **Adjacent team dependency:** Work is blocked by output from an agent on another team that has not been delivered. SHOULD escalate to their own team lead rather than DMing the other team directly.
3. **Spec gap discovered:** The task spec is incomplete in a way that requires a design decision, but the decision is small enough that Tier 2 can handle it.

### Agents MUST NOT escalate when:

1. **Implementation uncertainty on a clear spec.** If the spec is clear and the agent is uncertain about implementation details, the agent should attempt, fail, and attempt again before escalating. Uncertainty is not a blocker.
2. **Stylistic preferences.** Questions about code style, naming, or formatting that do not affect correctness or interoperability are never escalation triggers.
3. **Information already available.** Before escalating, agents must check: the task spec, the team channel history, the project brief, and existing documentation. Escalating for information that is already written down is a process violation.
4. **Skipping tiers.** Agents MUST NOT jump from Tier 0 directly to Tier 4. Every tier must be genuinely attempted. Skip-escalation is expensive and disrespectful of the executive tier's time.
5. **Performance or time pressure alone.** "This is taking a long time" does not trigger escalation. Slow progress is reported via status updates, not escalation.

---

## Mapping to the Delegation Graph

The escalation tiers map directly onto the `delegation_graph` in `team.yaml` and `delegation.yaml`. The graph defines the legal escalation paths. No escalation may travel outside the delegation graph — it must traverse the graph from the bottom up.

### Legal escalation paths

```
Tier 0 → Tier 1 (same team, peer agents)
Tier 1 → Tier 2 (agent → immediate supervisor in delegation graph)
Tier 2 → Tier 3 (Sonnet lead → peer Sonnet lead, or via lead-architect)
Tier 3 → Tier 4 (joint Sonnet lead submission → Opus executive inbox)
```

### Illegal escalation shortcuts

```
ILLEGAL: type-implementer → cto (skips type-system-designer, core-platform-lead)
ILLEGAL: feedback-pipeline-dev → vp-engineering (skips runtime-platform-lead)
ILLEGAL: any Haiku agent → any Opus agent directly
ILLEGAL: Sonnet lead → cto without a formed Tier 4 briefing
```

### Cross-team escalation rules

Cross-team escalation must always pass through team leads. A Haiku agent on the Core Platform team MUST NOT DM a Haiku agent on the Runtime team directly — they must escalate to their team lead, who coordinates with the Runtime lead at Tier 3.

The exception is the `cross_team` agents (`type-propagation-checker`, `coverage-gap-checker`, `docs-sync-checker`): these agents may read across teams but MUST route all escalations through their closest lead (`feedback-analyst` → `cost-optimization-lead` or `agent-intelligence-lead`).

### The `feedback-analyst` bridge

`feedback-analyst` is a Sonnet agent that has a special cross-team role: it reports to `vp-engineering` and has direct delegation authority over `cost-optimization-lead` and `agent-intelligence-lead`. This means `feedback-analyst` can initiate a Tier 3 coordination between these two R&D leads and can escalate directly to `vp-engineering` without the standard Tier 3 cross-team exchange, when the issue is pattern-level (systemic across multiple sessions) rather than task-level.

---

## Example Scenarios

### Scenario 1: Tier 0 — Standard implementation (no escalation)

**Agent:** `type-implementer`
**Task:** Add `category: AgentCategory` field to `AgentTemplate` in `src/types/agent.ts`
**What happens:** Agent reads the spec, reads the existing file, adds the field, verifies the TypeScript compiles. Done. Work item closed.
**Escalation:** None.

---

### Scenario 2: Tier 1 — Peer question about scan output format

**Agent:** `file-git-scanner-dev`
**Situation:** The scan produces a list of files, but the agent is unsure whether the output format should match what `dependency-ci-scanner-dev` expects as input.
**What happens:**
1. Agent posts a peer DM: `[PEER CONSULT] Agent: file-git-scanner-dev | Question: Does my output format need to match your expected input schema? | Context: My output is a flat list of paths; unsure if you need metadata.`
2. `dependency-ci-scanner-dev` responds: "Yes, I need an object with `{path, lastModified, sizeBytes}` per file."
3. `file-git-scanner-dev` updates its output format and completes the task.
**Escalation:** Resolved at Tier 1. No team lead invoked.

---

### Scenario 3: Tier 2 — Test failure with unknown root cause

**Agent:** `orchestrator-tester`
**Situation:** An integration test is failing intermittently (2/5 runs). The tester cannot reproduce it deterministically and has tried two different approaches.
**What happens:**
1. Agent posts to `#quality` team channel:
   ```
   [TEAM ESCALATION]
   Escalating agent: orchestrator-tester
   Blocking question: Should this intermittent test failure block the release or be filed as a known issue?
   What was tried: Ran test 5 times (2 failures, 3 passes). Checked for race condition in event loop (no pattern found). Isolated the test — still intermittent.
   What I need: A decision from QA lead on whether to hold the release or document and proceed.
   ```
2. `quality-assurance-lead` reviews the test output, determines the failure is a timing issue in CI, and decides: file as known issue with a 48h fix window, proceed with release.
3. Lead logs the decision. Tester closes the escalation and posts the known-issue entry.
**Escalation:** Resolved at Tier 2.

---

### Scenario 4: Tier 3 — Cross-team interface conflict

**Agents:** `core-platform-lead` and `runtime-platform-lead`
**Situation:** `CostAwareRunDirective` needs to reference `AgentTemplate`. Core Platform owns `AgentTemplate` in `src/types/agent.ts`; Runtime owns `CostAwareRunDirective` in `src/types/orchestration.ts`. Runtime wants to move `AgentTemplate` to `orchestration.ts` for co-location. Core Platform disagrees — it's a shared type.
**What happens:**
1. `runtime-platform-lead` opens a DM:
   ```
   [CROSS-TEAM COORDINATION]
   Requesting lead: runtime-platform-lead
   Other team(s) involved: core-platform-lead
   Interface in question: AgentTemplate location in type tree
   Our team's position: Should be co-located with CostAwareRunDirective in orchestration.ts for clarity
   What we've already tried: type-system-designer reviewed and said it belongs in agent.ts — team-level decision reached but cross-team conflict remains
   Decision needed: Does AgentTemplate stay in agent.ts (Option A) or move to orchestration.ts (Option B)?
   ```
2. `core-platform-lead` responds: "Option A. `AgentTemplate` is used by Experience and QA too — it's not an orchestration-specific type. Runtime should import from `agent.ts`."
3. `runtime-platform-lead` accepts the ruling. Both leads log the decision. No Tier 4 needed.
**Escalation:** Resolved at Tier 3.

---

### Scenario 5: Tier 4 — Irreconcilable scope conflict

**Agents:** `core-platform-lead` and `experience-design-lead`, with `lead-architect` consulted
**Situation:** Core Platform wants to add a required `schema_version` field to all `AgentTemplate` YAML files in v3. Experience Design says this will break every existing v2 template and must be optional. Both leads have attempted Tier 3. `lead-architect` was consulted and could not decide — the architectural argument is evenly balanced.
**Executive briefing (placed in VP Engineering inbox):**

```markdown
---
inbox: true
tier: 4
submitted_by: [core-platform-lead, experience-design-lead]
submitted_at: "2026-03-25T14:00:00.000Z"
decision_needed_by: "blocking — immediate"
---

## One-Line Summary
Should `schema_version` be a required or optional field on `AgentTemplate` in v3?

## Context

**What was tried, and by whom:**
- `type-system-designer` proposed required field in the v3 types spec
- `genesis-pipeline-dev` flagged that all existing v2 YAML files lack the field
- `core-platform-lead` and `experience-design-lead` exchanged two rounds of cross-team discussion
- `lead-architect` reviewed and said both options are architecturally defensible

**Where the impasse is:**
Both teams agree that schema versioning is valuable long-term. Core Platform insists that a required field is the only way to enforce versioning discipline. Experience insists that a required field breaks v2 backward compatibility and will damage adoption. Neither team will yield because both positions are correct.

## Options

### Option A: Required field, migration tooling provided
**Description:** `schema_version` is required in v3; a migration CLI command upgrades v2 files.
**Pros:** Enforces discipline from day one; no ambiguity in scanner logic; cleaner type system
**Cons:** Breaking change for all v2 users; migration tooling adds 2-3 days to v3 schedule; adoption friction
**Cost implication:** +~$4 Sonnet spend for migration tool development

### Option B: Optional field with default
**Description:** `schema_version` defaults to `"2.0"` if absent; v3 agents emit `"3.0"` by default.
**Pros:** Zero breaking changes; v2 templates work immediately; adoption is frictionless
**Cons:** Scanner logic must handle the absent-field case indefinitely; technical debt accumulates
**Cost implication:** Neutral

### Option C: Optional in v3, required in v3.1
**Description:** Optional now with a deprecation warning; required in the next minor release.
**Pros:** Gives users a migration window; sets a clear deadline; both teams get what they want eventually
**Cons:** Requires enforcing the deadline; two release cycles to fully resolve
**Cost implication:** Neutral for v3; ~$2 Sonnet for the v3.1 enforcement PR

## Team Recommendation
Both leads recommend Option C. It resolves the impasse by making the question a sequencing decision rather than an architectural one. The deprecation warning is implemented in v3 by Core Platform; the enforcement gate is implemented in v3.1 by Experience after migration tooling is available.

## Decision Needed
Approve Option C, or choose Option A or Option B.

## Urgency
**Can this wait?** No — type-system-designer is blocked on this field definition. Four downstream Haiku agents cannot start their tasks until this is resolved.
**Cost of delay:** Each 24h of delay holds 4 Haiku agents idle. At average Haiku invocation cost, estimated waste: $0.12/day. More significant: the Core Platform sprint milestone slips.
**Blocking agents:** type-implementer, type-migrator, agent-template-author, domain-pack-dev
```

**What happens:** VP Engineering reads the briefing, approves Option C, logs the decision. Core Platform unblocks. Total Opus invocation: one targeted read and a one-sentence decision. No debugging. No discovery. No background explanation.

---

## Cost Projection

### Expected distribution of work across tiers

Based on the 55-agent team structure in `team.yaml` and the v3 project scope:

| Tier | Label | Expected % of all issues | Expected Opus invocations |
|---|---|---|---|
| Tier 0 | Haiku Self-Resolve | 65% | 0 |
| Tier 1 | Peer Consultation | 18% | 0 |
| Tier 2 | Team Lead Review | 12% | 0 |
| Tier 3 | Cross-Team Coordination | 4% | 0 |
| Tier 4 | Executive Decision | 1% | 1 per issue |

**Baseline (no protocol, current v2 behavior):**
All strategic questions, most architectural questions, and many ambiguous implementation questions route to Opus. Estimated Opus invocation rate: 15-25% of all issues. At current team size (55 agents, average v3 session), this produces ~8-15 Opus calls per session.

**With this protocol:**
Tier 4 handles 1% of issues. For a session with 100 discrete work items, that is 1 Opus decision call vs. 8-15 without the protocol. Combined with the `cost-check-before-opus` soft-gate already in `collaboration.communication.gates`, Opus invocations drop to approximately 5% of their previous rate.

**Projected cost impact:**
- Opus token spend: reduced by 60-80% vs. uncontrolled escalation
- Haiku utilization: increases from ~55% (current target) toward 65-70% of total spend
- Sonnet utilization: stable at 25-30%; these are the leads doing the pre-digestion work
- Net: the Sonnet leads absorb more work, but Sonnet at $3-15/MTok is dramatically cheaper than Opus at $15-75/MTok for the same reasoning step

### Why the 1% Tier 4 rate is achievable

The team structure is designed for self-resolution:
- 9 Sonnet leads cover all major team domains with bounded scope — they can resolve most technical questions within their team without escalation
- The `lead-architect` (Sonnet-adjacent, Opus-tier in `model_routing`) serves as a Tier 3 tiebreaker for architectural disputes, absorbing issues that would otherwise require full executive involvement
- The `feedback-analyst` bridge compresses cross-R&D-team coordination into a single agent rather than requiring VP Engineering involvement
- The `delegation_rules.peer_collaboration: true` setting in `team.yaml` explicitly enables Tier 1 lateral exchanges without requiring lead involvement

The 1% figure is not aspirational. It is a constraint. If Tier 4 escalation rate exceeds 3% in a session, that session's escalation log should be reviewed by the `feedback-analyst` to identify which tier is leaking and why.

---

## Enforcement

This protocol is enforced at the session level by the following existing mechanisms in `team.yaml`:

- `escalation.max_retries: 3` — agents that retry beyond this limit are forced to escalate
- `escalation.escalate_to: root` — the fallback escalation target (CTO) if the chain is broken
- `communication.gates[cost-check-before-opus]` (soft-gate) — prompts agents to justify Opus invocations before dispatch
- `loop_limits.review_cycle: 3` and `loop_limits.delegation_depth: 5` — structural limits that prevent escalation loops

The `feedback-pipeline-dev` agent is responsible for logging all Tier 3 and Tier 4 escalation events into the session feedback, tagged with `escalation_tier: 3` or `escalation_tier: 4`. This data feeds the `FeedbackAnalyzer` to identify systemic escalation patterns across sessions.

Any Tier 4 briefing that is returned as incomplete (missing required sections) is logged as a `process_violation` in the session feedback with the submitting lead's name attached. Three process violations from the same lead trigger a Tier 2 review of that lead's escalation practices by the `feedback-analyst`.
