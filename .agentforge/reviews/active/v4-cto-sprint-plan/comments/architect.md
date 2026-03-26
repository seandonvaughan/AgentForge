# [architect] Review of AgentForge v4 — CTO Sprint Plan

**Review Date:** 2026-03-26
**Verdict:** REQUEST_CHANGES

---

## Summary

The CTO's sprint plan demonstrates strong strategic thinking and correctly expands the Architect's 3-pillar design to meet CEO mandates. The cost-consciousness is evident throughout, and the decision to downgrade memory-architect to Sonnet is sound. The new pillars (4: Meetings, 5: Self-Improvement) are well-conceived and address real gaps in our current architecture.

However, I identify **4 technical concerns** that require resolution before this plan can proceed to implementation. These are not blockers—they are gaps in specification that, if left unaddressed, will create ambiguity during implementation and likely cause rework.

The plan is **85% ready**. The remaining 15% consists of integration details and mechanism specifications that the CTO should address in a revision pass.

---

## Section-by-Section Comments

### Section: 1.2 What I Am Modifying

**Type:** approval

The CTO's modifications are architecturally sound. Specifically:

| Decision | Architect Assessment |
|----------|---------------------|
| 5 pillars instead of 3 | Correct. CEO mandate is clear. |
| memory-architect → Sonnet | **Strongly agree.** Design work is front-loaded; no ongoing strategic decisions. Opus would be waste. |
| 20 weeks instead of 16 | Realistic given scope increase. |
| web-researcher (Haiku) | Excellent addition. Research delegation to Haiku is exactly the cost pattern we need. |

---

### Section: 2.3 Final v4 Team Roster

**Type:** concern

**Comment:** The consolidation of `ui-designer` into `dashboard-dev` concentrates significant responsibility on one agent. Dashboard-dev now owns:
- Server scaffold
- WebSocket management
- React components
- UI/UX design
- Styling

This is feasible but creates a bottleneck. If dashboard-dev falls behind, there's no parallel path.

**Suggested Change:** No change required, but CTO should acknowledge this as a scheduling risk and ensure dashboard-dev sprints have buffer time. Alternatively, document that `coder` can be pulled in for overflow component work if needed.

---

### Section: 2.5 Pillar Ownership Matrix

**Type:** approval

The ownership matrix is clean. Each pillar has a clear owner with appropriate contributors. The model mix (Sonnet + Opus escalation only for Pillar 5) adheres to v3.2 cost principles.

---

### Section: 3.3 Pillar 2 (Agent Memory)

**Type:** suggestion

**Comment:** The memory decay coefficient of 0.95/day is reasonable:
- 30 days: ~21% relevance remaining
- 60 days: ~4.6% relevance remaining
- 90 days: ~1% relevance remaining

However, the plan does not specify:
1. What triggers memory expiration (relevance threshold)?
2. Is expired memory deleted or archived?
3. Can agents explicitly pin memories to prevent decay?

**Suggested Change:** Add a subsection specifying:
```yaml
memory_decay:
  coefficient: 0.95  # per day
  expiration_threshold: 0.05  # below this, memory is archived
  archive_location: .agentforge/memory/archive/
  pinnable: true  # agents can mark memories as permanent
```

---

### Section: 3.5 Pillar 4 (Agent Meetings)

**Type:** concern

**Comment:** The MeetingCoordinator is described as monitoring `.agentforge/reviews/active/` for new files, but the **monitoring mechanism** is not specified.

Options:
1. **Polling**: Check directory every N seconds
2. **File system events**: Use fs.watch/chokidar
3. **Hook-based**: PostToolUse hook on Write tool triggers coordinator
4. **Explicit dispatch**: Author explicitly dispatches meeting-coordinator

Each has different implementation complexity and reliability characteristics. The architecture must specify which approach we're using.

**Suggested Change:** Add to Section 3.5 or Section 4:

```markdown
**Trigger Mechanism:**
The meeting-coordinator is triggered via PostToolUse hook when:
- Any Write operation targets `.agentforge/reviews/active/**/document.md`
- Any Edit operation modifies `.agentforge/reviews/**/metadata.yaml`

This avoids polling overhead and ensures immediate response.
```

---

### Section: 3.6 Pillar 5 (Self-Improvement)

**Type:** concern

**Comment:** The REFORGE integration is mentioned but not specified. The diagram shows "Team Composition (REFORGE)" as an output, but:

1. What is the interface between improvement-analyst and REFORGE?
2. Does improvement-analyst generate REFORGE YAML directly?
3. Does improvement-analyst propose and CTO/CEO approve before REFORGE execution?
4. What prevents runaway self-modification?

This is a critical control loop that needs explicit specification.

**Suggested Change:** Add a subsection:

```markdown
### REFORGE Integration Protocol

1. improvement-analyst generates `proposed-reforge.yaml` in `.agentforge/proposals/`
2. Proposal includes: agent changes, rationale, expected impact
3. CTO reviews and either approves, modifies, or rejects
4. If approved, CTO runs `agentforge reforge --proposal={id}`
5. Changes are logged in `.agentforge/reforge-history/`

**Guardrails:**
- improvement-analyst CANNOT execute REFORGE directly
- All team composition changes require CTO approval
- Strategic agent changes (Opus tier) require CEO approval
- Maximum 3 REFORGE proposals per week to prevent churn
```

---

### Section: 4.2 Review Metadata Schema

**Type:** blocker

**Comment:** The metadata.yaml file is a shared mutable resource. Multiple agents could attempt to update it simultaneously:
- Reviewer updates their status to "reviewing"
- Meeting-coordinator checks status
- Reviewer updates verdict
- Meeting-coordinator updates next reviewer status

This creates a **race condition** in a multi-agent system.

