# Universal Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parallelization guidance:** Tasks marked `[PARALLEL]` are independent and should be dispatched as concurrent subagents. Tasks marked `[SEQUENTIAL]` depend on prior tasks. Use Haiku-model agents for mechanical file moves and YAML creation, Sonnet for implementation logic, and Opus only for architectural decisions requiring deep reasoning.

**Goal:** Expand AgentForge from a software-only agent team builder into a universal platform supporting 9 domain packs, a Genesis agent workflow, collaboration templates, structured skills, runtime orchestration with progress ledger/loop prevention/broadcast events, and 64 unique agents.

**Architecture:** Four-layer system — Core (universal agents + skills) → Domain Packs (modular agent/skill/scanner bundles) → Collaboration Engine (topology templates + runtime orchestration) → Genesis (adaptive idea-to-team workflow). Backward compatible with v1.

**Tech Stack:** TypeScript/Node.js, YAML (agent configs), JSON (analysis output), Commander.js (CLI), Anthropic SDK (multi-model dispatch), vitest (testing).

**Spec:** `docs/superpowers/specs/2026-03-25-universal-forge-design.md`

---

## Phase A: Restructure (Foundation)

All v2 work builds on this. Move existing templates into domain structure, add new types, create core domain.

### Task A1: Add v2 Types [SEQUENTIAL — must complete before all other tasks]

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/types/team.ts`
- Modify: `src/types/analysis.ts`
- Create: `src/types/domain.ts`
- Create: `src/types/collaboration.ts`
- Create: `src/types/orchestration.ts`
- Create: `src/types/skill.ts`
- Create: `src/types/scanner.ts`
- Modify: `src/types/index.ts`
- Test: `tests/types/domain.test.ts`

- [ ] **Step 1: Write type validation tests**

```typescript
// tests/types/domain.test.ts
import { describe, it, expect } from 'vitest';
import type { DomainPack, DomainScanner, ActivationRule } from '../src/types/domain.js';
import type { CollaborationTemplate, TopologyDefinition, LoopLimits } from '../src/types/collaboration.js';
import type { ProgressLedger, TeamEvent, Handoff } from '../src/types/orchestration.js';
import type { Skill, SkillCategory } from '../src/types/skill.js';

describe('v2 types compile correctly', () => {
  it('DomainPack accepts valid data', () => {
    const pack: DomainPack = {
      name: 'software',
      version: '1.0',
      description: 'Software domain',
      scanner: { type: 'codebase', activates_when: [], scanners: ['file-scanner'] },
      agents: { strategic: ['architect'], implementation: ['coder'], quality: [], utility: [] },
      default_collaboration: 'dev-team',
      signals: ['codebase_present'],
    };
    expect(pack.name).toBe('software');
  });
  // ... more type validation tests for each new interface
});
```

- [ ] **Step 2: Run test to verify it fails** (types don't exist yet)

Run: `npx vitest run tests/types/domain.test.ts`
Expected: FAIL — cannot resolve modules

- [ ] **Step 3: Create `src/types/domain.ts`**

Add types from spec Section 7.2: `DomainId`, `DomainPack`, `DomainScanner`, `ActivationRule`.

- [ ] **Step 4: Create `src/types/collaboration.ts`**

Add types from spec Section 7.2: `CollaborationTemplate`, `TopologyDefinition`, `DelegationRules`, `CommunicationConfig`, `GateDefinition`, `EscalationConfig`, `LoopLimits`, `CrossDomainTeam`, `DomainTeam`, `Bridge`.

- [ ] **Step 5: Create `src/types/orchestration.ts`**

Add types from spec Section 7.2 and Section 11: `ProgressLedger`, `TeamEvent`, `Handoff`, `DelegationPrimitives` (delegate_work, ask_coworker).

- [ ] **Step 5b: Create `src/types/scanner.ts`**

Add types from spec Section 8.4: `DomainScannerPlugin`, `ScanOutput`.

- [ ] **Step 6: Create `src/types/skill.ts`**

Add types from spec Section 7.2: `Skill`, `SkillCategory`, `SkillParameter`.

- [ ] **Step 7: Update `src/types/agent.ts`**

Add optional fields to `AgentTemplate`: `domain?: DomainId`, `iron_laws?: string[]`, `gates?: { pre: string[]; post: string[] }`, `subscriptions?: string[]`. Keep all new fields optional for backward compatibility.

- [ ] **Step 8: Update `src/types/team.ts`**

Add optional fields to `TeamManifest`: `project_brief?: ProjectBrief`, `domains?: DomainId[]`, `collaboration?: CollaborationTemplate`. Add index signature to `TeamAgents`: `[category: string]: string[]`.

- [ ] **Step 9: Update `src/types/analysis.ts`**

Add `ProjectBrief`, `DocumentAnalysis`, `ResearchFindings`, `IntegrationRef` interfaces alongside existing `ProjectAssessment`.

- [ ] **Step 10: Update `src/types/index.ts`**

Add barrel exports for new modules: domain, collaboration, orchestration, skill.

- [ ] **Step 11: Run tests to verify pass**

Run: `npx vitest run tests/types/ && npx tsc --noEmit`
Expected: All tests pass, clean compile

- [ ] **Step 12: Commit**

```bash
git add src/types/ tests/types/
git commit -m "feat: add v2 type system — domains, collaboration, orchestration, skills"
```

---

### Task A2: Restructure Templates into Domain Packs [PARALLEL after A1]

**Files:**
- Move: `templates/agents/*.yaml` → `templates/domains/software/agents/`
- Create: `templates/domains/software/domain.yaml`
- Create: `templates/domains/core/domain.yaml`
- Create: `templates/domains/core/agents/genesis.yaml`
- Create: `templates/domains/core/agents/project-manager.yaml`
- Create: `templates/domains/core/agents/meta-architect.yaml`
- Update: `src/builder/template-loader.ts` (new paths)

- [ ] **Step 1: Create domain directory structure**

```bash
mkdir -p templates/domains/{core,software,business,marketing,product,research,sales,legal,hr,it}/{agents,skills,collaboration}
```

- [ ] **Step 2: Move existing software agent templates**

```bash
mv templates/agents/*.yaml templates/domains/software/agents/
rmdir templates/agents
```

- [ ] **Step 3: Create `templates/domains/software/domain.yaml`**

Use the software domain.yaml from spec Section 2.3 — scanner type `codebase`, activation rules for source files, agent roster, signals.

- [ ] **Step 4: Create `templates/domains/core/domain.yaml`**

```yaml
name: core
version: "1.0"
description: >
  Universal core domain — agents and skills available to every team.
scanner:
  type: "hybrid"
  activates_when: []  # Always active
  scanners:
    - document-analyzer
    - integration-detector
    - web-researcher
agents:
  strategic: [genesis, meta-architect]
  utility: [project-manager, researcher, file-reader]
default_collaboration: flat
signals: []  # Always active
```

- [ ] **Step 5: Create core agent templates**

Create `templates/domains/core/agents/genesis.yaml` — Opus model, adaptive workflow orchestrator, system prompt with interview/analysis/research phases.

Create `templates/domains/core/agents/project-manager.yaml` — Sonnet model, cross-domain coordinator, system prompt focused on timeline/status/resource tracking.

Create `templates/domains/core/agents/meta-architect.yaml` — Opus model, custom agent creator, system prompt that generates new YAML agent templates based on detected project needs.

Move `researcher.yaml` and `file-reader.yaml` from `templates/domains/software/agents/` to `templates/domains/core/agents/` (they're universal).

- [ ] **Step 6: Update `src/builder/template-loader.ts`**

Add `loadDomainTemplates(domainsDir: string): Promise<Map<DomainId, Map<string, AgentTemplate>>>` that reads the new `templates/domains/*/agents/` structure. Update `getDefaultTemplatesDir()` to return `templates/domains/`. Keep `loadAllTemplates()` working for backward compatibility.

- [ ] **Step 7: Update template-loader tests**

Update `tests/builder/template-loader.test.ts` to test the new domain-based loading alongside existing tests.

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All 143+ tests pass, clean compile

- [ ] **Step 9: Commit**

```bash
git add templates/ src/builder/template-loader.ts tests/builder/
git commit -m "feat: restructure templates into domain pack directories"
```

---

### Task A3: Domain Pack Loader [PARALLEL after A1]

**Files:**
- Create: `src/domains/domain-loader.ts`
- Create: `src/domains/domain-activator.ts`
- Create: `src/domains/index.ts`
- Test: `tests/domains/domain-loader.test.ts`
- Test: `tests/domains/domain-activator.test.ts`

- [ ] **Step 1: Write domain-loader tests**

Test `loadDomainPack(domainDir)` — reads domain.yaml, validates against DomainPack interface, returns typed result. Test with mock domain directory containing valid domain.yaml. Test error handling for missing/malformed files.

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run tests/domains/domain-loader.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/domains/domain-loader.ts`**

