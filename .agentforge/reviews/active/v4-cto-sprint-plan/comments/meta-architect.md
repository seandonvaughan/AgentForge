# [meta-architect] Review of AgentForge v4 — CTO Sprint Plan

**Review Date:** 2026-03-26
**Verdict:** REQUEST_CHANGES

---

## Summary

The CTO Sprint Plan correctly addresses the CEO's 5-pillar mandate and demonstrates disciplined cost-consciousness in model tier assignments. The team expansion from 20 to 27 agents is justified by scope. However, the **Self-Improvement Loop (Pillar 5)** as currently specified does not form a true flywheel—it's a feedback mechanism without the closed-loop characteristics that create compounding returns.

Additionally, two critical agent role definitions are underspecified, which will create ambiguity during implementation: `improvement-analyst` has unclear authority boundaries, and `meeting-coordinator` lacks escalation paths for blocked reviews.

The architect's concerns about REFORGE integration and race conditions are valid. I add three additional concerns specific to team composition and flywheel design that must be addressed.

---

## Comments

### Section: 2.2 New Agents for v4

**Type:** concern

**Comment:** The `improvement-analyst` agent is positioned as the driver of Pillar 5, but its role definition conflates three distinct responsibilities:

1. **Metrics Collection** — Gathering performance data from agent runs
2. **Analysis** — Identifying patterns, bottlenecks, regressions
3. **Proposal Generation** — Writing REFORGE proposals

These require different skill profiles. Metrics collection is mechanical (Haiku-appropriate). Analysis requires pattern recognition across context (Sonnet-appropriate). Proposal generation requires understanding team dynamics and strategic implications (borderline Opus).

**Suggested Change:** Either:
- Split into `metrics-collector` (Haiku) + `improvement-analyst` (Sonnet), or
- Explicitly scope improvement-analyst to analysis only, with proposal generation delegated to CTO

---

### Section: 2.5 Pillar Ownership Matrix

**Type:** suggestion

**Comment:** The ownership matrix shows `meeting-coordinator` owning Pillar 4 with `team-mode-lead` and `project-manager` as contributors. This creates an unclear authority hierarchy:

- Who decides when a review is "stuck" and needs escalation?
- Who can override a reviewer's block?
- Who owns the review lifecycle vs. the meeting lifecycle?

Without clarity, `meeting-coordinator` and `project-manager` will duplicate effort or deadlock on authority.

**Suggested Change:** Add explicit role boundaries:

```yaml
pillar_4_roles:
  meeting-coordinator:
    owns: meeting scheduling, participant selection, quorum tracking
    does_not_own: review verdicts, escalation decisions
  project-manager:
    owns: timeline enforcement, escalation to CTO when reviews block
    does_not_own: meeting content, participant selection
  team-mode-lead:
    owns: communication protocol, message routing via TeamModeBus
    does_not_own: scheduling, escalation
```

---

### Section: 3.6 Pillar 5 (Self-Improvement)

**Type:** blocker

**Comment:** The Self-Improvement Loop as described is **not a flywheel**. A flywheel requires:

1. **Output feeding input** — Each cycle's output becomes the next cycle's input
2. **Compounding returns** — Each cycle produces more value than the last
3. **Decreasing friction** — The system gets easier to turn over time

The current design describes a linear feedback loop:

```
Metrics → Analysis → Proposal → Approval → REFORGE → (end)
```

There's no mechanism for:
- Improvements improving the improvement process itself
- Learning from rejected proposals
- Measuring whether previous improvements actually improved performance
- Reducing the cost of future improvement cycles

**Suggested Change:** Close the loop with these additions:

