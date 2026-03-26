# [persistence-lead] Review of AgentForge v4 — CTO Sprint Plan
**Review Date:** 2026-03-26  
**Verdict:** REQUEST_CHANGES

## Summary

The CTO Sprint Plan demonstrates strong strategic direction and the storage approach is fundamentally sound. The decision to use JSON files with decay coefficients is appropriate for our scale, and the .agentforge directory structure provides good organization.

However, I identify **3 critical persistence concerns** that must be addressed before implementation. These focus on storage architecture, data migration, and system reliability—areas not fully covered by the architect's review. The plan lacks sufficient detail on how we transition from v3's storage patterns and doesn't address several concurrency and scalability challenges.

The persistence design is **75% complete**. The missing 25% involves migration strategy, file locking patterns, and storage performance characteristics that could cause significant implementation delays if not specified upfront.

## Comments

### Section: 1.1 What I Approve As-Is

**Type:** approval

The core storage decisions are excellent:
- **JSON files with decay**: Zero dependencies, human-readable, version-controllable
- **File-based organization**: Fits our existing .agentforge patterns
- **YAML manifests for tools**: Declarative and auditable

These choices maintain v3's operational simplicity while scaling appropriately.

### Section: 3.3 Pillar 2 (Agent Memory)

**Type:** concern

**Comment:** The memory storage design lacks critical implementation details:

**Missing Migration Strategy:**
The plan doesn't specify how existing v3 memory files transition to the new decay-based format. Current v3 stores memories in `.agentforge/memory/` as plain JSON. The new format requires:
```json
{
  "content": "...",
  "relevance": 0.95,
  "created_at": "2026-03-25T10:00:00Z",
  "last_accessed": "2026-03-25T15:30:00Z",
  "pinned": false
}
```

**Missing Specification:** Add migration script specifications and backward compatibility rules.

**File Naming Conventions:**
The plan doesn't specify how memory files are named or organized within `.agentforge/memory/`. This affects:
- Agent-specific vs. shared memories
- Search performance
- File system limits

**Suggested Schema:**
```
.agentforge/memory/
├── agents/
│   ├── {agent-name}/
│   │   ├── {timestamp}-{hash}.json
│   └── shared/
│       ├── {timestamp}-{hash}.json
├── archive/
│   └── {year}/{month}/
└── index.json  # Fast lookup cache
```

### Section: 3.5 Pillar 4 (Agent Meetings)

**Type:** blocker

**Comment:** Beyond the architect's race condition concern about metadata.yaml, there are **deeper concurrency issues** in the review storage design:

**Directory-Level Race Conditions:**
Multiple agents can simultaneously:
1. Create new review directories in `.agentforge/reviews/active/`
2. Move completed reviews to `.agentforge/reviews/completed/`
3. Archive old reviews

This creates potential for:
- Duplicate directory names
- Incomplete moves leaving orphaned files
- Index corruption

**File System Performance:**
The plan doesn't address what happens when `.agentforge/reviews/` contains hundreds of review directories. File system performance degrades as directory size grows.

**Suggested Solution:**
```yaml
locking_strategy: "atomic_operations"
directory_structure:
  active: ".agentforge/reviews/active/{year}/{month}/"
  completed: ".agentforge/reviews/completed/{year}/{month}/"
  max_per_directory: 100
atomic_operations:
  - review_creation: "mkdir + metadata write in single operation"
  - review_completion: "atomic mv between directories"
  - cleanup: "background process with exclusive locks"
```

### Section: 4.2 Review Metadata Schema

**Type:** concern  

**Comment:** The metadata.yaml design has storage inefficiencies beyond the architect's concurrency concerns:

**Metadata Growth:**
Each review cycle appends to the reviewers array. Over time, this creates files with hundreds of entries. YAML parsing becomes slow and memory-intensive.

**Missing Audit Trail:**
The current schema only stores final verdicts. There's no audit trail of when decisions changed, who modified what, or why reviews were restarted.

**Suggested Enhancement:**
Split into two files:
- `metadata.yaml` (current state only)
- `audit.jsonl` (append-only event log)

```jsonl
{"timestamp":"2026-03-26T10:00:00Z","event":"review_started","agent":"architect","reviewer":"system"}
{"timestamp":"2026-03-26T10:15:00Z","event":"verdict_submitted","agent":"architect","verdict":"request_changes"}
```

### Section: 3.6 Pillar 5 (Self-Improvement)

**Type:** suggestion

**Comment:** The REFORGE proposal storage needs versioning and rollback capability:

**Missing Rollback Design:**
The plan mentions logging REFORGE changes but doesn't specify rollback mechanisms. When self-improvement goes wrong, we need immediate recovery.

**Suggested Addition:**
```yaml
reforge_storage:
  proposals: ".agentforge/reforge/proposals/{id}/"
  history: ".agentforge/reforge/history/{execution-id}/"
  snapshots: ".agentforge/reforge/snapshots/{pre,post}-{id}.tar.gz"
  rollback: "atomic restore from snapshot + team.yaml replacement"
```

### Section: Storage Performance (Missing Section)

**Type:** concern

**Comment:** The plan doesn't address storage performance characteristics. Several design decisions have scaling implications:

**JSON File Count:**
With 27 agents generating memories, tool manifests, and review files, we could reach thousands of JSON files within months. File system performance varies significantly:
- **ext4/APFS**: Degrades after 10K files per directory
- **ZFS/BTRFS**: Better scaling but still not infinite

**I/O Concurrency:**
Multiple agents reading/writing simultaneously can cause:
- Lock contention on shared files
- I/O saturation on spinning disks  
- Inconsistent read-your-own-writes semantics

**Suggested Monitoring:**
Add storage performance metrics to Pillar 5's improvement analytics:
- File count per directory
- Average file read/write latency
- Lock contention frequency
- Directory scan times

## Approval Conditions

1. **Migration Strategy:** Specify how v3 memory files convert to v4 format with backward compatibility
2. **Concurrency Design:** Add comprehensive locking strategy for all shared resources beyond metadata.yaml  
3. **Storage Scaling:** Define directory organization limits and performance monitoring
4. **Rollback Mechanism:** Specify REFORGE rollback procedures with snapshot storage

These are implementation-critical details that prevent storage-related delays during development. The architecture is sound, but the execution specifications need completion.