`loadDomainPack(domainDir: string): Promise<DomainPack>` — reads and validates domain.yaml.
`loadAllDomains(domainsDir: string): Promise<Map<DomainId, DomainPack>>` — loads all domain packs.
`getDefaultDomainsDir(): string` — returns `templates/domains/`.

- [ ] **Step 4: Run test to verify pass**

- [ ] **Step 5: Write domain-activator tests**

Test `activateDomains(scanResult, availableDomains)` — given a FullScanResult and the map of all domain packs, returns which domains should activate based on signal matching. Test: software activates when source files found, core always activates, business activates when document files found.

- [ ] **Step 6: Implement `src/domains/domain-activator.ts`**

`activateDomains(scanResult: FullScanResult, domains: Map<DomainId, DomainPack>): DomainId[]` — checks each domain's `activates_when` rules against the scan. Core always activates. Returns sorted list of active domain IDs.

- [ ] **Step 7: Run tests, create barrel export, commit**

Create `src/domains/index.ts` with barrel exports.

Run: `npx vitest run tests/domains/ && npx tsc --noEmit`

```bash
git add src/domains/ tests/domains/
git commit -m "feat: add domain pack loader and activation system"
```

---

### Task A4: Update Builder for Domain Awareness [SEQUENTIAL after A2, A3]

**Files:**
- Modify: `src/builder/team-composer.ts`
- Modify: `src/builder/index.ts`
- Modify: `tests/builder/team-composer.test.ts`

- [ ] **Step 1: Update team-composer tests**

Add tests for domain-aware composition: `composeTeamFromDomains(scan, activeDomains, domainPacks)` should merge agents from all active domains plus core.

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Update `src/builder/team-composer.ts`**

Add `composeTeamFromDomains(scan: FullScanResult, activeDomains: DomainId[], domainPacks: Map<DomainId, DomainPack>): TeamComposition` — merges agent rosters from all active domain packs, applies conditional logic per domain, deduplicates utility agents. Keep existing `composeTeam()` as a wrapper that calls the new function with software domain only.

- [ ] **Step 4: Update `src/builder/index.ts`**

Update `forgeTeam()` to use domain-aware pipeline: load domains → activate → compose from domains → customize → write.

