# AgentForge v3 Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 4 foundational components that unblock all Phase 2 work: type system fixes, TaskComplexityRouter, FeedbackAnalyzer, and SessionStore.

**Architecture:** Phase 1 is Layer 0 of the dependency map — no inter-component dependencies. All 4 work items can be built and tested independently. Each wraps/extends v2 code without modifying any existing public interface (Iron Law 1). Zero new npm dependencies (Iron Law 5).

**Tech Stack:** TypeScript, vitest, Node.js fs module, existing AgentForge types

**CTO Acceptance Gate:** TaskComplexityRouter can be called standalone to demo routing decisions. FeedbackAnalyzer can run against this project's own `.agentforge/feedback/` directory and produce a real analysis. All v2 tests pass unchanged.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/routing/task-complexity-router.ts` | Extract task signals, score complexity, route to model tier, detect low confidence |
| `src/feedback/feedback-analyzer.ts` | Keyword clustering, cross-agent corroboration, theme detection, action recommendations |
| `src/orchestrator/session-store.ts` | Save/load ProgressLedger snapshots to `.agentforge/sessions/` |
| `tests/routing/task-complexity-router.test.ts` | Unit tests for router (>90% branch coverage) |
| `tests/feedback/feedback-analyzer.test.ts` | Unit tests for analyzer against real feedback files |
| `tests/orchestrator/session-store.test.ts` | Unit tests for session persistence |

### Modified Files
| File | Change |
|------|--------|
| `src/types/agent.ts` | Add `category` field to `AgentTemplate` |
| `src/types/feedback.ts` | Add `FeedbackTheme`, `RecommendedAction`, `FeedbackAnalysis` types |
| `src/types/orchestration.ts` | Add `DelegationEdge`, `ConditionalDelegationGraph` types |
| `src/types/index.ts` | Export new types from barrel |
| `src/orchestrator/cost-tracker.ts` | Export `MODEL_COSTS` constant |

---

## Task 1: Export MODEL_COSTS and Add category to AgentTemplate

**Why first:** These are 5-minute changes that unblock the entire cost stack and routing system. They are on the critical path.

**Files:**
- Modify: `src/types/agent.ts`
- Modify: `src/orchestrator/cost-tracker.ts`
- Modify: `src/types/index.ts`
- Test: existing tests must still pass

- [ ] **Step 1: Read cost-tracker.ts to find the cost constants**

```bash
grep -n "cost\|price\|MODEL" src/orchestrator/cost-tracker.ts | head -20
```

- [ ] **Step 2: Export MODEL_COSTS from cost-tracker.ts**

The constant is named `MODEL_COSTS` in `src/orchestrator/cost-tracker.ts`. Change `const MODEL_COSTS` to `export const MODEL_COSTS`. Do not rename it.

- [ ] **Step 3: Add `category` field to AgentTemplate**

First verify the field doesn't already exist: `grep -n 'category' src/types/agent.ts`

If `category` is not already on `AgentTemplate`, add it to the interface:

```typescript
/** Functional category for routing and escalation decisions. */
category?: AgentCategory;
```

Make it optional (`?`) to avoid breaking existing templates that don't set it.

- [ ] **Step 4: Run all tests to verify nothing breaks**

```bash
npx vitest run
```

Expected: All 540 tests pass. Zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/types/agent.ts src/orchestrator/cost-tracker.ts
git commit -m "feat: export MODEL_COSTS and add category to AgentTemplate — v3 Phase 1 unblock"
```

---

## Task 2: Add Feedback Types (FeedbackTheme, RecommendedAction, FeedbackAnalysis)

**Files:**
- Modify: `src/types/feedback.ts`
- Modify: `src/types/index.ts`
- Test: `tests/types/domain.test.ts` (existing — verify no breakage)

- [ ] **Step 1: Read the current feedback types**

```bash
cat src/types/feedback.ts
```

Understand: `FeedbackCategory`, `FeedbackPriority`, `AgentFeedback`, `FeedbackSummary`.

- [ ] **Step 2: Write the failing test for new types**

Create or extend a test file to verify the new types compile:

```typescript
// tests/types/feedback-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  FeedbackCategory,
  FeedbackPriority,
  FeedbackTheme,
  RecommendedAction,
  FeedbackAnalysis,
  FeedbackSummary,
} from "../../src/types/feedback.js";