**Suggested Change:** Implement one of:

**Option A: Lock file pattern**
```
metadata.yaml      # The data
metadata.lock      # Presence indicates write lock
```
Agents acquire lock before mutation, release after.

**Option B: Append-only event log**
```yaml
# metadata.yaml becomes immutable after creation
# Events go to events.log
- timestamp: 2026-03-25T10:00:00Z
  agent: meeting-coordinator
  event: review_started
  data: { reviewer: architect }
```
Meeting-coordinator reconstructs state from event log.

**Option C: Agent-owned status files**
```
metadata.yaml           # Immutable review chain definition
status/architect.yaml   # Architect owns this exclusively
status/cfo.yaml         # CFO owns this exclusively
```
Each agent only writes to their own file. Meeting-coordinator reads all.

I recommend **Option C** as it eliminates coordination overhead entirely. Each agent is sovereign over their status file.

---

### Section: 4.4 Comment Format Template

**Type:** suggestion

**Comment:** The comment format is well-structured, but there's no versioning. If a reviewer needs to amend their comments after seeing subsequent feedback (e.g., CFO's comments reveal a cost issue that changes Architect's assessment), how is this tracked?

**Suggested Change:** Add version headers to comment files:

```markdown
# [architect] Review of {document-title}

**Review Date:** 2026-03-26
**Version:** 1
**Verdict:** REQUEST_CHANGES

---

## Amendment Log

| Version | Date | Reason |
|---------|------|--------|
| 1 | 2026-03-26 | Initial review |
| 2 | 2026-03-27 | Updated after CFO cost concerns |

---
```

---

### Section: 5.1 Token Budget Per Pillar

**Type:** suggestion

**Comment:** The $390 total estimate seems optimistic for 20 weeks of work across 5 pillars. However, this is CFO's domain. I note it only for awareness.

The model mix percentages are architecturally sound and align with v3.2 cost principles.

---

### Section: 6.3 Self-Improvement Metrics

**Type:** concern

**Comment:** "Memory injection relevance: >70% useful" is specified as a target, but the **measurement method** is undefined.

Options:
1. Agent self-reporting (unreliable, gaming risk)
2. Subsequent task success correlation (complex, lagging indicator)
3. Explicit "was this memory helpful?" prompt after task (adds latency)
4. Implicit: if agent re-queries same information, the memory wasn't useful

**Suggested Change:** Specify the measurement approach:

```markdown
**Memory Relevance Measurement:**
Relevance is measured implicitly via re-query rate:
- If agent performs web search for information present in injected memory → memory marked "miss"
- If agent completes task without re-querying injected information → memory marked "hit"
- Relevance % = hits / (hits + misses)
```

---

### Section: Appendix A (Agent YAML Templates)

**Type:** approval

The three new agent templates are well-structured and follow existing patterns. Specific approvals:

- **meeting-coordinator**: Correct model tier (Sonnet), appropriate triggers, proper escalation path to CTO
- **improvement-analyst**: Correct constraints ("propose, don't mandate"), appropriate reports_to relationship
- **web-researcher**: Excellent constraint on "maximum 3 web searches per task" — prevents runaway research costs

---

### Section: Sprint Sequencing (Section 3.1)

**Type:** approval

The phase structure is correctly sequenced:
1. Foundation sprints establish each pillar's core (weeks 1-5)
2. Core features build on foundations (weeks 6-12)
3. Integration happens after individual pillars are stable (weeks 13-17)
4. Polish is last (weeks 18-20)

The dependency ordering is sound. Pillar 4 (Meetings) foundation in week 4 is appropriate—it needs memory (week 2) and messaging infrastructure concepts to be established first.

---

## Approval Conditions

To move from REQUEST_CHANGES to APPROVE, the CTO must address:

| # | Condition | Section Reference |
|---|-----------|-------------------|
| 1 | Specify meeting-coordinator trigger mechanism (recommend PostToolUse hook) | 3.5, 4.6 |
| 2 | Define REFORGE integration protocol with guardrails | 3.6 |
| 3 | Resolve metadata.yaml race condition (recommend agent-owned status files) | 4.2 |
| 4 | Specify memory relevance measurement method | 6.3 |

**Optional improvements** (suggestions, not blocking):
- Add memory decay thresholds and pinning capability
- Add comment versioning for amendment tracking
- Acknowledge dashboard-dev bottleneck risk

---

## Technical Feasibility Assessment

| Component | Feasibility | Notes |
|-----------|-------------|-------|
| Web Dashboard (Pillar 1) | ✅ High | Standard stack, team-familiar |
| Agent Memory (Pillar 2) | ✅ High | JSON + decay is right-sized |
| Agent Tools (Pillar 3) | ✅ High | YAML manifests are proven pattern |
| Agent Meetings (Pillar 4) | ⚠️ Medium-High | Needs trigger mechanism spec |
| Self-Improvement (Pillar 5) | ⚠️ Medium | REFORGE integration needs spec |
| 1,500+ tests in 20 weeks | ✅ Achievable | ~75 tests/week is reasonable |
| $390 budget | ⚠️ Optimistic | CFO should validate |

---

## Alignment with v3.2 Architecture

| v3.2 Principle | Plan Alignment |
|----------------|----------------|
| Hard activation command | ✅ Maintained |
| Sonnet as conduit | ✅ 78% Sonnet, Opus strategic-only |
| Peer-to-peer agent comms | ✅ Meeting protocol enables this |
| Opus for strategic escalations only | ✅ Explicit in model assignment rules |
| Cost-first routing | ✅ web-researcher (Haiku) delegation |

The plan is architecturally consistent with v3.2 principles.

---

**End of Architect Review**

*Reviewer: architect*
*Model: Opus*
*Timestamp: 2026-03-26T00:00:00Z*