- [ ] **Step 5: Run full test suite, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/builder/ tests/builder/
git commit -m "feat: update builder for multi-domain team composition"
```

---

## Phase D: Collaboration Engine + Runtime Orchestration

These are the core systems that make agents work together effectively.

### Task D1: Collaboration Template System [PARALLEL after A1]

**Files:**
- Create: `src/collaboration/template-loader.ts`
- Create: `src/collaboration/topology-selector.ts`
- Create: `src/collaboration/bridge-builder.ts`
- Create: `src/collaboration/index.ts`
- Create: `templates/domains/software/collaboration/dev-team.yaml`
- Create: `templates/domains/core/collaboration/flat.yaml`
- Test: `tests/collaboration/topology-selector.test.ts`
- Test: `tests/collaboration/bridge-builder.test.ts`

- [ ] **Step 1: Create collaboration template YAML files**

Create `templates/domains/software/collaboration/dev-team.yaml` using the schema from spec Section 4.2 — hierarchy topology, delegation rules, communication gates, escalation config, loop limits.

Create `templates/domains/core/collaboration/flat.yaml` — flat topology, peer delegation, no root.

- [ ] **Step 2: Write topology-selector tests**

Test `selectTopology(projectBrief, activeDomains)` returns:
- `flat` for single domain with <= 5 agents
- `hierarchy` for single domain with > 5 agents
- `hub-and-spoke` for multiple domains
- `matrix` for cross-functional with dual reporting signals

- [ ] **Step 3: Implement `src/collaboration/topology-selector.ts`**

`selectTopology(brief: ProjectBrief, domains: DomainId[], agentCount: number): CollaborationTemplate['type']` — implements the heuristic table from spec Section 4.1.

- [ ] **Step 4: Write bridge-builder tests**

Test `buildBridges(teams, delegationGraph)` — when software and marketing domains are active, creates bridges between Architect↔CMO, PM↔all leads.

- [ ] **Step 5: Implement `src/collaboration/bridge-builder.ts`**

`buildBridges(domainTeams: Record<DomainId, DomainTeam>, delegationGraph: DelegationGraph): Bridge[]` — identifies cross-domain connection points (strategic agents that share concerns) and creates explicit bridges.

`mergeTopology(domainTeams: Record<DomainId, DomainTeam>, bridges: Bridge[], coordinator: string): CrossDomainTeam` — combines domain teams with bridges into a unified cross-domain topology.

- [ ] **Step 6: Create template-loader and barrel export**

`src/collaboration/template-loader.ts` — loads collaboration YAML files.
`src/collaboration/index.ts` — barrel export.

- [ ] **Step 7: Run tests, commit**

Run: `npx vitest run tests/collaboration/ && npx tsc --noEmit`

```bash
git add src/collaboration/ tests/collaboration/ templates/domains/*/collaboration/
git commit -m "feat: add collaboration template system with topology selection and bridge building"
```

---

### Task D2: Progress Ledger [PARALLEL after A1]

**Files:**
- Create: `src/orchestrator/progress-ledger.ts`
- Test: `tests/orchestrator/progress-ledger.test.ts`

- [ ] **Step 1: Write progress-ledger tests**

Test `ProgressLedgerManager`:
- `create(taskId, objective)` initializes with empty facts and plan
- `recordStep(step)` adds to steps_completed
- `checkHealth()` returns `{ is_in_loop, is_progress_being_made, is_request_satisfied }`
- Loop detection: same action repeated 3 times → `is_in_loop = true`
- Stall detection: no new steps completed in 3 consecutive checks → `is_progress_being_made = false`
- `shouldEscalate()` returns true when `is_in_loop` or `!is_progress_being_made` for 3 checks

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run tests/orchestrator/progress-ledger.test.ts`

- [ ] **Step 3: Implement `src/orchestrator/progress-ledger.ts`**

```typescript
export class ProgressLedgerManager {
  private ledger: ProgressLedger;
  private healthHistory: { in_loop: boolean; progressing: boolean }[] = [];

  constructor(taskId: string, objective: string) { ... }

  recordStep(step: string): void { ... }
  recordFact(category: keyof ProgressLedger['facts'], fact: string): void { ... }
  updatePlan(plan: string[]): void { ... }
  setNextSpeaker(agent: string, instruction: string): void { ... }

  checkHealth(): { is_in_loop: boolean; is_progress_being_made: boolean } {
    // Loop detection: check if last 3 steps are identical
    // Progress detection: check if steps_completed grew since last check
  }

  shouldEscalate(): boolean {
    // True if health checks have been bad for 3 consecutive checks
  }

  getLedger(): ProgressLedger { return { ...this.ledger }; }
}
```

- [ ] **Step 4: Run test to verify pass, commit**

Run: `npx vitest run tests/orchestrator/progress-ledger.test.ts`

```bash
git add src/orchestrator/progress-ledger.ts tests/orchestrator/progress-ledger.test.ts
git commit -m "feat: add progress ledger with stall and loop detection"
```

---

### Task D3: Delegation Primitives [PARALLEL after A1]

**Files:**
- Modify: `src/orchestrator/delegation-manager.ts`
- Modify: `tests/orchestrator/delegation-manager.test.ts`

- [ ] **Step 1: Write new delegation primitive tests**

Test `delegateWork(from, to, task, context, responseFormat)` — creates DelegationRequest with type `delegate`.
Test `askCoworker(from, to, question, context)` — creates DelegationRequest with type `ask`, response_format `summary`.
Test that `delegateWork` sets ownership transfer flag; `askCoworker` does not.
Test that both validate against delegation graph.

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Update `src/orchestrator/delegation-manager.ts`**

Add to `DelegationManager`:
- `delegateWork(from, to, task, context?, responseFormat?): DelegationRequest` — full task handoff, marks ownership transfer
- `askCoworker(from, to, question, context?): DelegationRequest` — information request only, no ownership change
- Add `ownership_transfer: boolean` to `DelegationRequest` interface

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run tests/orchestrator/delegation-manager.test.ts`

```bash
git add src/orchestrator/delegation-manager.ts tests/orchestrator/delegation-manager.test.ts
git commit -m "feat: add delegation primitives — delegateWork and askCoworker"
```

---

### Task D4: Loop Prevention [PARALLEL after A1]

**Files:**
- Create: `src/orchestrator/loop-guard.ts`
- Test: `tests/orchestrator/loop-guard.test.ts`

- [ ] **Step 1: Write loop-guard tests**

Test `LoopGuard`:
- `checkLimit('review_cycle')` returns `{ allowed: true }` when under limit
- After hitting review_cycle limit (default 3): returns `{ allowed: false, reason, escalate_to }`
- `checkLimit('delegation_depth')` tracks nested delegation depth
- `checkLimit('total_actions')` tracks total actions across all agents
- `reset(limitType)` resets a specific counter
- Custom limits override defaults

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement `src/orchestrator/loop-guard.ts`**

```typescript
export class LoopGuard {
  private counters: Record<string, number> = {};
  private limits: LoopLimits;

  constructor(limits?: Partial<LoopLimits>) {
    this.limits = {
      review_cycle: 3,
      delegation_depth: 5,
      retry_same_agent: 2,
      total_actions: 50,
      ...limits,
    };
  }

  increment(limitType: keyof LoopLimits): { allowed: boolean; reason?: string } {
    this.counters[limitType] = (this.counters[limitType] ?? 0) + 1;
    if (this.counters[limitType] > this.limits[limitType]) {
      return { allowed: false, reason: `${limitType} limit (${this.limits[limitType]}) exceeded` };
    }
    return { allowed: true };
  }

  reset(limitType: keyof LoopLimits): void { ... }
  getCounters(): Record<string, number> { ... }
}
```

- [ ] **Step 4: Run tests, commit**

```bash
git add src/orchestrator/loop-guard.ts tests/orchestrator/loop-guard.test.ts
git commit -m "feat: add loop guard with configurable iteration limits"
```

---

### Task D5: Broadcast Event System [PARALLEL after A1]

**Files:**
- Create: `src/orchestrator/event-bus.ts`
- Test: `tests/orchestrator/event-bus.test.ts`

- [ ] **Step 1: Write event-bus tests**

Test `EventBus`:
- `subscribe(agentName, eventTypes)` registers agent for events
- `publish(event)` delivers to subscribed agents (by matching event.type to subscription)
- `publish(event)` with `notify: ['*']` delivers to all subscribers
- `publish(event)` with specific agent list delivers only to those agents
- `getSubscribers(eventType)` returns list of subscribed agents
- `unsubscribe(agentName)` removes all subscriptions for an agent

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement `src/orchestrator/event-bus.ts`**

```typescript
export class EventBus {
  private subscriptions = new Map<string, Set<string>>(); // eventType -> Set<agentName>

  subscribe(agentName: string, eventTypes: string[]): void { ... }
  unsubscribe(agentName: string): void { ... }

  publish(event: TeamEvent): string[] {
    // Returns list of agent names that were notified
    if (event.notify.includes('*')) {
      return this.getAllSubscribedAgents(event.type);
    }
    return event.notify.filter(agent => this.isSubscribed(agent, event.type));
  }

  getSubscribers(eventType: string): string[] { ... }
}
```

- [ ] **Step 4: Run tests, commit**

```bash
git add src/orchestrator/event-bus.ts tests/orchestrator/event-bus.test.ts
git commit -m "feat: add pub-sub event bus for cross-agent broadcasts"
```

---

### Task D6: Handoff Protocol [PARALLEL after A1]

**Files:**
- Create: `src/orchestrator/handoff-manager.ts`
- Test: `tests/orchestrator/handoff-manager.test.ts`

- [ ] **Step 1: Write handoff-manager tests**

Test `HandoffManager`:
- `createHandoff(from, to, artifact, openQuestions, constraints, status)` builds a valid Handoff
- `buildHandoffContext(handoff, targetAgent)` produces a context string suitable for injecting into the target agent's prompt — includes artifact summary, open questions, constraints
- `validateHandoff(handoff)` checks required fields
- `getHandoffHistory(agentName)` returns all handoffs involving an agent

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement `src/orchestrator/handoff-manager.ts`**

- [ ] **Step 4: Run tests, commit**

```bash
git add src/orchestrator/handoff-manager.ts tests/orchestrator/handoff-manager.test.ts
git commit -m "feat: add structured handoff protocol for agent-to-agent transitions"
```

---

### Task D7: Shared Context Manager [PARALLEL after A1]

**Files:**
- Create: `src/orchestrator/context-manager.ts`
- Test: `tests/orchestrator/context-manager.test.ts`

- [ ] **Step 1: Write context-manager tests**

Test `ContextManager`:
- `assembleTaskContext(agent, task, teamContext)` builds a scoped context string for a specific agent invocation — includes only what the agent needs based on `context.max_files` and `context.auto_include`
- `updateTeamContext(key, value)` stores a decision/artifact in team-wide shared state
- `getTeamContext()` returns all shared decisions, artifacts, and current progress
- `loadProjectContext(agentforgeDir)` reads `.agentforge/config/decisions.yaml` and project scan
- `saveDecision(agent, decision, rationale)` persists to decisions.yaml
- Context isolation: task context does NOT inherit other agents' full session history

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run tests/orchestrator/context-manager.test.ts`

- [ ] **Step 3: Implement `src/orchestrator/context-manager.ts`**

```typescript
export class ContextManager {
  private teamContext: Map<string, unknown> = new Map();
  private decisions: { agent: string; decision: string; rationale: string; timestamp: string }[] = [];

  assembleTaskContext(agent: AgentTemplate, task: string, options?: { files?: string[] }): string {
    // Build context from: agent's auto_include, project_specific, team decisions, task description
    // Respect agent's max_files limit
    // Never include other agents' raw session history (context isolation)
  }

  updateTeamContext(key: string, value: unknown): void { ... }
  getTeamContext(): Record<string, unknown> { ... }

  async loadProjectContext(agentforgeDir: string): Promise<void> { ... }
  async saveDecision(agent: string, decision: string, rationale: string): Promise<void> { ... }
}
```

- [ ] **Step 4: Run tests, commit**

```bash
git add src/orchestrator/context-manager.ts tests/orchestrator/context-manager.test.ts
git commit -m "feat: add shared context manager with three-level context assembly"
```

---

### Task D8: Integrate Runtime Systems into Orchestrator [SEQUENTIAL after D2-D7]

**Files:**
- Modify: `src/orchestrator/index.ts`
- Modify: `tests/orchestrator/execution-engine.test.ts`

- [ ] **Step 0: Write orchestrator integration tests**

```typescript
// tests/orchestrator/orchestrator-v2.test.ts
describe('Orchestrator v2 runtime', () => {
  it('startTask creates progress ledger and initializes loop guard', () => { ... });
  it('recordProgress updates ledger and checks health', () => { ... });
  it('recordProgress escalates when loop detected', () => { ... });
  it('broadcast delivers events to subscribed agents', () => { ... });
  it('handoff creates structured handoff with artifact metadata', () => { ... });
  it('checkHealth returns combined ledger and loop guard status', () => { ... });
  it('assembleContext uses context manager for agent invocation', () => { ... });
});
```

Run: `npx vitest run tests/orchestrator/orchestrator-v2.test.ts`
Expected: FAIL

- [ ] **Step 1: Update Orchestrator class**

Import and integrate: ProgressLedgerManager, LoopGuard, EventBus, HandoffManager, ContextManager. Add methods:
- `startTask(agent, task)` — creates ledger, initializes loop guard
- `recordProgress(taskId, step)` — updates ledger, checks health, checks loop limits
- `broadcast(event)` — publishes via event bus
- `handoff(from, to, artifact)` — creates structured handoff
- `checkHealth(taskId)` — returns ledger health + loop guard status

Update constructor to accept `CollaborationTemplate` for loop limits and set up event subscriptions from agent templates.

- [ ] **Step 2: Update barrel exports**

Re-export new modules from `src/orchestrator/index.ts`.

- [ ] **Step 3: Run full test suite, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/orchestrator/ tests/orchestrator/
git commit -m "feat: integrate progress ledger, loop guard, event bus, and handoffs into orchestrator"
```

---

## Phase E: Skill System v2 [PARALLEL with Phase D]

### Task E1: Skill Schema and Registry [PARALLEL after A1]

**Files:**
- Create: `src/skills/skill-loader.ts`
- Create: `src/skills/skill-registry.ts`
- Create: `src/skills/index.ts`
- Create: `templates/domains/core/skills/research/web_search.yaml`
- Create: `templates/domains/core/skills/analysis/summarize.yaml`
- Create: `templates/domains/core/skills/planning/brainstorm.yaml`
- Create: `templates/domains/core/skills/review/verify_before_claim.yaml`
- Create: `templates/domains/core/skills/communication/status_report.yaml`
- Create: `templates/domains/core/skills/creation/file_write.yaml`
- Create: `templates/domains/software/skills/creation/code_write.yaml`
- Create: `templates/domains/software/skills/review/code_review.yaml`
- Test: `tests/skills/skill-loader.test.ts`
- Test: `tests/skills/skill-registry.test.ts`

- [ ] **Step 1: Create core skill YAML files**

Create 6 core skills following the Skill schema from spec Section 5.1. Each skill has: name, version, category, domain, model_preference, description, parameters, gates, composable_with.

- [ ] **Step 2: Create software domain skill YAML files**

Create 2 software skills: `code_write.yaml` and `code_review.yaml`. The code_review skill should include a confidence gate (post: "Only report findings with confidence >= 80").

- [ ] **Step 3: Write skill-loader tests**

Test `loadSkill(path)` parses YAML into typed `Skill` interface. Test validation of required fields. Test `loadDomainSkills(domainDir)` loads all skills from a domain's skills/ directory recursively.

- [ ] **Step 4: Implement `src/skills/skill-loader.ts`**

- [ ] **Step 5: Write skill-registry tests**

Test `SkillRegistry`:
- `register(skill)` adds a skill to the registry
- `getSkill(name)` retrieves by name
- `getByCategory(category)` returns all skills in a category
- `getByDomain(domain)` returns all skills in a domain
- `getAvailableSkills(agentTemplate)` returns skills available to an agent (core + agent's domain + cross-domain if delegation graph allows)

- [ ] **Step 6: Implement `src/skills/skill-registry.ts`**

- [ ] **Step 7: Create barrel export, run tests, commit**

```bash
git add src/skills/ tests/skills/ templates/domains/*/skills/
git commit -m "feat: add structured skill system with loader and registry"
```

---

## Phase C: Domain Packs (Business + Product)

### Task C1: Business Domain Pack [PARALLEL after A2]

**Files:**
- Create: `templates/domains/business/domain.yaml`
- Create: `templates/domains/business/agents/ceo.yaml`
- Create: `templates/domains/business/agents/cto.yaml`
- Create: `templates/domains/business/agents/coo.yaml`
- Create: `templates/domains/business/agents/cfo.yaml`
- Create: `templates/domains/business/agents/business-analyst.yaml`
- Create: `templates/domains/business/agents/operations-manager.yaml`
- Create: `templates/domains/business/collaboration/executive-team.yaml`

- [ ] **Step 1: Create `templates/domains/business/domain.yaml`**

Use the business domain.yaml example from the spec — scanner type `document`, activation rules for .docx/.pdf/.pptx/.xlsx, signals for business documents.

- [ ] **Step 2: Create 6 business agent templates**

Each agent follows the AgentTemplate YAML schema. Key design points:
- **CEO** (Opus): system prompt focused on vision/strategy, delegates to CTO/COO/CFO, iron_laws: ["All strategic pivots require explicit user approval"], subscriptions: [milestone_reached, constraint_change]
- **CTO** (Opus): bridges business↔technical, delegates to architect/IT director, subscriptions: [architecture_decision, dependency_change]
- **COO** (Sonnet): operations focus, reports_to CEO
- **CFO** (Sonnet): financial modeling, reports_to CEO
- **Business Analyst** (Sonnet): requirements/process mapping, reports_to COO
- **Operations Manager** (Haiku): workflow optimization, utility agent

- [ ] **Step 3: Create `executive-team.yaml` collaboration template**

Hierarchy topology with CEO as root, CTO/COO/CFO as second level, BA/Ops as utility. Include loop_limits, escalation config, and gates.

- [ ] **Step 4: Write domain pack validation test**

```typescript
// tests/domains/business-domain.test.ts
import { describe, it, expect } from 'vitest';
import { loadDomainPack } from '../../src/domains/domain-loader.js';
import { loadAllTemplates } from '../../src/builder/template-loader.js';
import path from 'node:path';

