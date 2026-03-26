---
description: View org graph, delegation authority, and RACI accountability
argument-hint: Optional subcommand — graph | delegate | raci | roles
---

# AgentForge Org

Inspect the V4 organizational structure — the DAG that governs delegation authority, peer relationships, and accountability.

## Subcommands

- `graph` — Display the org graph as a tree showing supervisor → report relationships
- `delegate --from <agent> --to <agent> --task <description>` — Issue a delegation (checks ancestor authority + canDelegateTo)
- `raci` — Generate RACI matrix for active tasks
- `roles` — List all role assignments with audit log

## What to Do

1. Import `OrgGraph` from `src/org-graph/org-graph.ts`
2. Import `DelegationProtocol` from `src/org-graph/delegation-protocol.ts`
3. Import `RoleRegistry` from `src/registry/role-registry.ts`
4. Import `AccountabilityTracker` from `src/registry/accountability-tracker.ts`

### graph
Build the OrgGraph from `.agentforge/team.yaml` delegation_graph. Display as:
```
ceo (Strategic, Tier 4)
├── cto (Strategic, Tier 3)
│   └── architect (Implementation, Tier 2)
│       └── coder (Implementation, Tier 1)
├── coo (Implementation, Tier 2)
└── cfo (Implementation, Tier 2)
```

Show: root node, total agents, max depth, peer groups.

### delegate
Call `protocol.delegate()` — validates authority via org graph (ancestor check OR canDelegateTo list). Shows the `DelegationContext` envelope: businessRationale, constraints, acceptableTradeoffs.

### raci
Call `tracker.generateRaciMatrix()` — for each active task, show:
- **R** (Responsible) — who does the work
- **A** (Accountable) — exactly one agent (enforced)
- **C** (Consulted) — agents providing input
- **I** (Informed) — agents kept in the loop

### roles
Call `registry.listRoles()` — display all role assignments. Use `registry.getAuditLog()` to show assignment/reassignment/deactivation history.
