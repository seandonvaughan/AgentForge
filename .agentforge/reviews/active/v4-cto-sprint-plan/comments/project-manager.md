# [project-manager] Review of AgentForge v4 — CTO Sprint Plan
**Review Date:** 2026-03-26
**Verdict:** REQUEST_CHANGES

## Summary

The CTO's sprint plan demonstrates strong strategic vision and correctly addresses the CEO's 5-pillar mandate. The 20-week timeline and team expansion are appropriately scaled for the increased scope. However, from a project execution perspective, I identify **critical dependency risks** and **resource coordination gaps** that will likely cause delays and conflicts during implementation.

The plan is fundamentally sound but lacks the operational detail needed for successful execution. The sprint sequencing creates unnecessary dependencies, and the resource allocation model has several coordination blind spots that could derail progress.

## Comments

### Section: 3.1 Phase Overview
**Type:** concern

The Phase 1 approach of running all 5 pillar foundations in parallel (Sprint 1.1-1.5) creates **excessive coordination overhead** for the first phase. Each sprint is only 1 week, and all 5 foundation sprints depend on shared infrastructure decisions that haven't been made.

**Specific conflicts:**
- Dashboard server scaffold (P1) and Tool registry core (P3) both need to define API patterns
- Memory store core (P2) and Meeting protocol foundation (P4) both touch the same `.agentforge/` directory structure
- All 5 pillars need integration points that aren't defined until Phase 2

**Suggested Change:** Restructure Phase 1 with sequential foundation sprints:
- Week 1-2: Infrastructure decisions + Dashboard server
- Week 3: Memory store core (depends on directory structure)  
- Week 4: Tool registry core (depends on API patterns)
- Week 5: Meeting + Improvement foundations (depend on storage patterns)

### Section: 2.5 Pillar Ownership Matrix
**Type:** blocker

**Missing Coordination Model:** The ownership matrix shows single owners but doesn't address how **integration-dev** coordinates with all 5 pillars. Integration-dev is listed as contributing to P1-P3 but the **Integration API design** work (Section 3.2, Sprint 2.1) happens in Week 6—after all foundation work is supposedly complete.

This is a **critical path dependency** that will block everything. Integration-dev needs to define the pillar interfaces before foundation work begins, not after.

**Suggested Change:** Move Integration API design to Phase 1, Week 1. All other foundation sprints depend on this architectural decision.

### Section: 3.4 Pillar 3 (Agent Tools)  
**Type:** concern

**Resource Conflict:** tool-system-dev, api-specialist, and coder are all assigned to tool-related work, but the sprint timeline shows overlapping responsibilities:

- Sprint 2.3 (Week 8): tool-system-dev builds "Tool Registry + Provisioner"
- Sprint 3.2 (Week 12): api-specialist does "MCP Connector Implementation"  
- Sprint 3.4 (Week 14): coder does "Tool Testing Framework"

The tool registry can't be built without knowing the MCP connector interface. This creates a **4-week dependency gap** where tool-system-dev is blocked waiting for api-specialist.

**Suggested Change:** Either sequence these sprints properly (registry → connector → testing) or define the MCP interface as part of Phase 1 foundation work.

### Section: 3.5 Pillar 4 (Agent Meetings)
**Type:** suggestion

**Sprint Scope Concern:** Sprint 2.4 (Week 9) assigns meeting-coordinator to build "Document Review Workflow + Meeting Orchestration" in a single 1-week sprint. This includes:
- File monitoring system
- Review assignment logic
- Status tracking
- Meeting coordination
- Integration with all 5 pillars

This is **severely under-scoped**. A single agent building a cross-cutting system that touches all pillars needs at least 2-3 weeks, especially given the metadata race condition concerns raised by the architect.

**Suggested Change:** Split into 2 sprints:
- Sprint 2.4a: Document Review Workflow (storage, metadata, basic tracking)
- Sprint 2.4b: Meeting Orchestration (coordination logic, pillar integration)

### Section: 4.1 Review Protocol Architecture
**Type:** approval

The review protocol design is excellent and addresses a real operational need. The structured review chain with role-specific focus areas will catch issues early and ensure quality.

**Strength:** The integration with AgentForge's team structure (reviewers are actual team agents) creates natural ownership and accountability.

### Section: 6.1 Success Metrics
**Type:** concern

**Missing Dependency Tracking:** The success metrics focus on feature completion (1,500+ tests) but don't track the **cross-pillar integration health** that will determine actual v4 success.

**Missing metrics:**
- Cross-pillar API compatibility
- Integration test coverage between pillars
- Shared resource conflict resolution
- Agent coordination efficiency

**Suggested Change:** Add integration-focused metrics:
- Target: 90% cross-pillar integration test coverage
- Target: <2 days average resolution time for cross-pillar issues
- Target: Zero shared resource conflicts in production

### Section: 7.2 Budget Breakdown
**Type:** approval

The $390 budget allocation is realistic and appropriately accounts for the Opus/Sonnet cost ratio. The 85-90% Sonnet allocation aligns with the cost-first principle while preserving strategic Opus capacity.

## Approval Conditions

1. **Restructure Phase 1** to sequence foundation sprints and eliminate coordination conflicts
2. **Move Integration API design** to Phase 1, Week 1 as a prerequisite for all other work
3. **Fix Pillar 3 sprint dependencies** by sequencing tool registry → MCP connector → testing framework
4. **Split Pillar 4 Sprint 2.4** into two properly-scoped sprints
5. **Add integration health metrics** to success criteria

These changes will add approximately 2 weeks to the timeline but will prevent much larger delays from dependency conflicts and coordination failures.