describe('business domain pack', () => {
  const domainDir = path.resolve('templates/domains/business');

  it('domain.yaml parses into valid DomainPack', async () => {
    const pack = await loadDomainPack(domainDir);
    expect(pack.name).toBe('business');
    expect(pack.scanner.type).toBe('document');
    expect(pack.agents.strategic).toContain('ceo');
  });

  it('all agent templates parse correctly', async () => {
    const agents = await loadAllTemplates(path.join(domainDir, 'agents'));
    expect(agents.size).toBe(6);
    expect(agents.get('ceo')?.model).toBe('opus');
    expect(agents.get('operations-manager')?.model).toBe('haiku');
  });
});
```

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run tests/domains/business-domain.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add templates/domains/business/ tests/domains/business-domain.test.ts
git commit -m "feat: add business domain pack — 6 agents with executive-team topology"
```

---

### Task C2: Product Domain Pack [PARALLEL after A2]

**Files:**
- Create: `templates/domains/product/domain.yaml`
- Create: `templates/domains/product/agents/product-manager.yaml`
- Create: `templates/domains/product/agents/ux-designer.yaml`
- Create: `templates/domains/product/agents/ux-researcher.yaml`
- Create: `templates/domains/product/agents/product-analyst.yaml`
- Create: `templates/domains/product/agents/product-marketing-manager.yaml`
- Create: `templates/domains/product/collaboration/product-team.yaml`