```markdown
### Flywheel Closure Mechanisms

1. **Retrospective Metrics**
   - After each REFORGE, improvement-analyst measures:
     - Did the change improve target metrics?
     - What was the cost of the improvement cycle?
     - How accurate was the expected-impact estimate?
   - Results feed into proposal quality scoring

2. **Meta-Improvement**
   - improvement-analyst tracks its own proposal acceptance rate
   - High rejection rate triggers self-analysis of proposal patterns
   - Successful patterns are codified into improvement-analyst's memory

3. **Friction Reduction**
   - First 3 REFORGE cycles: Full CTO review required
   - After 80% acceptance rate: CTO can delegate low-risk proposals to COO
   - After 90% acceptance rate: Auto-approve proposals under confidence threshold

4. **Improvement Velocity Tracking**
   - Metric: "Time from identified problem to deployed fix"
   - Goal: Reduce this metric by 10% per quarter
   - This is the flywheel's primary KPI
```

---

### Section: 2.3 Final v4 Team Roster

**Type:** approval

**Comment:** The model distribution (4 Opus / 21 Sonnet / 2 Haiku) is appropriate for v4 scope. The 15% Opus / 78% Sonnet / 7% Haiku split aligns with v3.2 cost principles. Downgrading memory-architect from Opus to Sonnet is correct—design work front-loads, then diminishes.

The addition of `web-researcher` (Haiku) for delegated research is excellent. This pattern should be documented as a template for future utility agent additions.

---

### Section: 3.5 Pillar 4 (Agent Meetings)

**Type:** suggestion

**Comment:** The meeting/review architecture introduces a new agent coordination pattern that doesn't exist in v3. We have:

- **v3 pattern**: Direct dispatch (Agent A dispatches Agent B, waits for result)
- **v4 pattern**: Asynchronous review chain (Agent A writes, Coordinator notifies B, B writes, Coordinator notifies C, ...)

This is a significant architectural addition that affects more than Pillar 4. The pattern should be:

1. Named explicitly ("Async Review Chain" or "Sequential Multi-Agent Review")
2. Documented as a reusable pattern in `docs/patterns/`
3. Tested independently of the document review use case

**Suggested Change:** Add to architecture documentation:

```markdown
## Pattern: Sequential Async Review

A coordination pattern where:
1. A document enters review state
2. A coordinator agent sequences reviewers
3. Each reviewer reads prior reviews, adds theirs, signals completion
4. Coordinator advances to next reviewer
5. Final reviewer or quorum triggers completion

This pattern differs from direct dispatch because:
- Reviewers are not blocked waiting
- Prior context accumulates
- The coordinator can handle timeouts/escalations
```

---

### Section: Team Composition Overall

**Type:** concern

**Comment:** The team now has 6 "lead" or "architect" role agents:

- architect (Opus)
- memory-architect (Sonnet)
- intelligence-lead (Sonnet)
- persistence-lead (Sonnet)
- team-mode-lead (Sonnet)
- improvement-analyst (Sonnet, effectively a "meta-lead")

This creates potential for authority conflicts. When memory-architect designs memory schemas, does persistence-lead have veto power over storage implementation? When improvement-analyst proposes team changes, does team-mode-lead have input on communication impacts?

**Suggested Change:** Document the authority hierarchy for overlapping domains:

```yaml
authority_hierarchy:
  memory_design:
    primary: memory-architect
    consulted: persistence-lead, intelligence-lead
    approver: cto
  storage_implementation:
    primary: persistence-lead
    consulted: memory-architect
    approver: cto
  team_composition:
    primary: improvement-analyst (proposals only)
    consulted: all leads
    approver: cto (changes), ceo (strategic changes)
```

---

## Approval Conditions

1. **Specify flywheel closure mechanisms** — The self-improvement loop must show how outputs feed inputs and how the system reduces friction over time. Without this, Pillar 5 is a feedback system, not a flywheel.

2. **Clarify improvement-analyst scope** — Either split the role or explicitly constrain it to analysis with proposal generation delegated to CTO.

3. **Document authority hierarchy for overlapping lead roles** — Prevent future coordination conflicts.

4. **Address architect's blocker** — The metadata.yaml race condition must have a specified resolution (lock file or append-only log).

---

## Note on Architect's Review

I concur with the architect's concerns on:
- Memory decay specification (suggestion)
- Meeting coordinator trigger mechanism (concern)
- REFORGE integration protocol (concern)
- Metadata race condition (blocker)

These should be addressed in the CTO's revision.