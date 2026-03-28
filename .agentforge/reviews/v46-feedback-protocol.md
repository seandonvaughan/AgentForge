# v4.6 Feedback & Review Protocol

## Purpose
Every agent invocation must produce a structured feedback record. This is not optional. Feedback is the fuel for the flywheel: it drives adaptive routing, agent mentorship, sprint retrospectives, and investor confidence.

---

## Feedback File Format

**Location:** `.agentforge/feedback/[YYYY-MM-DD]-[agent-name]-[task-slug].md`

**Required Fields:**

```markdown
---
agent: [agent-name]
date: [YYYY-MM-DD]
task: [brief task description]
sprint: [sprint version, e.g. v4.6]
model: [opus|sonnet|haiku]
duration_minutes: [estimated time]
status: [completed|partial|blocked|failed]
---

## What Worked
- [Specific things that went well]
- [Techniques or approaches that were effective]

## What Did Not Work
- [Specific failures or inefficiencies]
- [Root cause if known]

## Recommendations
- [Concrete, actionable suggestions for improvement]
- [Process changes, tool needs, or capability gaps identified]

## Blockers Encountered
- [Any blockers, with severity: low/medium/high/critical]

## Time & Cost Assessment
- Was this task appropriately scoped for my model tier? [yes/no + explanation]
- Could a lower-tier model have done this? [yes/no]
- Did I need capabilities I don't have? [yes/no + what]

## Rating (Self-Assessment)
- Quality of output: [1-5]
- Efficiency: [1-5]
- Would I do this differently next time? [yes/no + how]
```

---

## Who Must Write Feedback

| Agent Tier | When | Enforced By |
|-----------|------|------------|
| **Opus (Executive/Strategic)** | After every task, delegation, or decision | CEO review |
| **Sonnet (Implementation)** | After every sprint item or significant task | Engineering Manager review |
| **Haiku (Utility)** | After every 5th invocation (batched summary) | QA Manager review |

---

## Aggregation & Review Process

### Daily
- **feedback-analyst** scans all new feedback files
- Produces daily digest: `.agentforge/reviews/[date]-daily-digest.md`
- Flags: cost anomalies, recurring blockers, quality drops

### Per Sprint
- **project-manager** auto-generates sprint retrospective from all feedback
- Output: `.agentforge/reviews/[sprint]-retro.md`
- Includes: top 3 wins, top 3 issues, cost analysis, velocity trend

### Monthly
- **CEO** reviews aggregated feedback, makes strategic adjustments
- **CTO** reviews technical feedback, adjusts model routing
- **vp-research** reviews experiment feedback, updates research agenda

---

## Feedback-to-Action Pipeline

```
Agent writes feedback
    |
    v
feedback-analyst aggregates
    |
    v
Patterns detected? ----YES----> REFORGE proposal generated
    |                              |
    NO                             v
    |                        meta-architect reviews
    v                              |
Archive for retro              Auto-execute if approved
```

---

## Quality Standards

Feedback that fails these checks is rejected and the agent must rewrite:

1. **Specificity:** "It worked" is not acceptable. What specifically worked and why?
2. **Actionability:** Every recommendation must be concrete enough to create a task from.
3. **Honesty:** Admitting failure is valued more than hiding it. Hidden failures compound.
4. **Brevity with depth:** 200-500 words is the target range. Say what matters, cut the rest.

---

## Investment Signal

The investor reviews feedback quality as a leading indicator of team health. Consistently high-quality feedback across agents demonstrates:
- The team is self-aware
- Problems are caught early
- Improvements are systematic, not accidental
- The flywheel is turning

**Performance-based investment model:** Teams that produce better feedback get more resources. This is explicit and intentional.

---

## Implementation Timeline

| Item | Owner | Sprint Day |
|------|-------|-----------|
| FeedbackProtocol module (enforces schema) | architect | Day 1-2 |
| Daily digest automation | feedback-analyst | Day 2-3 |
| Sprint retro automation | project-manager | Day 3-4 |
| Dashboard feedback quality panel | dashboard-architect | Day 4-5 |
| Feedback-to-REFORGE pipeline | meta-architect | Day 5-7 |
| Full protocol active for all agents | coo (enforcement) | Day 7 |