- [ ] **Step 1: Create `templates/domains/product/domain.yaml`**

Scanner type `hybrid` (code + docs), activation rules for PRDs, wireframes, roadmap docs, user research. Signals: prd_detected, ux_artifacts_present.

- [ ] **Step 2: Create 5 product agent templates**

- **Product Manager** (Opus): roadmap/prioritization, delegates to UX Designer/Product Analyst, subscriptions: [architecture_decision, milestone_reached]
- **UX Designer** (Sonnet): wireframes/user flows, reports_to Product Manager
- **UX Researcher** (Sonnet): user interviews/personas, reports_to Product Manager
- **Product Analyst** (Sonnet): metrics/A/B tests, reports_to Product Manager
- **Product Marketing Manager** (Sonnet): positioning/launch, delegates to researcher

- [ ] **Step 3: Create `product-team.yaml` collaboration template**

Flat topology — PM coordinates but all product agents are peers. Loop limits and gates.

- [ ] **Step 4: Validate and commit**

```bash
git add templates/domains/product/
git commit -m "feat: add product domain pack — 5 agents with product-team topology"
```

---

### Task C3: Software Domain Enhancements [PARALLEL after A2]

**Files:**
- Create: `templates/domains/software/agents/code-explorer.yaml`
- Create: `templates/domains/software/agents/frontend-designer.yaml`
- Create: `templates/domains/software/agents/debugger.yaml`
- Create: `templates/domains/software/collaboration/dev-team.yaml`

- [ ] **Step 1: Create 3 new software agents**

- **Code Explorer** (Sonnet): traces execution paths, maps architecture layers, subscriptions: [architecture_decision]
- **Frontend Designer** (Sonnet): UI/UX implementation, component design, reports_to architect
- **Debugger** (Sonnet): systematic root-cause debugging with iron_laws: ["NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST"], four-phase process in system prompt

- [ ] **Step 2: Create `dev-team.yaml` collaboration template**

Use the full schema from spec Section 4.2 — hierarchy with architect as root, loop_limits, gates (review-before-complete, verify-before-claim), escalation.

- [ ] **Step 3: Update software domain.yaml**

Add new agents to the roster.

- [ ] **Step 4: Validate and commit**

```bash
git add templates/domains/software/
git commit -m "feat: add code-explorer, frontend-designer, debugger to software domain"
```

---

## Phase F: Remaining Domain Packs [ALL PARALLEL after C1 pattern established]

### Task F1: Marketing Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/marketing/domain.yaml`
- Create: `templates/domains/marketing/agents/{cmo,content-strategist,seo-specialist,brand-manager,growth-hacker,social-media-manager,copywriter}.yaml`
- Create: `templates/domains/marketing/collaboration/marketing-team.yaml`

- [ ] **Step 1: Create domain.yaml**

Scanner type `document`, activation rules for marketing plans, brand guides, analytics references, campaign docs. Signals: marketing_documents_present, brand_guidelines_detected.

- [ ] **Step 2: Create 7 agent templates**

- **CMO** (Opus): marketing strategy, delegates to all marketing agents
- **Content Strategist** (Sonnet): editorial calendar, reports_to CMO
- **SEO Specialist** (Sonnet): keyword/technical SEO, reports_to CMO
- **Brand Manager** (Sonnet): brand voice/identity, reports_to CMO
- **Growth Hacker** (Sonnet): experiments/funnels, reports_to CMO
- **Social Media Manager** (Haiku): platform content, utility
- **Copywriter** (Sonnet): ad copy/landing pages, reports_to content-strategist

- [ ] **Step 3: Create marketing-team.yaml collaboration template, validate, commit**

```bash
git add templates/domains/marketing/
git commit -m "feat: add marketing domain pack — 7 agents"
```

---

### Task F2: Research Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/research/domain.yaml`
- Create: `templates/domains/research/agents/{research-lead,data-scientist,ml-engineer,research-analyst}.yaml`
- Create: `templates/domains/research/collaboration/research-team.yaml`
- Test: `tests/domains/research-domain.test.ts`

