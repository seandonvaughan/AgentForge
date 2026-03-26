# v4 Dogfood Sprint Plan — "Eat Our Own Cooking"

**Issued by:** CTO
**Date:** 2026-03-26
**Objective:** Exercise every v4 subsystem with real team workload. Collect feedback from all 21 agents for v4.1 planning.

---

## New Hires (4 agents)

| Agent | Model | Purpose |
|-------|-------|---------|
| bus-integration-tester | Sonnet | Validate V4MessageBus under real load |
| memory-stress-tester | Sonnet | Stress-test memory registry, search, MCP, governor |
| flywheel-validator | Sonnet | Validate all 4 flywheel components compound |
| session-resilience-tester | Haiku | Test session persist/resume/crash recovery |

---

## Parallel Task Assignments

All tasks run in parallel. Each agent writes feedback to `.agentforge/feedback/`.

### Phase A — V4 Subsystem Validation (New Hires)

| Agent | V4 Feature Exercised | Task |
|-------|---------------------|------|
| **bus-integration-tester** | V4MessageBus, ReviewRouter, MeetingCoordinator | Publish across all 18 standard topics, test wildcard routing, priority delivery, TTL expiry, 1000-msg throughput |
| **memory-stress-tester** | MemoryRegistry, SemanticSearch, MCPMemoryProvider, StorageGovernor | Store 500+ entries, semantic search accuracy >90%, decay/expiry, LRU eviction, MCP round-trip |
| **flywheel-validator** | MetaLearningEngine, AutonomyGovernor, CapabilityInheritance, FlywheelMonitor | 50+ task outcomes, promotions/demotions, skill propagation, velocity ratio >1.05 |
| **session-resilience-tester** | V4SessionManager | Persist/resume 5 cycles, context threading, timeout policies, cleanup, serialization |

### Phase B — Existing Team Dogfooding (Parallel)

| Agent | Model | V4 Feature Exercised | Task |
|-------|-------|---------------------|------|
| **architect** | Opus | OrgGraph, DelegationProtocol | Validate the 21-agent org DAG — add new hires, test ancestor authority, canDelegateTo, cycle detection. Write architectural feedback on org-graph API ergonomics. |
| **coder** | Sonnet | All v4 modules, barrel exports | Add barrel exports (`src/communication/index.ts`, `src/flywheel/index.ts`, `src/memory/index.ts`, `src/session/index.ts`, `src/api/index.ts`) for all v4 modules. Report any import/type issues. |
| **api-specialist** | Sonnet | APIStabilityAuditor | Register all 20 v4 public classes in the auditor. Classify each as stable/beta/experimental. Run breaking-change detection against a simulated v3 baseline. Write deprecation policy. |
| **team-reviewer** | Sonnet | ReviewRouter, V4MessageBus | Submit 3 documents for review through ReviewRouter. Exercise the full 6-state lifecycle. Verify all transitions emit bus events. Report on review UX. |
| **debugger** | Sonnet | SemanticSearch, MemoryRegistry | Investigate the bag-of-words cosine similarity — test queries where keyword overlap is low but semantic intent is high. Report false negatives. Recommend embedding-based search for v4.1. |
| **project-manager** | Sonnet | MeetingCoordinator, ChannelManager | Schedule 5 meetings across priority types. Test concurrency limit (3). Use ChannelManager to post meeting notes. Test escalation for overdue queued meetings. |
| **coo** | Sonnet | ExecAssistant, ChannelManager | Set up CEO inbox channel. Post 20 mixed-priority messages. Run ExecAssistant triage. Verify 80%+ noise reduction. Report on classification accuracy. |
| **cfo** | Sonnet | StorageGovernor, cost tracking | Audit storage governor quotas across all agents. Set per-agent quotas. Simulate a greedy agent exceeding quota. Report cost implications of memory growth. |
| **dba** | Sonnet | MemoryRegistry, schema validation | Validate all MemoryRegistryEntry fields for schema completeness. Test edge cases: empty tags, null expiresAt, zero decay rate. Report on schema gaps. |
| **skill-designer** | Sonnet | CapabilityInheritance | Design 5 new skills for the team. Register them. Test propagation from senior to junior agents. Verify opt-in/opt-out. Report on skill taxonomy. |
| **template-optimizer** | Sonnet | V4ReforgeEngine | Submit 3 reforge proposals for agent prompt improvements. Run through guardrail pipeline. Test apply + verify + rollback. Report on guardrail coverage. |
| **meta-architect** | Opus | All v4 systems | Cross-cutting review of all v4 modules for consistency. Check naming conventions, error message patterns, immutability enforcement. Write architecture quality report. |
| **linter** | Haiku | All v4 source files | Lint all 20 v4 source files for style consistency. Check export patterns, consistent error classes, JSDoc coverage on public APIs. |
| **researcher** | Haiku | SemanticSearch, MCPMemoryProvider | Research best practices for semantic search in agent systems. Store findings via MCP. Test retrieval quality. Compare our bag-of-words approach to embedding-based alternatives. |
| **genesis** | Opus | Full pipeline | Run a fresh genesis on the project with v4 active. Verify it detects v4 subsystems. Confirm team.yaml includes v4 metadata. Test --yes flag. |
| **ceo** | Opus | ExecAssistant, FlywheelMonitor | Review flywheel health dashboard. Evaluate whether the flywheel is producing real business value. Provide strategic direction for v4.1. |

---

## Feedback Collection

Every agent writes to `.agentforge/feedback/2026-03-26-{agent-name}-v4-dogfood.md` with:

```yaml
---
agent: {name}
date: 2026-03-26
v4_features_tested: [list]
verdict: pass | partial | fail
---

## What Worked
...

## What Didn't Work
...

## v4.1 Recommendations
...

## Edge Cases Found
...
```

---

## v4.1 Planning Gate

After all feedback is collected:
1. **CTO** synthesizes all feedback into `docs/v4/v4.1-roadmap.md`
2. **Architect** designs solutions for top-priority issues
3. **CEO** approves the v4.1 scope

**Target:** Every v4 subsystem exercised by ≥2 agents. Zero untested features.

---

## V4 Feature Coverage Matrix

| V4 Feature | Tested By |
|-----------|-----------|
| OrgGraph | architect, meta-architect |
| DelegationProtocol | architect, cto |
| RoleRegistry | architect, skill-designer |
| AccountabilityTracker | project-manager, cto |
| V4MessageBus | bus-integration-tester, team-reviewer, coo |
| ReviewRouter | team-reviewer, bus-integration-tester |
| MeetingCoordinator | project-manager, bus-integration-tester |
| ChannelManager | project-manager, coo |
| ExecAssistant | coo, ceo |
| MemoryRegistry | memory-stress-tester, dba, debugger |
| StorageGovernor | memory-stress-tester, cfo |
| MCPMemoryProvider | memory-stress-tester, researcher |
| SemanticSearch | memory-stress-tester, debugger, researcher |
| V4SessionManager | session-resilience-tester, genesis |
| V4ReforgeEngine | template-optimizer, flywheel-validator |
| APIStabilityAuditor | api-specialist, meta-architect |
| MetaLearningEngine | flywheel-validator, ceo |
| CapabilityInheritance | flywheel-validator, skill-designer |
| AutonomyGovernor | flywheel-validator, ceo |
| FlywheelMonitor | flywheel-validator, ceo |

**Coverage: 20/20 features — each tested by ≥2 agents.**
