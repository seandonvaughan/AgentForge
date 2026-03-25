---
id: c5e1a4b2-7d36-4f82-a0c3-9b8e2f5d3c71
agent: integration-architecture-lead
category: feature
priority: critical
timestamp: "2026-03-25T03:30:00.000Z"
---

# AgentForge v3 Integration Architecture: Unified Communication + External Tools

## Problem

AgentForge v2 is a capable orchestration engine that is blind to the outside world and deaf between its own agents. The two companion proposals identify the gaps:

1. **External blindness** (`external-tools-researcher`): agents can coordinate internally but cannot materialize their work as Jira tickets, Confluence pages, GitHub PRs, or Slack messages. The `integration-detector.ts` scanner knows a project *uses* Jira but cannot create issues in it.

2. **Internal deafness** (`agent-protocol-researcher`): agents communicate through thin strings and untyped `payload: unknown` blobs. The `EventBus` is notify-only with no handler registration; `ContextManager.decisions` is an ephemeral in-memory array; there is no direct agent-to-agent messaging; and the shared `teamContext` Map is unqueried and unversioned.

These are not independent problems. An agent that dispatches an external integration action needs to *record* that action in the decision log so other agents know it happened. An agent receiving a typed `handoff_complete` event needs to *write* to the knowledge store that the handoff context is now available. A `security_alert` event should both notify peer agents via the `MessageBus` *and* trigger a Jira ticket creation via the `IntegrationLayer`. The v3 architecture must unify these concerns.

## Research

See companion proposals:
- `2026-03-25-external-tools-researcher-mcp-integration.md` — MCP server inventory, action mapping, `IntegrationLayer` and `mcp-config-generator` design
- `2026-03-25-agent-protocol-researcher-communication-protocols.md` — AutoGen/LangGraph/CrewAI/ACP/A2A research, `MessageBus`, `KnowledgeStore`, `DecisionLog` design

Additional synthesis research:

**The four new components must be instantiated and cross-wired by the orchestrator.** None of them are useful in isolation:
- `IntegrationLayer` must write to `DecisionLog` when it dispatches an action (so agents know what external resources exist).
- `DecisionLog` must be readable by `ContextManager.assembleTaskContext()` (so decision history appears in every agent's context).
- `MessageBus` typed event dispatch (`handoff_complete`, `integration_action`) must trigger `KnowledgeStore` writes (so knowledge accumulates automatically from events, not just from explicit writes).
- `KnowledgeStore` entity entries (Jira issue IDs, GitHub PR numbers) must be available to `IntegrationLayer` (to avoid creating duplicate tickets for the same artifact).

**The `ContextManager` is the natural coordinator.** It already assembles context from multiple sources (files, team state, decisions). In v3, it should delegate to `KnowledgeStore` and `DecisionLog` rather than owning those stores directly, but it remains the single entry point for "give me context for this agent invocation."

**The `HandoffManager` and `DelegationManager` are integration points, not replacement targets.** A handoff completion should automatically enqueue a `handoff_complete` event on the `MessageBus`. A delegation completion should write the result to the `KnowledgeStore`. These additions are one or two lines in the existing managers — not rewrites.

**Session initialization is the right place to wire everything together.** v2 has no explicit session object — the orchestrator creates managers ad hoc. v3 needs an `AgentForgeSession` that owns all infrastructure and provides a typed API to agents and the orchestrator.

## Findings

### The v3 data flow: how the components connect

```
External triggers (Jira, GitHub, Slack, Confluence)
       ↓ (detected by integration-detector.ts, read by IntegrationLayer)
AgentForgeSession
  ├── MessageBus          ← pub-sub + handler registration + priority queue
  │     └── EventBus      ← existing v2 (unchanged, wrapped)
  ├── KnowledgeStore      ← multi-scope: session / project / entity
  ├── DecisionLog         ← persistent, typed, linked to external artifacts
  ├── IntegrationLayer    ← MCP dispatch → records to DecisionLog + KnowledgeStore
  └── ContextManager      ← assembles per-agent context from KnowledgeStore + DecisionLog
        ├── HandoffManager  ← existing v2 (unchanged)
        └── DelegationManager ← existing v2 (unchanged)
```

### Key wiring rules

1. `HandoffManager.createHandoff()` → auto-enqueue `handoff_complete` on `MessageBus`
2. `IntegrationLayer.dispatch()` → write to `DecisionLog.record()` + `KnowledgeStore.write(entity scope)`
3. `MessageBus` handler for `security_alert` → auto-dispatch `IntegrationLayer.dispatch(jira:create_issue)` if `jira` is enabled
4. `ContextManager.assembleTaskContext()` → include `DecisionLog.formatForContext()` + `KnowledgeStore.summarizeForContext()`
5. `DelegationManager.delegateWork()` result → write to `KnowledgeStore.write(session scope)`

### What changes vs. v2 — summary table

| Component | v2 state | v3 change |
|---|---|---|
| `EventBus` (`src/orchestrator/event-bus.ts`) | Unchanged | Unchanged — wrapped by `MessageBus` |
| `HandoffManager` (`src/orchestrator/handoff-manager.ts`) | Unchanged | Add 2 lines: enqueue `handoff_complete` on `MessageBus` after `createHandoff` |
| `DelegationManager` (`src/orchestrator/delegation-manager.ts`) | Unchanged | Add 2 lines: write delegation result to `KnowledgeStore` |
| `ContextManager` (`src/orchestrator/context-manager.ts`) | Owns decisions array + teamContext Map | Delegates to `DecisionLog` and `KnowledgeStore`; public API unchanged |
| `TeamEvent.payload` (`src/types/orchestration.ts`) | `unknown` | Typed `TypedEventPayload` discriminated union (backward compatible) |
| `AgentTemplate` (`src/types/agent.ts`) | No integration config | Add `integrations?: AgentIntegrationConfig` |
| `integration-detector.ts` (`src/scanner/`) | Detects refs passively | Feed output to `generateMcpConfig()` to produce `.mcp/config.json` |
| **NEW** `MessageBus` | — | Priority queue + handler registration wrapping `EventBus` |
| **NEW** `KnowledgeStore` | — | Multi-scope knowledge store replacing `teamContext` Map |
| **NEW** `DecisionLog` | — | Persistent, typed, linked decisions replacing `decisions[]` |
| **NEW** `IntegrationLayer` | — | MCP dispatch for Jira, GitHub, Confluence, Slack |
| **NEW** `AgentForgeSession` | — | Session factory that wires all components together |

## Recommendation

Ship v3 integration architecture as three sequential milestones:

**Milestone 1 — Communication foundation (no external dependencies):**
Implement `MessageBus`, `KnowledgeStore`, `DecisionLog`. Update `ContextManager` to delegate to `DecisionLog` and `KnowledgeStore`. Update `HandoffManager` to enqueue `handoff_complete` events. No MCP required, no external tool accounts needed. Pure TypeScript, fully testable in isolation.

**Milestone 2 — External integration via MCP:**
Implement `IntegrationLayer` and `mcp-config-generator`. Add `integrations` to `AgentTemplate`. Wire `IntegrationLayer` to `DecisionLog` and `KnowledgeStore`. Add `agentforge mcp` CLI subcommand. Requires MCP servers running (opt-in per project).

**Milestone 3 — `AgentForgeSession` and orchestrator integration:**
Implement `AgentForgeSession` factory. Update orchestrator to use session-scoped infrastructure. Add automatic event-to-action rules (security alerts → Jira tickets). Add project-scoped `KnowledgeStore` persistence to `.agentforge/knowledge/`.

## Implementation Sketch

### The `AgentForgeSession` — v3's central wiring point

```typescript
// src/orchestrator/session.ts — NEW FILE

import { EventBus } from "./event-bus.js";
import { MessageBus } from "./message-bus.js";
import { HandoffManager } from "./handoff-manager.js";
import { DelegationManager } from "./delegation-manager.js";
import { ContextManager } from "./context-manager.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { DecisionLog } from "./decision-log.js";
import { IntegrationLayer } from "../integrations/integration-layer.js";
import type { DelegationGraph } from "../types/team.js";
import { randomUUID } from "node:crypto";

export interface SessionConfig {
  /** The delegation graph for this session's team. */
  delegationGraph: DelegationGraph;
  /**
   * MCP dispatch function injected from the Claude Code runtime.
   * In Claude Code sessions, this is provided by the MCP client.
   * In test environments, inject a mock.
   */
  mcpDispatch?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Which MCP integrations are enabled for this session. */
  enabledIntegrations?: string[];
  /**
   * Automatic event-to-action rules.
   * When an event of the given type is published with the given severity,
   * the IntegrationLayer automatically dispatches the specified action type.
   */
  autoRules?: AutoRule[];
}

export interface AutoRule {
  /** Event type that triggers this rule. */
  onEvent: string;
  /** Optional condition on the payload. */
  condition?: (payload: unknown) => boolean;
  /** The integration action type to dispatch when the rule fires. */
  dispatchAction: string;
  /** Agent name to attribute the auto-dispatch to. */
  attributedTo: string;
}

/**
 * AgentForge v3 session — owns and cross-wires all infrastructure.
 *
 * Instantiate once per top-level task. Pass the session to agents
 * and the orchestrator via dependency injection.
 *
 * Key wiring (see architecture diagram in synthesis proposal):
 * - HandoffManager.createHandoff → auto-enqueues handoff_complete on MessageBus
 * - IntegrationLayer.dispatch → writes to DecisionLog + KnowledgeStore
 * - MessageBus auto-rules → fire IntegrationLayer dispatches for known event types
 * - ContextManager.assembleTaskContext → reads from DecisionLog + KnowledgeStore
 */
export class AgentForgeSession {
  readonly id: string;
  readonly messageBus: MessageBus;
  readonly handoffManager: HandoffManager;
  readonly delegationManager: DelegationManager;
  readonly contextManager: ContextManager;
  readonly knowledgeStore: KnowledgeStore;
  readonly decisionLog: DecisionLog;
  readonly integrationLayer: IntegrationLayer | null;

  constructor(config: SessionConfig) {
    this.id = randomUUID();

    // Core infrastructure
    this.messageBus = new MessageBus();
    this.knowledgeStore = new KnowledgeStore();
    this.decisionLog = new DecisionLog(this.id);
    this.contextManager = new ContextManager(this.knowledgeStore, this.decisionLog);
    this.handoffManager = new HandoffManager(this.messageBus);
    this.delegationManager = new DelegationManager(config.delegationGraph);

    // Integration layer — optional, only created if mcpDispatch is provided
    this.integrationLayer = config.mcpDispatch
      ? new IntegrationLayer(
          config.mcpDispatch,
          this.contextManager,
          this.decisionLog,
          this.knowledgeStore,
          new Set(config.enabledIntegrations ?? []),
        )
      : null;

    // Wire auto-rules: register event handlers on MessageBus that fire
    // IntegrationLayer dispatches for configured event types
    if (this.integrationLayer && config.autoRules) {
      this.wireAutoRules(config.autoRules);
    }
  }

  private wireAutoRules(rules: AutoRule[]): void {
    const eventTypes = [...new Set(rules.map((r) => r.onEvent))];

    this.messageBus.register("__auto_rules__", eventTypes, async (enqueued) => {
      if (!this.integrationLayer) return;

      const matchingRules = rules.filter(
        (r) =>
          r.onEvent === enqueued.event.type &&
          (!r.condition || r.condition(enqueued.event.payload)),
      );

      for (const rule of matchingRules) {
        // The auto-rule fires but the specific action arguments must be
        // derived from the event payload by a payload-to-action adapter.
        // This is a placeholder for the adapter registry (Milestone 3).
        console.log(
          `[AutoRule] Event "${enqueued.event.type}" triggered action "${rule.dispatchAction}" ` +
          `attributed to "${rule.attributedTo}"`,
        );
      }
    });
  }
}
```

### Updated `HandoffManager` — two lines added

```typescript
// src/orchestrator/handoff-manager.ts
// Add MessageBus parameter and auto-enqueue on createHandoff

import type { MessageBus } from "./message-bus.js";
import type { HandoffCompletePayload } from "../types/events.js";

export class HandoffManager {
  private readonly history: Handoff[] = [];
  private readonly messageBus?: MessageBus;  // NEW

  constructor(messageBus?: MessageBus) {      // NEW
    this.messageBus = messageBus;
  }

  createHandoff(
    from: string,
    to: string,
    artifact: Handoff["artifact"],
    openQuestions: string[],
    constraints: string[],
    status: Handoff["status"],
  ): Handoff {
    const handoff: Handoff = { from, to, artifact, open_questions: openQuestions, constraints, status };
    this.history.push(handoff);

    // NEW: auto-enqueue typed handoff_complete event
    if (this.messageBus) {
      const payload: HandoffCompletePayload = {
        from,
        to,
        artifactType: artifact.type,
        artifactLocation: artifact.location,
        confidence: artifact.confidence,
        openQuestions,
      };
      this.messageBus.enqueue(
        { type: "handoff_complete", source: from, payload, notify: [to] },
        "high",
        { eventType: "handoff_complete", data: payload },
      );
    }

    return handoff;
  }

  // All other methods unchanged
}
```

### Updated `ContextManager` — delegates to `DecisionLog` and `KnowledgeStore`

```typescript
// src/orchestrator/context-manager.ts
// Modified constructor to accept DecisionLog and KnowledgeStore.
// assembleTaskContext() now calls decisionLog.formatForContext()
// instead of the inline decisions loop.
// updateTeamContext() / getTeamContext() delegate to knowledgeStore.

export class ContextManager {
  private fileReader: FileReader | null = null;

  constructor(
    private readonly knowledgeStore: KnowledgeStore,  // NEW — replaces teamContext Map
    private readonly decisionLog: DecisionLog,         // NEW — replaces decisions[]
  ) {}

  assembleTaskContext(agent: AgentTemplate, task: string, options?: AssembleOptions): string {
    const sections: string[] = [];
    const maxFiles = agent.context.max_files;

    sections.push("## Task\n");
    sections.push(task);

    if (this.fileReader) {
      // ... file loading unchanged ...
    }

    // CHANGED: delegate to DecisionLog instead of inline loop
    const decisionsSection = this.decisionLog.formatForContext();
    if (decisionsSection) {
      sections.push("\n" + decisionsSection);
    }

    // NEW: include relevant knowledge store entries
    const knowledge = this.knowledgeStore.summarizeForContext("session");
    const knowledgeKeys = Object.keys(knowledge);
    if (knowledgeKeys.length > 0) {
      sections.push("\n## Shared Knowledge\n");
      for (const [k, v] of Object.entries(knowledge)) {
        sections.push(`- **${k}**: ${JSON.stringify(v)}`);
      }
    }

    return sections.join("\n");
  }

  // CHANGED: delegates to KnowledgeStore
  updateTeamContext(key: string, value: unknown): void {
    this.knowledgeStore.write("session", key, value, "orchestrator");
  }

  getTeamContext(): Record<string, unknown> {
    return this.knowledgeStore.summarizeForContext("session");
  }

  // CHANGED: delegates to DecisionLog
  saveDecision(agent: string, decision: string, rationale: string): void {
    this.decisionLog.record({ agent, decision, rationale });
  }

  getDecisions(): Decision[] {
    return this.decisionLog.getAll().map((e) => ({
      agent: e.agent,
      decision: e.decision,
      rationale: e.rationale,
      timestamp: e.timestamp,
    }));
  }

  setFileReader(reader: FileReader): void {
    this.fileReader = reader;
  }
}
```

### Updated `IntegrationLayer` — writes to `DecisionLog` and `KnowledgeStore`

```typescript
// src/integrations/integration-layer.ts
// Extended constructor signature to include DecisionLog and KnowledgeStore

export class IntegrationLayer {
  constructor(
    private readonly mcpDispatch: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly contextManager: ContextManager,
    private readonly decisionLog: DecisionLog,      // NEW
    private readonly knowledgeStore: KnowledgeStore, // NEW
    private readonly enabledTargets: Set<string>,
  ) {}

  async dispatch(action: IntegrationAction, agentConfig: AgentIntegrationConfig): Promise<IntegrationResult> {
    // ... validation, MCP call unchanged ...

    // On success: record decision AND write entity-scoped knowledge entry
    if (result.success && result.resourceId) {
      const decisionEntry = this.decisionLog.record({
        agent: action.triggeredBy,
        decision: `Dispatched ${action.type}`,
        rationale: result.resourceUrl ? `Created resource at ${result.resourceUrl}` : "Integration action",
        confidence: 1.0,
        tags: [action.type.split(":")[0]],  // "jira", "github", etc.
      });

      // Link external artifact back to the decision
      if (result.resourceUrl) {
        this.decisionLog.linkExternalArtifact(decisionEntry.id, {
          type: action.type,
          url: result.resourceUrl,
          id: result.resourceId,
        });
      }

      // Write entity-scoped knowledge so future agents can find this resource
      this.knowledgeStore.write(
        "session",
        `integration:${action.type}:${result.resourceId}`,
        { url: result.resourceUrl, id: result.resourceId, createdBy: action.triggeredBy },
        action.triggeredBy,
        result.resourceId,
        action.type.split(":")[0],  // entityType: "jira", "github", etc.
      );
    }

    return result;
  }
}
```

### File structure for v3 additions

```
src/
  integrations/
    integration-layer.ts        # MCP dispatch + DecisionLog + KnowledgeStore wiring
  orchestrator/
    event-bus.ts                # UNCHANGED (v2)
    handoff-manager.ts          # +MessageBus auto-enqueue (2 lines)
    delegation-manager.ts       # +KnowledgeStore write on result (2 lines)
    context-manager.ts          # Delegates to DecisionLog + KnowledgeStore
    message-bus.ts              # NEW — priority queue + handler registration
    knowledge-store.ts          # NEW — multi-scope knowledge base
    decision-log.ts             # NEW — persistent typed decision log
    session.ts                  # NEW — AgentForgeSession factory
  scanner/
    integration-detector.ts     # UNCHANGED (v2)
    mcp-config-generator.ts     # NEW — generates .mcp/config.json from IntegrationRef[]
  types/
    orchestration.ts            # TeamEvent.payload typed (backward compatible)
    collaboration.ts            # UNCHANGED
    message.ts                  # UNCHANGED
    agent.ts                    # +integrations?: AgentIntegrationConfig
    integration.ts              # NEW — IntegrationAction, IntegrationResult types
    events.ts                   # NEW — TypedEventPayload discriminated union
    knowledge.ts                # NEW — KnowledgeEntry, KnowledgeQuery types
    decision.ts                 # NEW — DecisionLogEntry type
```

### Migrating the orchestrator — before and after

```typescript
// v2 orchestrator initialization (scattered):
const eventBus = new EventBus();
const handoffManager = new HandoffManager();
const delegationManager = new DelegationManager(graph);
const contextManager = new ContextManager();

// v3 orchestrator initialization (single call):
const session = new AgentForgeSession({
  delegationGraph: graph,
  mcpDispatch: claudeCodeMcpDispatch,   // injected from Claude Code runtime
  enabledIntegrations: ["jira", "github", "slack"],
  autoRules: [
    {
      onEvent: "security_alert",
      condition: (p: any) => p.severity === "critical" || p.severity === "high",
      dispatchAction: "jira:create_issue",
      attributedTo: "security-agent",
    },
    {
      onEvent: "handoff_complete",
      dispatchAction: "slack:post_message",
      attributedTo: "orchestrator",
    },
  ],
});

// Access components via session:
session.messageBus.register("security-agent", ["security_alert"], handler);
session.contextManager.assembleTaskContext(agent, task);
session.decisionLog.record({ agent: "architect", decision: "Use PostgreSQL", rationale: "..." });
session.integrationLayer?.dispatch(jiraAction, agentConfig);
```

## Impact

### Quantified improvements over v2

**External visibility:** Engineering teams currently have zero insight into what AgentForge sessions produce until they read session transcripts. With MCP integration, every significant agent action materializes in Jira/GitHub/Confluence/Slack in real time. A 3-hour planning session that previously required a human to manually create 20 Jira stories now creates them automatically, attributed to the right agent, linked to the right decisions.

**Decision durability:** v2 decisions are lost at session end. v3 `DecisionLog` persists to `.agentforge/decisions/{sessionId}.json`. A new session can load prior decisions and immediately understand constraints the previous session established — enabling true multi-session projects.

**Debugging and auditability:** When an agent makes a wrong decision, the `DecisionLog` with confidence scores and supersession links shows the reasoning chain that led to it. When an external action has unintended consequences, the `KnowledgeStore` entity entries link back to the exact `DecisionLog` entry that triggered it.

**Orchestrator efficiency:** `MessageBus` priority queues mean the orchestrator never processes a low-priority progress update while a high-priority security alert or handoff completion waits. Combined with the cost-aware runner from the previous squad's proposals, this means the right work is done in the right order at the right cost.

**Protocol alignment:** `MessageBus.sendDirect()` mirrors ACP's message injection semantics. `KnowledgeStore` multi-scope design mirrors CrewAI's three-tier memory. `DecisionLog` with external links mirrors LangGraph's checkpointed state. These are not coincidences — they represent where the field has converged on the right abstractions. Aligning v3 with these patterns makes AgentForge templates portable and familiar to practitioners who know these frameworks.

### Breaking changes

None. All new components are additive. `ContextManager`'s public API (`assembleTaskContext`, `updateTeamContext`, `getTeamContext`, `saveDecision`, `getDecisions`, `setFileReader`) is unchanged — the implementation delegates to `DecisionLog` and `KnowledgeStore` internally. `HandoffManager.createHandoff()` signature is unchanged; the `MessageBus` parameter is optional. The `EventBus` is not modified.

Adoption can be incremental: use `AgentForgeSession` to get all v3 features at once, or wire `DecisionLog`/`KnowledgeStore` independently without touching `IntegrationLayer`.

### Recommended implementation order

1. `src/types/events.ts`, `src/types/knowledge.ts`, `src/types/decision.ts` — pure type definitions, no runtime (1-2 hours)
2. `src/orchestrator/decision-log.ts` — replace `decisions[]` in `ContextManager` (2-3 hours)
3. `src/orchestrator/knowledge-store.ts` — replace `teamContext` Map in `ContextManager` (2-3 hours)
4. `src/orchestrator/message-bus.ts` — wrap `EventBus` with handlers and priority queue (3-4 hours)
5. Update `HandoffManager` — 2 lines to enqueue `handoff_complete` (30 minutes)
6. `src/integrations/integration-layer.ts` + `src/types/integration.ts` — MCP dispatch (4-6 hours)
7. `src/scanner/mcp-config-generator.ts` — generate `.mcp/config.json` from scanner output (1-2 hours)
8. `src/orchestrator/session.ts` — `AgentForgeSession` factory wiring everything (2-3 hours)
9. Update orchestrator call sites to use `AgentForgeSession` (1-2 hours per team template)

Total estimated effort: **~20-24 hours of focused engineering**, delivering a fully integrated external tooling + structured communication layer for v3.