- [ ] **Step 1: Create `domain.yaml`** — Scanner type `hybrid`, activates on notebooks (.ipynb), datasets, experiment configs, research papers.
- [ ] **Step 2: Create 4 agent templates** — Research Lead (Opus), Data Scientist (Sonnet), ML Engineer (Sonnet), Research Analyst (Haiku).
- [ ] **Step 3: Create `research-team.yaml`** — Flat topology, Research Lead coordinates.
- [ ] **Step 4: Write and run validation test** (follow C1 pattern)
- [ ] **Step 5: Commit**

```bash
git add templates/domains/research/ tests/domains/research-domain.test.ts
git commit -m "feat: add research domain pack — 4 agents"
```

---

### Task F3: Sales Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/sales/domain.yaml`
- Create: `templates/domains/sales/agents/{sales-director,account-executive,sales-engineer,bdr}.yaml`
- Create: `templates/domains/sales/collaboration/sales-team.yaml`
- Test: `tests/domains/sales-domain.test.ts`

- [ ] **Step 1: Create `domain.yaml`** — Scanner type `document`, activates on sales decks, pricing docs, CRM references.
- [ ] **Step 2: Create 4 agent templates** — Sales Director (Opus), Account Executive (Sonnet), Sales Engineer (Sonnet), BDR (Haiku).
- [ ] **Step 3: Create `sales-team.yaml`** — Hierarchy with Sales Director as root.
- [ ] **Step 4: Write and run validation test**
- [ ] **Step 5: Commit**

```bash
git add templates/domains/sales/ tests/domains/sales-domain.test.ts
git commit -m "feat: add sales domain pack — 4 agents"
```

---

### Task F4: Legal Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/legal/domain.yaml`
- Create: `templates/domains/legal/agents/{general-counsel,compliance-officer,contract-analyst,ip-specialist}.yaml`
- Create: `templates/domains/legal/collaboration/legal-team.yaml`
- Test: `tests/domains/legal-domain.test.ts`

- [ ] **Step 1: Create `domain.yaml`** — Scanner type `document`, activates on contracts, compliance docs, regulatory references.
- [ ] **Step 2: Create 4 agent templates** — General Counsel (Opus), Compliance Officer (Sonnet), Contract Analyst (Sonnet), IP Specialist (Sonnet).
- [ ] **Step 3: Create `legal-team.yaml`** — Hierarchy with General Counsel as root.
- [ ] **Step 4: Write and run validation test**
- [ ] **Step 5: Commit**

```bash
git add templates/domains/legal/ tests/domains/legal-domain.test.ts
git commit -m "feat: add legal domain pack — 4 agents"
```

---

### Task F5: HR Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/hr/domain.yaml`
- Create: `templates/domains/hr/agents/{hr-director,recruiter,l-and-d-specialist,compensation-analyst}.yaml`
- Create: `templates/domains/hr/collaboration/hr-team.yaml`
- Test: `tests/domains/hr-domain.test.ts`

- [ ] **Step 1: Create `domain.yaml`** — Scanner type `document`, activates on org docs, job descriptions, handbooks.
- [ ] **Step 2: Create 4 agent templates** — HR Director (Opus), Recruiter (Sonnet), L&D Specialist (Sonnet), Compensation Analyst (Sonnet).
- [ ] **Step 3: Create `hr-team.yaml`** — Flat topology, HR Director coordinates.
- [ ] **Step 4: Write and run validation test**
- [ ] **Step 5: Commit**

```bash
git add templates/domains/hr/ tests/domains/hr-domain.test.ts
git commit -m "feat: add hr domain pack — 4 agents"
```

---

### Task F6: IT Domain Pack [PARALLEL]

**Files:**
- Create: `templates/domains/it/domain.yaml`
- Create: `templates/domains/it/agents/{it-director,systems-administrator,network-engineer,dba,cloud-architect,help-desk-lead}.yaml`
- Create: `templates/domains/it/collaboration/it-team.yaml`
- Test: `tests/domains/it-domain.test.ts`

- [ ] **Step 1: Create `domain.yaml`** — Scanner type `hybrid`, activates on infrastructure configs, monitoring configs, runbooks, Dockerfiles, Terraform/Ansible files.
- [ ] **Step 2: Create 6 agent templates** — IT Director (Opus), Systems Administrator (Sonnet), Network Engineer (Sonnet), DBA (Sonnet), Cloud Architect (Sonnet), Help Desk Lead (Haiku).
- [ ] **Step 3: Create `it-team.yaml`** — Hierarchy with IT Director as root, Cloud Architect as strategic peer.
- [ ] **Step 4: Write and run validation test**
- [ ] **Step 5: Commit**

```bash
git add templates/domains/it/ tests/domains/it-domain.test.ts
git commit -m "feat: add it domain pack — 6 agents"
```

---

## Phase B: Genesis Agent [SEQUENTIAL after A4]

### Task B1: Project Brief Builder [SEQUENTIAL after A4]

**Files:**
- Create: `src/genesis/brief-builder.ts`
- Test: `tests/genesis/brief-builder.test.ts`

- [ ] **Step 1: Write brief-builder tests**

Test `buildBrief(scanResult, interviewAnswers?, researchFindings?)`:
- From scan only: populates `context.codebase` from scanResult, infers project type/stage
- From scan + interview: merges user answers into goals/constraints
- From interview only: builds brief with no codebase context
- Always populates `domains` based on activated domain signals

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement `src/genesis/brief-builder.ts`**

`buildBrief(params: { scan?: FullScanResult, answers?: Record<string, string>, research?: ResearchFindings, integrations?: IntegrationRef[] }): ProjectBrief` — constructs the universal ProjectBrief from all available inputs.

- [ ] **Step 4: Run tests, commit**

```bash
git add src/genesis/ tests/genesis/
git commit -m "feat: add project brief builder for Genesis workflow"
```

---

### Task B2: Genesis Workflow Engine [SEQUENTIAL after B1, D1]

**Files:**
- Create: `src/genesis/discovery.ts`
- Create: `src/genesis/interviewer.ts`
- Create: `src/genesis/team-designer.ts`
- Create: `src/genesis/index.ts`
- Test: `tests/genesis/discovery.test.ts`
- Test: `tests/genesis/team-designer.test.ts`

- [ ] **Step 1: Write discovery tests**

Test `discover(projectRoot)`:
- Empty directory → returns `{ state: 'empty', signals: [] }`
- Has source files → returns `{ state: 'codebase', signals: ['codebase_present'] }`
- Has docs only → returns `{ state: 'documents', signals: ['documents_present'] }`
- Has both → returns `{ state: 'full', signals: ['codebase_present', 'documents_present'] }`

- [ ] **Step 2: Implement `src/genesis/discovery.ts`**

Quick scan of project root to classify state and emit signals.

- [ ] **Step 3: Write team-designer tests**

Test `designTeam(brief, activeDomains, domainPacks, collaboration)`:
- Selects agents from active domain packs
- Assigns models (Opus for strategic, Sonnet for implementation, Haiku for utility)
- Selects collaboration topology
- Builds delegation graph with cross-domain bridges
- Returns proposed TeamManifest

- [ ] **Step 4: Implement `src/genesis/team-designer.ts`**

