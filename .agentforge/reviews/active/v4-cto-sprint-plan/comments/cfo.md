# [cfo] Review of AgentForge v4 — CTO Sprint Plan
**Review Date:** 2026-03-26
**Verdict:** REQUEST_CHANGES

## Summary

The CTO's sprint plan demonstrates excellent cost discipline and strategic resource allocation. The decision to expand from 3 to 5 pillars while actually reducing Opus headcount (5→4) is financially sound. The $390 budget target appears achievable given the model tier optimizations, but I identify **3 critical budget concerns** that require specification before approval.

The plan correctly prioritizes cost-per-capability over absolute agent count. However, budget allocation methodology, cost tracking mechanisms, and ROI measurement frameworks are insufficiently detailed for a 20-week, 27-agent initiative.

The plan is **financially viable** but needs **budget governance details** to ensure we don't exceed targets.

## Comments

### Section: 1.2 What I Am Modifying — Model Tier Decisions

**Type:** approval

The CTO's model tier decisions are **financially excellent**:

| Decision | CFO Assessment | Cost Impact |
|----------|---------------|-------------|
| memory-architect: Opus→Sonnet | Correct. Design work front-loaded, minimal ongoing strategic decisions. | ~85% cost reduction for this agent |
| web-researcher: Haiku addition | Smart. Research delegation to cheapest tier. | Should pay for itself in 2-3 weeks |
| Maintain 4 Opus agents (not 6) | Disciplined. Strategic roles only. | Prevents $200+ weekly Opus overhead |

The **model mix shift** is cost-positive:
- **Before:** 5 Opus (25%) + 14 Sonnet (70%) + 1 Haiku (5%) = 20 agents
- **After:** 4 Opus (15%) + 21 Sonnet (78%) + 2 Haiku (7%) = 27 agents

More agents, but lower weighted cost per agent due to tier distribution.

---

### Section: 2.4 Model Distribution Analysis

**Type:** concern

**Comment:** The cost profile estimates are reasonable but **lack budget allocation methodology**. The plan states:

> Expected Token Share: Opus 5-10%, Sonnet 85-90%, Haiku 5%

However:
1. **What's the monthly token budget by tier?**
2. **How do we track against these percentages?**
3. **What happens if Opus usage exceeds 10%?**

**Suggested Change:** Add budget allocation table:

```yaml
v4_monthly_budget:
  total_usd: 65  # $390 / 6 months
  allocation:
    opus: $13 (20%)      # Strategic decisions only
    sonnet: $48 (74%)    # Implementation work
    haiku: $4 (6%)       # Research & utility
  tracking:
    weekly_reports: true
    alert_thresholds: 
      opus: 80%          # Alert at 80% of monthly budget
      sonnet: 90%
```

---

### Section: 2.2 New Agents for v4 — ROI Analysis

**Type:** suggestion

**Comment:** Each new agent should justify its cost through **measurable value delivery**. Current ROI reasoning:

| Agent | Monthly Cost Est. | Value Delivery | ROI Assessment |
|-------|------------------|----------------|----------------|
| dashboard-dev | ~$12 | Pillar 1 delivery | **Strong** - Core product capability |
| memory-architect | ~$8 | Pillar 2 design | **Strong** - Foundational system |
| tool-system-dev | ~$12 | Pillar 3 delivery | **Strong** - Core product capability |
| integration-dev | ~$10 | Cross-pillar integration | **Medium** - Could be absorbed by existing agents |
| meeting-coordinator | ~$8 | Pillar 4 delivery | **Strong** - CEO mandated capability |
| improvement-analyst | ~$8 | Pillar 5 delivery | **High** - Self-improving ROI over time |
| web-researcher | ~$2 | Delegation target | **Very High** - Saves other agents 50%+ research time |

**integration-dev** is the weakest ROI case - could existing agents handle cross-pillar work? 

**Suggested Change:** Document expected weekly task volume for integration-dev to justify dedicated agent vs. overflow work.

---

### Section: 3 Revised Sprint Plan — Budget Phasing

**Type:** concern

**Comment:** 20-week timeline with front-loaded agent onboarding creates **budget risk**. The plan shows:

- **Phase 1 (5 weeks):** All 6 new agents active
- **Phase 2-3 (15 weeks):** Full 27-agent team active

This creates **immediate budget impact** rather than gradual scaling.

**Financial Risk:** If Phase 1 agents exceed cost estimates, we're committed to 15 more weeks at the higher burn rate.

**Suggested Change:** Add **budget gates** between phases:

```
Phase 1 Budget Gate:
- Target: <$85 total spend (weeks 1-5)
- If exceeded by >20%: Pause Phase 2 for cost review
- Required: CFO approval before Phase 2 launch

Phase 2 Budget Gate: 
- Target: <$200 total spend (weeks 1-12)
- Required: CFO sign-off on final 8-week push
```

---

### Section: 3.6 Pillar 5 — Self-Improvement ROI

**Type:** approval with condition

**Comment:** Pillar 5 (Self-Improvement) has the highest potential ROI but also highest budget risk. improvement-analyst could:

**Positive ROI:**
- Identify underutilized agents → team optimization
- Suggest model tier downgrades → direct cost savings
- Optimize task routing → reduce total token consumption

**Negative ROI:**
- Generate excessive REFORGE proposals → team churn cost
- Over-optimize → reduced capability for small savings
- Analysis paralysis → cost without benefit

**Condition:** improvement-analyst must demonstrate **positive ROI within 8 weeks** or role gets consolidated into existing agents.

**Success Metrics:**
- Cost savings identified: >$20/month
- Productivity improvements: >10% task completion rate
- Team stability: <2 REFORGE executions/month

---

### Section: Overall Budget Feasibility — $390 Target

**Type:** blocker

**Comment:** $390 for 20 weeks (~$19.50/week) with 27 agents is **aggressive but achievable** given model tier discipline. However:

**Assumptions that must hold:**
1. Opus agents average <500 tokens/day each
2. Sonnet agents average <2,000 tokens/day each  
3. No major debugging sessions requiring Opus escalation
4. Research delegation to Haiku works as intended

**What's missing:** Contingency budget and cost escalation process.

**Required Addition:**

```yaml
budget_governance:
  target: $390 (20 weeks)
  contingency: $50 (13% buffer)
  escalation_process:
    week_8_review: "Assess trajectory, adjust if >110% of target"
    week_14_review: "Final budget adjustment opportunity"
    emergency_threshold: "130% of target = immediate scope reduction"
  cost_controls:
    daily_tracking: true
    agent_budgets: Individual limits per agent per week
    approval_required: Opus dispatches >$5/week per agent
```

## Approval Conditions (if REQUEST_CHANGES)

1. **Add budget allocation methodology** (Section 2.4 enhancement)
2. **Specify budget gate process** between phases with CFO approval checkpoints
3. **Define contingency budget and escalation process** for cost overruns
4. **Document ROI tracking for improvement-analyst** with 8-week success criteria

Once these financial governance details are added, the plan has **strong approval** from CFO perspective. The cost discipline is excellent and the $390 target is achievable with proper controls.