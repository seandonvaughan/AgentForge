---
id: prop-refine-tdd-2024-01
action: refine
targetSkillId: agentforge:test-driven-development
skillId: agentforge:test-driven-development
capabilityTag: test-driven-development
clusterId: cluster-quality-0
requiresTools:
  - Bash
  - Edit
occurrences: 14
status: proposed
createdAt: "2024-01-15T10:00:00Z"
---

## Proposal: Refine TDD skill to cover vitest snapshot testing

Cluster analysis of the last 5 cycles shows 14 agent sessions where the TDD skill was invoked but agents still needed to look up vitest snapshot APIs manually. This refinement adds a dedicated snapshot testing section to reduce lookup friction.

### Diff summary

Add a new section "Snapshot testing with vitest" covering:

- `expect(x).toMatchInlineSnapshot()` for small outputs
- `expect(x).toMatchSnapshot()` for larger outputs
- How to update snapshots with `--update-snapshots`
- When to prefer snapshots vs explicit assertions

### Expected impact

Reduce snapshot-related lookup sessions from 14 → ~2 per cycle.