Orchestrates: domain activation → agent selection → topology selection → bridge building → manifest creation.

- [ ] **Step 5: Create `src/genesis/interviewer.ts`**

Stub for now — defines the interview question flow based on discovery state. Returns structured answers. Full API-driven interview will be wired in Phase H.

```typescript
export interface InterviewQuestion {
  id: string;
  question: string;
  type: 'text' | 'choice' | 'confirm';
  choices?: string[];
  condition?: (answers: Record<string, string>) => boolean;
}

export function getInterviewQuestions(discoveryState: string): InterviewQuestion[] { ... }
```

- [ ] **Step 6: Create `src/genesis/index.ts`**

```typescript
export async function genesis(projectRoot: string): Promise<TeamManifest> {
  const discovery = await discover(projectRoot);
  const scan = discovery.state !== 'empty' ? await runFullScan(projectRoot) : null;
  const domains = activateDomains(scan, availableDomains);
  const brief = buildBrief({ scan, answers: {}, research: undefined });
  const manifest = designTeam(brief, domains, domainPacks, selectTopology(brief, domains));
  return manifest;
}
```

- [ ] **Step 7: Run all tests, commit**

```bash
git add src/genesis/ tests/genesis/
git commit -m "feat: add Genesis workflow engine — discovery, brief building, team design"
```

---

### Task B3: Wire Genesis to CLI [SEQUENTIAL after B2]

**Files:**
- Modify: `src/cli/commands/forge.ts`
- Create: `src/cli/commands/genesis.ts`
- Modify: `src/cli/index.ts`
- Modify: `plugin.json`

- [ ] **Step 1: Create `src/cli/commands/genesis.ts`**

New `genesis` command:
- Description: "Start from an idea and build an optimized agent team"
- Option: `--interview` (force interview mode even if files exist)
- Option: `--domains <domains>` (manually specify domains, comma-separated)
- Action: runs Genesis workflow, displays proposed team, asks for confirmation, forges on approval

- [ ] **Step 2: Update `src/cli/commands/forge.ts`**

Update forge to use domain-aware pipeline. Add `--domains` option. Default behavior: detect domains automatically, fall back to software-only if no domain.yaml files found (backward compat).

- [ ] **Step 3: Register genesis command in CLI and plugin.json**

- [ ] **Step 4: Run full test suite, commit**

```bash
git add src/cli/ plugin.json
git commit -m "feat: add /genesis command and update /forge for domain awareness"
```

---

## Phase G: Meta-Agents [SEQUENTIAL after E1]

### Task G1: Meta-Agent Templates [PARALLEL after E1]

**Files:**
- Create: `templates/domains/core/agents/skill-designer.yaml`
- Create: `templates/domains/core/agents/team-reviewer.yaml`
- Create: `templates/domains/core/agents/template-optimizer.yaml`

- [ ] **Step 1: Create 3 meta-agent templates**

- **Skill Designer** (Sonnet): system prompt instructs it to analyze project patterns and generate new skill YAML files. Triggers: keywords ["create skill", "new skill", "missing capability"].
- **Team Reviewer** (Sonnet): system prompt instructs it to review a TeamManifest for gaps, redundancies, and misconfigurations. Iron law: "Flag gaps but never auto-fix without user approval."
- **Template Optimizer** (Sonnet): system prompt instructs it to improve agent system prompts based on usage patterns. Triggers: keywords ["optimize", "improve agent", "tune prompts"].

- [ ] **Step 2: Update core domain.yaml to include new agents**

- [ ] **Step 3: Commit**

```bash
git add templates/domains/core/
git commit -m "feat: add meta-agent templates — skill-designer, team-reviewer, template-optimizer"
```

---

## Phase H: New Scanners [PARALLEL after B1]

### Task H1: Document Analyzer Scanner [PARALLEL]

**Files:**
- Create: `src/scanner/document-analyzer.ts`
- Test: `tests/scanner/document-analyzer.test.ts`

- [ ] **Step 1: Write document-analyzer tests**

Test `analyzeDocuments(projectRoot)`:
- Detects .md, .txt, .pdf, .docx files (text-based only for now)
- Classifies document types: business-plan, prd, contract, policy, handbook, research-paper, marketing-plan, unknown
- Extracts summary (first 500 chars for now)
- Returns `DocumentAnalysis[]`

- [ ] **Step 2: Implement `src/scanner/document-analyzer.ts`**

Walks project for document files (skip node_modules, .git, dist). Classifies by filename patterns and content keywords. Returns structured results.

- [ ] **Step 3: Run tests, commit**

```bash
git add src/scanner/document-analyzer.ts tests/scanner/document-analyzer.test.ts
git commit -m "feat: add document analyzer scanner for business-mode projects"
```

---

### Task H2: Integration Detector Scanner [PARALLEL]

**Files:**
- Create: `src/scanner/integration-detector.ts`
- Test: `tests/scanner/integration-detector.test.ts`

- [ ] **Step 1: Write integration-detector tests**

Test `detectIntegrations(projectRoot)`:
- Finds Jira references (PROJECT-123 patterns, jira URLs)
- Finds Confluence references (confluence URLs, space keys)
- Finds Slack references (slack webhook URLs, channel mentions)
- Scans: source files, docs, configs, git commit messages
- Returns `IntegrationRef[]`

- [ ] **Step 2: Implement `src/scanner/integration-detector.ts`**

Regex-based scanning across file contents and git log output.

- [ ] **Step 3: Run tests, commit**

```bash
git add src/scanner/integration-detector.ts tests/scanner/integration-detector.test.ts
git commit -m "feat: add integration detector for Jira/Confluence/Slack references"
```

---

### Task H3: Code Comment Miner Scanner [PARALLEL]

**Files:**
- Create: `src/scanner/comment-miner.ts`
- Test: `tests/scanner/comment-miner.test.ts`

- [ ] **Step 1: Write comment-miner tests**