describe("v3 feedback types", () => {
  it("FeedbackTheme has required fields", () => {
    const theme: FeedbackTheme = {
      label: "model-routing-inefficiency",
      keywords: ["model", "routing", "tier", "opus"],
      corroborating_agents: ["model-routing-researcher", "budget-strategy-researcher"],
      entry_count: 3,
      peak_priority: "high",
      signal_strength: 0.85,
      entry_ids: ["a1", "a2", "a3"],
    };
    expect(theme.label).toBe("model-routing-inefficiency");
    expect(theme.corroborating_agents).toHaveLength(2);
    expect(theme.signal_strength).toBeGreaterThan(0.7);
  });

  it("RecommendedAction has typed action field", () => {
    const action: RecommendedAction = {
      action: "adjust-model-routing",
      rationale: "3 agents independently flagged model tier waste",
      urgency: "high",
      theme_label: "model-routing-inefficiency",
      confidence: 0.9,
    };
    expect(action.action).toBe("adjust-model-routing");
  });

  it("FeedbackAnalysis includes themes and actions", () => {
    const analysis: FeedbackAnalysis = {
      analyzed_at: new Date().toISOString(),
      total_entries: 10,
      date_range: { earliest: "2026-03-25", latest: "2026-03-25" },
      themes: [],
      recommended_actions: [],
      requires_escalation: false,
      summary: {
        total: 10,
        by_category: {} as Record<FeedbackCategory, number>,
        by_priority: {} as Record<FeedbackPriority, number>,
        by_agent: {},
        entries: [],
      } as FeedbackSummary,
    };
    expect(analysis.requires_escalation).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/types/feedback-types.test.ts
```

Expected: FAIL — types don't exist yet.

- [ ] **Step 4: Add the types to src/types/feedback.ts**

Append to the file (after existing types):

```typescript
/** A detected theme cluster from feedback analysis. */
export interface FeedbackTheme {
  label: string;
  keywords: string[];
  corroborating_agents: string[];
  entry_count: number;
  peak_priority: FeedbackPriority;
  signal_strength: number;
  entry_ids: string[];
}

/** A recommended action derived from a detected feedback theme. */
export interface RecommendedAction {
  action:
    | "reforge-team"
    | "adjust-model-routing"
    | "increase-budget-ceiling"
    | "add-agent"
    | "remove-agent"
    | "update-system-prompt"
    | "review-manually";
  rationale: string;
  urgency: FeedbackPriority;
  theme_label: string;
  confidence: number;
}

/** Enriched analysis output from FeedbackAnalyzer. */
export interface FeedbackAnalysis {
  analyzed_at: string;
  total_entries: number;
  date_range: { earliest: string; latest: string };
  themes: FeedbackTheme[];
  recommended_actions: RecommendedAction[];
  requires_escalation: boolean;
  summary: FeedbackSummary;
}
```

- [ ] **Step 5: Export new types from barrel (src/types/index.ts)**

Add `FeedbackTheme`, `RecommendedAction`, `FeedbackAnalysis` to the feedback export block.

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/types/feedback-types.test.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: 540+ tests pass (540 existing + 3 new).

- [ ] **Step 8: Commit**

```bash
git add src/types/feedback.ts src/types/index.ts tests/types/feedback-types.test.ts
git commit -m "feat: add FeedbackTheme, RecommendedAction, FeedbackAnalysis types — v3 Phase 1"
```

---

## Task 3: Add Orchestration Types (DelegationEdge, ConditionalDelegationGraph)

**Files:**
- Modify: `src/types/orchestration.ts`
- Modify: `src/types/index.ts`
- Test: `tests/types/orchestration-types.test.ts` (new)

- [ ] **Step 1: Read current orchestration types**

```bash
cat src/types/orchestration.ts
```

Understand: `ProgressLedger`, `TeamEvent`, `Handoff`, `DelegationPrimitives`.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/types/orchestration-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  DelegationEdge,
  ConditionalDelegationGraph,
} from "../../src/types/orchestration.js";

describe("v3 orchestration types", () => {
  it("DelegationEdge supports conditions", () => {
    const edge: DelegationEdge = {
      from: "core-platform-lead",
      to: "type-system-designer",
      condition: {
        type: "ledger-state",
        field: "is_in_loop",
        operator: "equals",
        value: false,
      },
    };
    expect(edge.from).toBe("core-platform-lead");
    expect(edge.condition?.type).toBe("ledger-state");
  });

  it("DelegationEdge works without condition (unconditional)", () => {
    const edge: DelegationEdge = {
      from: "cto",
      to: "lead-architect",
    };
    expect(edge.condition).toBeUndefined();
  });

  it("ConditionalDelegationGraph maps agents to edges", () => {
    const graph: ConditionalDelegationGraph = {
      "core-platform-lead": [
        { from: "core-platform-lead", to: "type-system-designer" },
        {
          from: "core-platform-lead",
          to: "scanner-pipeline-designer",
          condition: { type: "confidence", field: "confidence", operator: "less-than", value: 0.5 },
        },
      ],
    };
    expect(graph["core-platform-lead"]).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/types/orchestration-types.test.ts
```

- [ ] **Step 4: Add types to src/types/orchestration.ts**

```typescript
/** Condition for a conditional delegation edge. */
export interface EdgeCondition {
  type: "ledger-state" | "confidence" | "cost-budget" | "feedback-theme";
  field: string;
  operator: "equals" | "not-equals" | "greater-than" | "less-than" | "contains";
  value: unknown;
}

/** A delegation edge that may be conditional on runtime state. */
export interface DelegationEdge {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

/** Delegation graph where edges can have runtime conditions. */
export type ConditionalDelegationGraph = Record<string, DelegationEdge[]>;
```

- [ ] **Step 5: Export from barrel**

Add `EdgeCondition`, `DelegationEdge`, `ConditionalDelegationGraph` to `src/types/index.ts`.

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/types/orchestration-types.test.ts && npx vitest run
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/types/orchestration.ts src/types/index.ts tests/types/orchestration-types.test.ts
git commit -m "feat: add DelegationEdge and ConditionalDelegationGraph types — v3 Phase 1"
```

---

## Task 4: TaskComplexityRouter

**This is the highest standalone ROI component.** It enables dynamic model routing at runtime.

**Files:**
- Create: `src/routing/task-complexity-router.ts`
- Create: `tests/routing/task-complexity-router.test.ts`

- [ ] **Step 1: Create the routing directory**

```bash
mkdir -p src/routing
```

- [ ] **Step 2: Write comprehensive failing tests**

```typescript
// tests/routing/task-complexity-router.test.ts
import { describe, it, expect } from "vitest";
import {
  extractTaskSignals,
  scoreComplexity,
  routeTask,
  detectLowConfidence,
} from "../../src/routing/task-complexity-router.js";

describe("extractTaskSignals", () => {
  it("detects reasoning keywords", () => {
    const signals = extractTaskSignals(
      "Analyze the architecture and synthesize a recommendation",
      "strategic",
      "opus",
    );
    expect(signals.hasReasoningKeywords).toBe(true);
  });

  it("detects code content", () => {
    const signals = extractTaskSignals(
      "Fix this function:\n```typescript\nfunction foo() {}\n```",
      "implementation",
      "sonnet",
    );
    expect(signals.hasCodeOrMath).toBe(true);
  });

  it("estimates token count from char length", () => {
    const task = "a".repeat(2000);
    const signals = extractTaskSignals(task, "utility", "haiku");
    expect(signals.promptTokenEstimate).toBe(500);
  });

  it("classifies output complexity based on signals", () => {
    const simple = extractTaskSignals("List files", "utility", "haiku");
    expect(simple.expectedOutputComplexity).toBe("simple");

    const deep = extractTaskSignals(
      "a".repeat(8001) + " analyze the tradeoffs and synthesize",
      "strategic",
      "opus",
    );
    expect(deep.expectedOutputComplexity).toBe("deep");
  });
});

describe("scoreComplexity", () => {
  it("scores a trivial utility task low", () => {
    const signals = extractTaskSignals("Read file.txt", "utility", "haiku");
    const score = scoreComplexity(signals);
    expect(score).toBeLessThan(0.3);
  });

  it("scores a complex strategic task high", () => {
    const signals = extractTaskSignals(
      "a".repeat(12001) + " Analyze the system architecture, compare tradeoffs between approaches, and design a new integration pattern",
      "strategic",
      "opus",
    );
    const score = scoreComplexity(signals);
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it("scores a moderate implementation task in the middle", () => {
    const signals = extractTaskSignals(
      "Refactor the delegation manager to support conditional edges",
      "implementation",
      "sonnet",
    );
    const score = scoreComplexity(signals);
    expect(score).toBeGreaterThanOrEqual(0.1);
    expect(score).toBeLessThan(0.7);
  });
});

describe("routeTask", () => {
  it("routes trivial utility tasks to haiku", () => {
    const decision = routeTask("Read file.txt", "utility", "sonnet");
    expect(decision.assignedTier).toBe("haiku");
    expect(decision.escalationAllowed).toBe(true);
  });

  it("respects category floor — strategic never below sonnet", () => {
    const decision = routeTask("Short question", "strategic", "opus");
    expect(decision.assignedTier).not.toBe("haiku");
  });

  it("respects ceiling — never exceeds agent template tier", () => {
    const decision = routeTask(
      "a".repeat(12001) + " Analyze and synthesize the entire architecture",
      "strategic",
      "sonnet",  // ceiling is sonnet even though task scores high
    );
    expect(decision.assignedTier).toBe("sonnet");
  });

  it("allows escalation when assigned below ceiling", () => {
    const decision = routeTask("List files", "utility", "sonnet");
    expect(decision.assignedTier).toBe("haiku");
    expect(decision.escalationAllowed).toBe(true);
  });

  it("disallows escalation when assigned at ceiling", () => {
    const decision = routeTask(
      "a".repeat(12001) + " Analyze and synthesize and design",
      "strategic",
      "opus",
    );
    expect(decision.assignedTier).toBe("opus");
    expect(decision.escalationAllowed).toBe(false);
  });
});

describe("detectLowConfidence", () => {
  it("detects hedging language", () => {
    expect(detectLowConfidence("I'm not sure about this approach")).toBe(true);
    expect(detectLowConfidence("This might be correct")).toBe(true);
    // Confidence scores 1-3 of 5 are hedging. The regex is /confidence:\s*[1-3]\/5/i
    expect(detectLowConfidence("Confidence: 2/5")).toBe(true);
    expect(detectLowConfidence("Confidence: 1/5")).toBe(true);
  });

  it("passes confident responses", () => {
    // Confidence scores 4/5 and 5/5 are NOT hedging
    expect(detectLowConfidence("Here is the implementation. Confidence: 5/5")).toBe(false);
    expect(detectLowConfidence("Confidence: 4/5")).toBe(false);
    expect(detectLowConfidence("The correct approach is to use a factory pattern.")).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
mkdir -p tests/routing
npx vitest run tests/routing/task-complexity-router.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement task-complexity-router.ts**

Create `src/routing/task-complexity-router.ts` with the full implementation from the R&D proposal. The key exports are:
- `extractTaskSignals(task, category, ceiling)` → `TaskSignals`
- `scoreComplexity(signals)` → `number` (0–1)
- `routeTask(task, category, ceiling)` → `RoutingDecision`
- `detectLowConfidence(responseText)` → `boolean`

Also export the interfaces: `TaskSignals`, `RoutingDecision`.

Implementation reference: `.agentforge/feedback/2026-03-25-model-routing-researcher-dynamic-model-selection.md` lines 54-198.

Key constants:
- `REASONING_KEYWORDS`: analyze, architect, synthesize, compare, tradeoff, design, evaluate, strategize, refactor, audit, diagnose, plan, assess, recommend
- `CONFIDENCE_HEDGE_PATTERNS`: regex array for hedging language
- `CATEGORY_FLOOR`: strategic→sonnet, implementation→haiku, quality→sonnet, utility→haiku
- `TIER_RANK`: haiku=0, sonnet=1, opus=2

Score breakdown: token count (0–0.3) + reasoning signals (0–0.3) + output complexity (0–0.2) + agent category (0–0.2) = max 1.0.

Routing thresholds: ≥0.75 → opus, ≥0.40 → sonnet, else → haiku. Then apply floor and ceiling.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/routing/task-complexity-router.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Run full suite**

```bash
npx vitest run
```

Expected: 540+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/routing/ tests/routing/
git commit -m "feat: add TaskComplexityRouter with dynamic model routing — v3 Phase 1"
```

---

## Task 5: FeedbackAnalyzer

**Files:**
- Create: `src/feedback/feedback-analyzer.ts`
- Create: `tests/feedback/feedback-analyzer.test.ts`

- [ ] **Step 1: Read existing feedback collector for compatibility**

```bash
cat src/feedback/feedback-collector.ts
```

Understand: `submitFeedback`, `loadAllFeedback`, `getSummary`, `getByCategory`, `getByPriority`, `getByAgent`.

- [ ] **Step 2: Write failing tests**

```typescript
// tests/feedback/feedback-analyzer.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { FeedbackAnalyzer } from "../../src/feedback/feedback-analyzer.js";
import type { AgentFeedback, FeedbackAnalysis } from "../../src/types/feedback.js";

function makeFeedback(overrides: Partial<AgentFeedback>): AgentFeedback {
  return {
    id: crypto.randomUUID(),
    agent: "test-agent",
    category: "optimization",
    priority: "medium",
    title: "Test feedback",
    description: "A test feedback entry",
    context: { task: "test", files_involved: [], model_used: "haiku", tokens_consumed: 100, duration_ms: 1000 },
    suggestion: "Fix it",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("FeedbackAnalyzer", () => {
  const analyzer = new FeedbackAnalyzer();

  it("returns empty analysis for no entries", () => {
    const result = analyzer.analyze([]);
    expect(result.total_entries).toBe(0);
    expect(result.themes).toHaveLength(0);
    expect(result.recommended_actions).toHaveLength(0);
    expect(result.requires_escalation).toBe(false);
  });

  it("detects a theme when 2+ agents report same keywords", () => {
    const entries = [
      makeFeedback({ agent: "agent-a", description: "Model routing is inefficient, opus tier used for haiku tasks" }),
      makeFeedback({ agent: "agent-b", description: "The model tier routing wastes tokens on opus when haiku would suffice" }),
      makeFeedback({ agent: "agent-c", description: "Something completely unrelated about documentation" }),
    ];
    const result = analyzer.analyze(entries);
    const routingTheme = result.themes.find((t) => t.keywords.some((k) => k.includes("model") || k.includes("routing")));
    expect(routingTheme).toBeDefined();
    expect(routingTheme!.corroborating_agents.length).toBeGreaterThanOrEqual(2);
  });

  it("produces recommended actions for high-signal themes", () => {
    const entries = [
      makeFeedback({ agent: "agent-a", priority: "high", description: "Model routing is broken, opus used everywhere" }),
      makeFeedback({ agent: "agent-b", priority: "high", description: "Routing agents to wrong model tier, too much opus" }),
      makeFeedback({ agent: "agent-c", priority: "high", description: "Model tier selection ignores task complexity" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.recommended_actions.length).toBeGreaterThan(0);
  });

  it("sets requires_escalation when signal strength exceeds threshold", () => {
    const entries = [
      makeFeedback({ agent: "a1", priority: "critical", description: "Cost budget exceeded, model routing failure" }),
      makeFeedback({ agent: "a2", priority: "critical", description: "Model routing cost is out of control" }),
      makeFeedback({ agent: "a3", priority: "high", description: "Budget overrun due to routing" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.requires_escalation).toBe(true);
  });

  it("respects configurable corroboration threshold", () => {
    const strictAnalyzer = new FeedbackAnalyzer({ corroborationThreshold: 5 });
    const entries = [
      makeFeedback({ agent: "a1", description: "Model routing issue" }),
      makeFeedback({ agent: "a2", description: "Model routing problem" }),
    ];
    const result = strictAnalyzer.analyze(entries);
    // Only 2 agents — below threshold of 5
    expect(result.themes.filter((t) => t.signal_strength > 0.5)).toHaveLength(0);
  });

  it("includes backward-compatible summary", () => {
    const entries = [
      makeFeedback({ category: "optimization" }),
      makeFeedback({ category: "bug" }),
    ];
    const result = analyzer.analyze(entries);
    expect(result.summary.total).toBe(2);
    expect(result.summary.by_category.optimization).toBe(1);
    expect(result.summary.by_category.bug).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/feedback/feedback-analyzer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement feedback-analyzer.ts**

Create `src/feedback/feedback-analyzer.ts`. The key class is:

```typescript
export class FeedbackAnalyzer {
  constructor(options?: { corroborationThreshold?: number });
  analyze(entries: AgentFeedback[]): FeedbackAnalysis;
}
```

Implementation reference: `.agentforge/feedback/2026-03-25-feedback-analysis-researcher-pattern-detection.md` lines 130-350.

Key algorithm:
1. Tokenize all descriptions → keyword frequency map (excluding STOPWORDS)
2. Apply SYNONYM_MAP to normalize keywords
3. Cluster keywords by co-occurrence (keywords that appear together in ≥2 entries)
4. Score each cluster: `signal_strength = (corroborating_agents.length / total_agents) × priority_weight × recency_factor`
5. Filter clusters by corroboration threshold (default: 2)
6. Map high-signal themes to `RecommendedAction` types
7. Set `requires_escalation = true` if any theme has `signal_strength > 0.7`
8. Build backward-compatible `FeedbackSummary` for the `summary` field

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/feedback/feedback-analyzer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Test against real feedback files in .agentforge/feedback/**

This is part of the CTO's acceptance gate. The analyzer must work on the actual R&D proposals:

```typescript
// Add to the test file:
it("analyzes real AgentForge feedback files", async () => {
  // This test reads actual .agentforge/feedback/ files
  const { FeedbackCollector } = await import("../../src/feedback/feedback-collector.js");
  const collector = new FeedbackCollector(".");
  const entries = await collector.loadAllFeedback();

  // Skip if no feedback files exist (CI environment)
  if (entries.length === 0) return;

  const result = analyzer.analyze(entries);
  expect(result.total_entries).toBeGreaterThan(0);
  expect(result.themes.length).toBeGreaterThan(0);
  // Real feedback should detect the model-routing theme
  console.log("Real analysis:", JSON.stringify(result.themes.map(t => t.label), null, 2));
});
```

- [ ] **Step 7: Run full suite**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add src/feedback/feedback-analyzer.ts tests/feedback/feedback-analyzer.test.ts
git commit -m "feat: add FeedbackAnalyzer with keyword clustering and corroboration scoring — v3 Phase 1"
```

---

## Task 6: SessionStore

**Files:**
- Create: `src/orchestrator/session-store.ts`
- Create: `tests/orchestrator/session-store.test.ts`

- [ ] **Step 1: Read ProgressLedger type for the snapshot format**

```bash
grep -A 30 "ProgressLedger" src/types/orchestration.ts
```

- [ ] **Step 2: Write failing tests**

```typescript
// tests/orchestrator/session-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/orchestrator/session-store.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProgressLedger } from "../../src/types/orchestration.js";

function makeLedger(taskId: string): ProgressLedger {
  return {
    task_id: taskId,
    objective: "Test objective for " + taskId,
    facts: {
      given: ["TypeScript project", "540 tests"],
      to_look_up: ["performance bottleneck"],
      to_derive: ["optimal model routing"],
      educated_guesses: [],
    },
    plan: ["Analyze code", "Propose routing"],
    steps_completed: ["Analyzed code"],
    current_step: null,
    is_request_satisfied: false,
    is_in_loop: false,
    is_progress_being_made: true,
    confidence: 0.8,
    next_speaker: "cost-engine-designer",
    instruction: "Continue with analysis",
  };
}

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-session-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saveSnapshot creates a JSON file in .agentforge/sessions/", async () => {
    const ledger = makeLedger("task-001");
    await store.saveSnapshot(ledger);

    const sessionsDir = path.join(tmpDir, ".agentforge", "sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^task-001.*\.json$/);
  });

  it("loadLatest returns the most recent snapshot for a task", async () => {
    const ledger1 = makeLedger("task-002");
    await store.saveSnapshot(ledger1);

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    const ledger2 = { ...makeLedger("task-002"), steps_completed: ["Step 1", "Step 2"] };
    await store.saveSnapshot(ledger2);

    const loaded = await store.loadLatest("task-002");
    expect(loaded).not.toBeNull();
    expect(loaded!.steps_completed).toHaveLength(2);
  });

  it("loadLatest returns null for non-existent task", async () => {
    const result = await store.loadLatest("nonexistent");
    expect(result).toBeNull();
  });

  it("loadAllSnapshots returns all snapshots across tasks", async () => {
    await store.saveSnapshot(makeLedger("task-a"));
    await store.saveSnapshot(makeLedger("task-b"));
    await store.saveSnapshot(makeLedger("task-c"));

    const all = await store.loadAllSnapshots();
    expect(all).toHaveLength(3);
  });

  it("loadAllSnapshots returns empty array when no sessions exist", async () => {
    const all = await store.loadAllSnapshots();
    expect(all).toHaveLength(0);
  });

  it("loadLatest does not match task IDs that are prefixes of another", async () => {
    await store.saveSnapshot(makeLedger("task-1"));
    await new Promise((r) => setTimeout(r, 10));
    await store.saveSnapshot(makeLedger("task-10"));
    const loaded = await store.loadLatest("task-1");
    expect(loaded!.task_id).toBe("task-1");
  });

  it("round-trips ProgressLedger data correctly", async () => {
    const original = makeLedger("round-trip");
    original.is_in_loop = true;
    original.facts.educated_guesses = ["Maybe the scanner is slow"];

    await store.saveSnapshot(original);
    const loaded = await store.loadLatest("round-trip");

    expect(loaded).toEqual(original);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/orchestrator/session-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement session-store.ts**

```typescript
// src/orchestrator/session-store.ts

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProgressLedger } from "../types/orchestration.js";

/**
 * Persists ProgressLedger snapshots to .agentforge/sessions/ for cross-session learning.
 * Used by ReforgeEngine (Phase 2) to analyze performance trends across sessions.
 */
export class SessionStore {
  private sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, ".agentforge", "sessions");
  }

  /** Save a ledger snapshot with timestamp. */
  async saveSnapshot(ledger: ProgressLedger): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = path.join(
      this.sessionsDir,
      `${ledger.task_id}-${Date.now()}.json`,
    );
    await fs.writeFile(filePath, JSON.stringify(ledger, null, 2), "utf-8");
  }

  /** Load the most recent snapshot for a given task. */
  async loadLatest(taskId: string): Promise<ProgressLedger | null> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      // Use taskId + "-" prefix to avoid matching "task-1" against "task-10"
      const prefix = taskId + "-";
      const snapshots = entries
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .sort();

      if (snapshots.length === 0) return null;

      const latest = path.join(this.sessionsDir, snapshots[snapshots.length - 1]);
      const data = await fs.readFile(latest, "utf-8");
      return JSON.parse(data) as ProgressLedger;
    } catch {
      return null;
    }
  }

  /** Load all snapshots for cross-session learning — used by ReforgeEngine. */
  async loadAllSnapshots(): Promise<ProgressLedger[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      const results: ProgressLedger[] = [];
      for (const f of entries.filter((e) => e.endsWith(".json"))) {
        try {
          const data = await fs.readFile(path.join(this.sessionsDir, f), "utf-8");
          results.push(JSON.parse(data) as ProgressLedger);
        } catch {
          // Skip corrupted files
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/orchestrator/session-store.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/session-store.ts tests/orchestrator/session-store.test.ts
git commit -m "feat: add SessionStore for cross-session ProgressLedger persistence — v3 Phase 1"
```

---

## Task 7: Integration Verification and Build

**Files:**
- Modify: `src/types/index.ts` (final barrel check)
- Run: `npx tsc --noEmit` and `npx vitest run`

- [ ] **Step 1: Verify all new exports are in the barrel**

```bash
grep -c "FeedbackTheme\|RecommendedAction\|FeedbackAnalysis\|EdgeCondition\|DelegationEdge\|ConditionalDelegationGraph" src/types/index.ts
```

Expected: 6 (all new types exported). Note: `TaskSignals` and `RoutingDecision` are exported from `src/routing/task-complexity-router.ts`, not the types barrel.

Expected: All types present in export lists.

- [ ] **Step 2: TypeScript build check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Full test suite**

```bash
npx vitest run
```

Expected: All 540+ original tests pass, plus new tests (target ~565+ total).

- [ ] **Step 4: Build dist/**

```bash
npm run build
```

If no build script, use `npx tsc`.

- [ ] **Step 5: Verify CTO acceptance gate**

Run the two demos:

**Demo 1: TaskComplexityRouter standalone**
```typescript
// Run in Node REPL or as a quick script
import { routeTask } from './dist/routing/task-complexity-router.js';
console.log(routeTask("Read file.txt", "utility", "opus"));
// Expected: assignedTier = "haiku", escalationAllowed = true

console.log(routeTask("Analyze the entire system architecture and design a new type system", "strategic", "opus"));
// Expected: assignedTier = "opus" or "sonnet", complexityScore > 0.6
```

**Demo 2: FeedbackAnalyzer on real feedback**
```typescript
import { FeedbackCollector } from './dist/feedback/feedback-collector.js';
import { FeedbackAnalyzer } from './dist/feedback/feedback-analyzer.js';

const collector = new FeedbackCollector('.');
const entries = await collector.loadAllFeedback();
const analyzer = new FeedbackAnalyzer();
const analysis = analyzer.analyze(entries);

console.log(`Analyzed ${analysis.total_entries} entries`);
console.log(`Themes found: ${analysis.themes.map(t => t.label).join(', ')}`);
console.log(`Requires escalation: ${analysis.requires_escalation}`);
console.log(`Recommended actions: ${analysis.recommended_actions.length}`);
```

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "feat: Phase 1 complete — all v3 foundation components verified"
```

---

## Summary

| Task | Component | New Tests | Files Created | Files Modified |
|------|-----------|-----------|---------------|----------------|
| 1 | MODEL_COSTS export + category | 0 | 0 | 3 |
| 2 | Feedback types | ~3 | 1 test | 2 |
| 3 | Orchestration types | ~3 | 1 test | 2 |
| 4 | TaskComplexityRouter | ~12 | 2 (src + test) | 0 |
| 5 | FeedbackAnalyzer | ~7 | 2 (src + test) | 0 |
| 6 | SessionStore | ~6 | 2 (src + test) | 0 |
| 7 | Integration verification | 0 | 0 | 1 (barrel) |
| **Total** | | **~31** | **8** | **8** |

**Estimated test count after Phase 1:** 540 + ~31 = ~571 tests

**Dependencies for Phase 2 unblocked by this plan:**
- `TaskComplexityRouter` → CostAwareRunner (2a)
- `FeedbackAnalyzer` → ReforgeEngine (2b)
- `SessionStore` → ReforgeEngine (2b), ConditionalDelegationGraph runtime (2b)
- `MODEL_COSTS` export → BudgetEnvelope, ParallelFanOutEngine (2a)
- `category` on AgentTemplate → TaskComplexityRouter integration with agent-runner (2a)
- `ConditionalDelegationGraph` → Intelligence Wiring (2b)