Test `mineComments(projectRoot)`:
- Finds TODO/FIXME/HACK/NOTE comments in source files
- Extracts architecture decision records from comments (ADR patterns)
- Finds inline documentation notes with context
- Skips node_modules, .git, dist
- Returns `{ todos: CommentNote[], decisions: CommentNote[], notes: CommentNote[] }`

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run tests/scanner/comment-miner.test.ts`

- [ ] **Step 3: Implement `src/scanner/comment-miner.ts`**

Regex-based scanning for comment patterns across TypeScript, Python, Go, Rust, Java source files. Extract comment text, file path, line number, and surrounding context (2 lines before/after).

- [ ] **Step 4: Run tests, commit**

```bash
git add src/scanner/comment-miner.ts tests/scanner/comment-miner.test.ts
git commit -m "feat: add code comment miner for TODOs, decisions, and architecture notes"
```

---

### Task H4: Web Researcher Scanner Stub [PARALLEL]

**Files:**
- Create: `src/scanner/web-researcher.ts`
- Test: `tests/scanner/web-researcher.test.ts`

- [ ] **Step 1: Write web-researcher tests**

Test `researchProject(projectName, keywords)`:
- Returns `ResearchFindings` with market_size, competitors, industry_trends
- When no API key is set, returns empty findings with a note
- When API key is set, delegates to Anthropic SDK for web search (mocked in tests)

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Implement `src/scanner/web-researcher.ts`**

Stub implementation that uses the Anthropic SDK's web search capability (via a Haiku agent) to research the project's domain. Falls back gracefully when no API key is available.

- [ ] **Step 4: Run tests, commit**

```bash
git add src/scanner/web-researcher.ts tests/scanner/web-researcher.test.ts
git commit -m "feat: add web researcher scanner for autonomous market/competitor research"
```

---

### Task H5: Update Scanner Index [SEQUENTIAL after H1, H2, H3, H4]

**Files:**
- Modify: `src/scanner/index.ts`

- [ ] **Step 1: Add new scanners to `FullScanResult`**

Add optional fields: `documents?: DocumentAnalysis[]`, `integrations?: IntegrationRef[]`.

- [ ] **Step 2: Update `runFullScan` to include new scanners**

Run document-analyzer and integration-detector alongside existing scanners via Promise.allSettled.

- [ ] **Step 3: Run full test suite, commit**

```bash
git add src/scanner/
git commit -m "feat: integrate document and integration scanners into full scan pipeline"
```

---

### Task B4: Update Reforge for v2 Migration [SEQUENTIAL after B2]

**Files:**
- Modify: `src/reforge/index.ts`
- Modify: `src/cli/commands/reforge.ts`

- [ ] **Step 1: Write reforge v2 migration test**

Test that `reforgeTeam()` on a v1 `.agentforge/` directory:
- Detects missing `domains` field in team.yaml
- Adds `domains: ['software']` as default
- Upgrades team manifest to include optional v2 fields
- Does not break existing v1 data

- [ ] **Step 2: Run test to verify fail**

- [ ] **Step 3: Update `src/reforge/index.ts`**

Add `migrateV1ToV2(projectRoot: string): Promise<void>` that reads an existing team.yaml, adds v2 optional fields with sensible defaults, and writes back. Called automatically by `reforgeTeam()` when v2 fields are missing.

- [ ] **Step 4: Update `src/cli/commands/reforge.ts`**

Add `--upgrade` flag that forces v2 migration without running full reforge. Update the default reforge path to detect and migrate v1 directories.

- [ ] **Step 5: Run tests, commit**

```bash
git add src/reforge/ src/cli/commands/reforge.ts tests/
git commit -m "feat: update reforge for v1 to v2 migration"
```

---

## Final: Integration Testing and CLI Verification

### Task Z1: End-to-End Integration Test [SEQUENTIAL — last task]

**Files:**
- Create: `tests/integration/forge-workflow.test.ts`
- Create: `tests/integration/domain-activation.test.ts`

- [ ] **Step 1: Write forge workflow integration test**

Create a temp directory with a mock TypeScript project (package.json, tsconfig.json, src/index.ts). Run `forgeTeam()` and verify:
- Software domain activates
- Core agents are included
- Architect, Coder, Researcher are in the manifest
- Collaboration template is hierarchy
- .agentforge/ directory is created with valid team.yaml

- [ ] **Step 2: Write domain activation integration test**

Create a temp directory with business docs (business-plan.md). Run domain activation and verify:
- Business domain activates
- Software domain does NOT activate (no source files)
- Core always activates

- [ ] **Step 3: Write multi-domain integration test**

Create a temp directory with both source files AND business docs. Verify both software and business domains activate, cross-domain bridges are created.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests pass, clean compile

- [ ] **Step 5: Commit**

```bash
git add tests/integration/
git commit -m "feat: add end-to-end integration tests for forge workflow and domain activation"
```

---

## Execution Summary

### Parallelization Map

```
A1 (types) ──┬──▶ A2 (restructure templates) ──┬──▶ A4 (update builder) ──▶ B1 ──▶ B2 ──▶ B3
             │                                  │                                       └──▶ B4
             ├──▶ A3 (domain loader) ───────────┘
             │
             ├──▶ D1 (collaboration templates) ─┐
             ├──▶ D2 (progress ledger) ──────────┤
             ├──▶ D3 (delegation primitives) ────┤
             ├──▶ D4 (loop prevention) ──────────┤──▶ D8 (integrate into orchestrator)
             ├──▶ D5 (event bus) ────────────────┤
             ├──▶ D6 (handoff protocol) ─────────┤
             ├──▶ D7 (context manager) ─────────┘
             │
             ├──▶ E1 (skill system) ──▶ G1 (meta-agents)
             │
             ├──▶ C1 (business domain) ──┐
             ├──▶ C2 (product domain) ───┤──▶ F1-F6 (remaining domains, all parallel)
             └──▶ C3 (software enhance) ─┘

             B1 ──▶ H1 (doc analyzer) ───┐
                   H2 (integration det) ──┤
                   H3 (comment miner) ────┤──▶ H5 (scanner index)
                   H4 (web researcher) ──┘
                                          └──▶ Z1 (integration tests)
```

### Model Assignment (Eating Our Own Dogfood)

This table demonstrates AgentForge's core value prop — matching model cost to task complexity:

| Task Category | Recommended Agent Model | Rationale | Cost Tier |
|---------------|------------------------|-----------|-----------|
| A1 (type system) | **Sonnet** | Bounded, well-specified type definitions | Medium |
| A2, C1-C3, F1-F6 (YAML templates) | **Haiku** | Mechanical YAML creation following established schema | Low |
| A3, D1-D7, E1 (new modules) | **Sonnet** | Implementation logic with clear specs | Medium |
| A4, D8, B2-B3 (integration work) | **Sonnet** | Wiring modules together, moderate complexity | Medium |
| B1 (brief builder) | **Sonnet** | Data transformation logic | Medium |
| H1-H4 (scanners) | **Sonnet** | File analysis with pattern matching | Medium |
| G1 (meta-agents) | **Haiku** | YAML template creation following established pattern | Low |
| Z1 (integration tests) | **Sonnet** | Test logic requiring understanding of full system | Medium |

**No Opus tasks** — every task has a clear spec to follow, removing the need for deep strategic reasoning. This mirrors how a real AgentForge team would work: Opus agents (Architect, CEO) make the strategic decisions up front (the spec), then Sonnet/Haiku agents execute.

**Maximum parallel agents at peak:** 13 (D1-D7 + E1 + C1-C3 + A2-A3 after A1 completes)

**Cost optimization:** If all YAML template tasks (A2, C1-C3, F1-F6, G1 = 12 tasks) run on Haiku instead of Sonnet, the total cost for those tasks drops ~85%. This is the exact delegation economics AgentForge implements — expensive models for reasoning, cheap models for execution.

### Task Count

- Phase A: 4 tasks (foundation)
- Phase D: 8 tasks (collaboration + orchestration)
- Phase E: 1 task (skills)
- Phase C: 3 tasks (business + product + software enhancements)
- Phase F: 6 tasks (remaining domains)
- Phase B: 4 tasks (Genesis + reforge update)
- Phase G: 1 task (meta-agents)
- Phase H: 5 tasks (scanners)
- Final: 1 task (integration tests)
- **Total: 33 tasks**
