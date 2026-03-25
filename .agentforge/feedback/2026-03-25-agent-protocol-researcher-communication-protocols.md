---
id: b3d8f2a0-5c19-4e73-9b1f-7e2c4a6d1f89
agent: agent-protocol-researcher
category: feature
priority: high
timestamp: "2026-03-25T03:15:00.000Z"
---

# Structured Agent Communication: Knowledge Bases, Decision Logs, and Typed Messaging

## Problem

AgentForge v2 gives agents two ways to communicate: delegation (one agent assigns work to another via `DelegationManager`) and broadcast events (via `EventBus`). Both mechanisms are thin — they carry strings and untyped `payload: unknown` blobs. The problems compound in multi-agent sessions:

1. **EventBus is notify-only, not reactive.** `EventBus.publish()` in `src/orchestrator/event-bus.ts` returns a list of agent names that *should* be notified — but the orchestrator must manually act on that list. There is no handler registration, no delivery guarantee, and no acknowledgement. Events are effectively fire-and-forget strings.

2. **Decision log is ephemeral and local.** `ContextManager.decisions` in `src/orchestrator/context-manager.ts` is an in-memory array. When the session ends, all decisions are lost. There is no persistence, no indexing, and no way for a new session to resume where the previous one left off. The `Decision` interface lacks a unique ID, links to related decisions, or links to the external artifacts the decision produced.

3. **No direct agent-to-agent messaging.** Agents communicate only through the orchestrator as an intermediary. An agent cannot send a typed, priority-bearing message directly to a peer and await a response within the same pipeline step. The `AgentMessage` type in `src/types/message.ts` defines the right shape (`from`, `to`, `type`, `priority`, `context`) but there is no runtime that delivers it.

4. **Shared knowledge is unstructured.** `ContextManager.teamContext` is a `Map<string, unknown>` — useful as a scratchpad but not queryable, not typed, and not versioned. Agents cannot search it, diff it, or subscribe to specific key changes.

5. **No comparison point or interoperability.** v2 was designed in isolation; there is no alignment with emerging agent communication standards (A2A, ACP, LangGraph's message passing, AutoGen's group chat protocol).

## Research

### How other frameworks handle agent communication

**AutoGen (Microsoft):** Uses a `GroupChat` abstraction with a `GroupChatManager` that routes messages between agents. Messages are typed `ChatMessage` objects with `role`, `content`, `name`, and `function_call` fields. Agents can be configured to respond to specific message types or senders. AutoGen's Magentic-One adds a `Ledger` (equivalent to AgentForge's `ProgressLedger`) but persists it across rounds. Key insight: AutoGen separates *conversation* (the chat log) from *state* (the ledger) — v2 conflates both in `ContextManager`.

**LangGraph (LangChain):** Models agent communication as state transitions in a directed graph. Each node is an agent; edges carry typed state objects. The shared state (equivalent to `teamContext`) is a typed `StateGraph` that is diffed and merged after each node runs. State changes are versioned with checkpoints that can be persisted to any backend (SQLite, PostgreSQL, Redis). Key insight: typed state + versioned checkpoints + diff-based merging is what makes large multi-agent graphs debuggable.

**CrewAI:** Agents communicate primarily through task outputs that become inputs to downstream tasks. Direct messaging is supported via `crew.kickoff()` with an `inputs` dict. CrewAI's memory system distinguishes three scopes: short-term (current task), long-term (SQLite-persisted across sessions), and entity memory (facts about named entities). Key insight: multi-scope memory with different persistence backends is the right model for multi-agent knowledge.

**Agent Communication Protocol (ACP, IBM/BeeAI):** An emerging REST-based standard for agent-to-agent messaging. Each agent exposes `POST /runs` (start a run), `GET /runs/{id}` (poll status), `POST /runs/{id}/messages` (inject a message mid-run). Payloads are typed `Message` objects with `role`, `parts` (text, image, file), and `metadata`. Key insight: treating agents as HTTP services with a standard message envelope makes agent networks composable across frameworks and languages.

**Google A2A (Agent-to-Agent Protocol):** Google's proposal (April 2025) for agents to discover each other via `/.well-known/agent.json` cards and communicate via task requests. Uses Server-Sent Events for streaming. Designed for cross-organizational agent federation. Key insight for v3: agent cards (capability declarations) are a useful pattern even within a single AgentForge session — an agent should declare what it can do so the orchestrator can route tasks without hard-coding the delegation graph.

### What the v2 EventBus lacks compared to these systems

| Feature | v2 EventBus | AutoGen GroupChat | LangGraph | ACP |
|---|---|---|---|---|
| Handler registration | No — caller must poll `publish()` result | Yes | Yes (graph edges) | Yes (async HTTP) |
| Delivery guarantee | None | Best-effort in-process | Transactional via checkpoint | At-least-once via HTTP |
| Priority queues | No | No | No | Partial (metadata) |
| Typed payloads | `unknown` | `ChatMessage` | Typed state schema | Typed `Part` union |
| Acknowledgement | No | Implicit (response message) | Transactional | Explicit (run status) |
| Persistence | No | Optional (memory plugin) | Yes (checkpoints) | Yes (run history) |
| Direct peer messaging | No (orchestrator-mediated) | Yes | Yes (node-to-node edges) | Yes (HTTP) |
| Broadcast channels | Partial (`notify: ["*"]`) | Yes (group chat) | No | No |

### What the v2 ContextManager.decisions lacks compared to best-in-class decision logs

The `Decision` interface in `src/orchestrator/context-manager.ts` has `agent`, `decision`, `rationale`, and `timestamp`. It is missing:
- **Unique ID** — decisions cannot be referenced from other decisions or from external artifacts.
- **Supersedes/superseded_by** — no way to know if a decision was overridden later.
- **Confidence** — how certain was the agent when it made this decision? (The `Handoff.artifact.confidence` field exists but is not linked to decisions.)
- **Links to external artifacts** — if a decision triggered a Jira ticket or Confluence page (via the MCP integration layer), there is no link back.
- **Session/run ID** — decisions from different sessions cannot be distinguished.
- **Persistence** — the array is in-memory; a crash or session end loses everything.

## Findings

### Key insights and trade-offs

**Insight 1: Separate conversation from state from decisions.**
v2's `ContextManager` tries to do three things: assemble per-agent context (conversation), hold shared key-value state, and record decisions. These three concerns have different access patterns and should live in separate classes with clear interfaces. Mixing them creates coupling: changing how decisions are persisted requires touching the same class that handles file loading for task context.

**Insight 2: Typed message channels are the missing primitive.**
The `AgentMessage` type in `src/types/message.ts` is well-designed — it has `from`, `to`, `type` (delegate/response/broadcast/review), `priority`, and `context`. But there is no runtime that delivers these messages. Adding a `MessageBus` that wraps `EventBus` with handler registration and typed dispatch would give agents direct peer communication without replacing the existing pub-sub infrastructure.

**Insight 3: Priority queues unlock better orchestrator scheduling.**
When 5 agents each emit an event in the same step, the orchestrator currently processes them in arbitrary order. A priority-aware queue (using `MessagePriority` from `src/types/message.ts`) would let `urgent` security alerts preempt `low` progress updates, preventing the orchestrator from processing a low-priority handoff while a high-priority escalation waits.

**Insight 4: Knowledge bases need three scopes, not one.**
Following CrewAI's model: session-scoped (current run, in-memory), project-scoped (persisted to `.agentforge/knowledge/`, survives session restarts), and entity-scoped (facts about named things — tickets, PRs, team members — queryable by entity name). v2's `teamContext` Map covers only the first scope.

**Trade-off: in-process vs. out-of-process messaging.**
ACP and A2A treat agents as HTTP services — powerful for cross-framework federation but heavy for single-process AgentForge sessions. For v3, the right approach is in-process message delivery (synchronous handler registration, same-process queue) with an optional ACP-compatible adapter for cross-system scenarios. This gives 95% of the value without the operational complexity of running multiple HTTP servers.

**Trade-off: typed payloads vs. `unknown`.**
Strongly typed message payloads (discriminated unions per event type) make the system safe and refactorable but require upfront schema design. The pragmatic approach: define typed payloads for the high-frequency event types (`security_alert`, `architecture_decision`, `handoff_complete`, `integration_action`, `agent_error`) and keep `unknown` as an escape hatch for custom events. TypeScript discriminated unions make this pattern ergonomic.

## Recommendation

Introduce three new components that layer on top of the existing v2 infrastructure without breaking it:

1. **`MessageBus`** — extends `EventBus` with handler registration, typed payloads, priority queuing, and delivery acknowledgement. Replaces manual orchestrator polling of `publish()` results.

2. **`KnowledgeStore`** — a multi-scope knowledge base: session-scoped (in-memory `Map`), project-scoped (JSON files in `.agentforge/knowledge/`), and entity-scoped (indexed by entity name/ID). Replaces the `teamContext` Map in `ContextManager`.

3. **`DecisionLog`** — a richer, persistent append-only record of agent decisions, with IDs, supersession links, confidence scores, and links to external artifacts. Replaces the `decisions` array in `ContextManager`.

The existing `EventBus`, `ContextManager`, `HandoffManager`, and `DelegationManager` are not removed — they remain as the underlying primitives. The new components delegate to them where appropriate.

## Implementation Sketch

```typescript
// src/types/events.ts — NEW FILE
// Typed event payloads for high-frequency TeamEvent types

export interface SecurityAlertPayload {
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  affectedFiles: string[];
  cveId?: string;
}

export interface ArchitectureDecisionPayload {
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  consequences: string[];
}

export interface HandoffCompletePayload {
  from: string;
  to: string;
  artifactType: string;
  artifactLocation: string;
  confidence: number;
  openQuestions: string[];
}

export interface IntegrationActionPayload {
  actionType: string;        // e.g. "jira:create_issue"
  resourceUrl?: string;
  resourceId?: string;
  triggeredBy: string;
}

export interface AgentErrorPayload {
  agentName: string;
  error: string;
  taskDescription: string;
  retryCount: number;
}

/** A discriminated union of all typed event payloads. */
export type TypedEventPayload =
  | { eventType: "security_alert"; data: SecurityAlertPayload }
  | { eventType: "architecture_decision"; data: ArchitectureDecisionPayload }
  | { eventType: "handoff_complete"; data: HandoffCompletePayload }
  | { eventType: "integration_action"; data: IntegrationActionPayload }
  | { eventType: "agent_error"; data: AgentErrorPayload }
  | { eventType: string; data: unknown };  // escape hatch for custom events
```

```typescript
// src/orchestrator/message-bus.ts — NEW FILE

import { randomUUID } from "node:crypto";
import { EventBus } from "./event-bus.js";
import type { TeamEvent } from "../types/orchestration.js";
import type { MessagePriority } from "../types/message.js";
import type { TypedEventPayload } from "../types/events.js";

export type EventHandler = (event: EnqueuedEvent) => void | Promise<void>;

export interface EnqueuedEvent {
  id: string;
  priority: MessagePriority;
  event: TeamEvent;
  typedPayload?: TypedEventPayload;
  enqueuedAt: string;
  /** Set when the event has been processed by all handlers. */
  processedAt?: string;
}

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * MessageBus extends EventBus with:
 * - Handler registration (agents register callbacks, not just subscriptions)
 * - Priority queue (urgent events processed before normal events)
 * - Typed payload dispatch for known event types
 * - Delivery acknowledgement (processedAt timestamp)
 *
 * The underlying EventBus subscription list is used to determine
 * which handlers to invoke for each event.
 */
export class MessageBus {
  private readonly eventBus = new EventBus();
  private readonly handlers = new Map<string, Map<string, EventHandler>>();
  private readonly queue: EnqueuedEvent[] = [];
  private processing = false;

  /**
   * Register an agent as a handler for the given event types.
   * When an event of that type is published, `handler` will be called.
   */
  register(agentName: string, eventTypes: string[], handler: EventHandler): void {
    this.eventBus.subscribe(agentName, eventTypes);
    for (const eventType of eventTypes) {
      if (!this.handlers.has(eventType)) {
        this.handlers.set(eventType, new Map());
      }
      this.handlers.get(eventType)!.set(agentName, handler);
    }
  }

  /**
   * Unregister an agent from all event types.
   */
  unregister(agentName: string): void {
    this.eventBus.unsubscribe(agentName);
    for (const handlerMap of this.handlers.values()) {
      handlerMap.delete(agentName);
    }
  }

  /**
   * Enqueue a typed event. Events are sorted by priority before dispatch.
   * Returns the enqueued event ID.
   */
  enqueue(
    event: TeamEvent,
    priority: MessagePriority = "normal",
    typedPayload?: TypedEventPayload,
  ): string {
    const id = randomUUID();
    const enqueued: EnqueuedEvent = {
      id,
      priority,
      event,
      typedPayload,
      enqueuedAt: new Date().toISOString(),
    };
    this.queue.push(enqueued);
    // Sort queue by priority (stable sort via index as tiebreaker)
    this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    return id;
  }

  /**
   * Process all queued events in priority order.
   * Calls registered handlers for each notified agent.
   * Returns the list of processed event IDs.
   */
  async flush(): Promise<string[]> {
    if (this.processing) return [];
    this.processing = true;
    const processed: string[] = [];

    try {
      while (this.queue.length > 0) {
        const enqueued = this.queue.shift()!;
        const notifiedAgents = this.eventBus.publish(enqueued.event);

        const handlerMap = this.handlers.get(enqueued.event.type);
        if (handlerMap) {
          const handlerPromises = notifiedAgents
            .map((agentName) => handlerMap.get(agentName))
            .filter((h): h is EventHandler => h !== undefined)
            .map((handler) => handler(enqueued));

          await Promise.allSettled(handlerPromises);
        }

        enqueued.processedAt = new Date().toISOString();
        processed.push(enqueued.id);
      }
    } finally {
      this.processing = false;
    }

    return processed;
  }

  /**
   * Publish a high-priority direct message from one agent to another.
   * Bypasses the queue and invokes the target's handler immediately.
   * Equivalent to ACP's "inject message mid-run" semantics.
   */
  async sendDirect(
    from: string,
    to: string,
    eventType: string,
    payload: unknown,
    priority: MessagePriority = "normal",
  ): Promise<void> {
    const event: TeamEvent = { type: eventType, source: from, payload, notify: [to] };
    const enqueued: EnqueuedEvent = {
      id: randomUUID(),
      priority,
      event,
      enqueuedAt: new Date().toISOString(),
    };

    const handlerMap = this.handlers.get(eventType);
    const handler = handlerMap?.get(to);
    if (handler) {
      await handler(enqueued);
      enqueued.processedAt = new Date().toISOString();
    }
  }

  /** Returns all currently queued events (snapshot, not live). */
  peekQueue(): EnqueuedEvent[] {
    return [...this.queue];
  }
}
```

```typescript
// src/types/knowledge.ts — NEW FILE

/** Scope of a knowledge entry. */
export type KnowledgeScope = "session" | "project" | "entity";

export interface KnowledgeEntry<T = unknown> {
  id: string;
  scope: KnowledgeScope;
  key: string;
  value: T;
  /** Agent that wrote this entry. */
  author: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** For entity-scoped entries: the entity this fact describes. */
  entityId?: string;
  entityType?: "jira_issue" | "github_pr" | "confluence_page" | "agent" | string;
}

export interface KnowledgeQuery {
  scope?: KnowledgeScope;
  keyPrefix?: string;
  entityId?: string;
  entityType?: string;
  author?: string;
}
```

```typescript
// src/orchestrator/knowledge-store.ts — NEW FILE

import { randomUUID } from "node:crypto";
import type { KnowledgeEntry, KnowledgeQuery, KnowledgeScope } from "../types/knowledge.js";

/**
 * Multi-scope knowledge base for AgentForge v3.
 *
 * Replaces the flat teamContext Map in ContextManager with a
 * structured, versioned, queryable store.
 *
 * Session scope: in-memory only, lost when session ends.
 * Project scope: persisted to .agentforge/knowledge/ as JSON.
 * Entity scope: indexed by entityId for fast lookup by external resource ID.
 *
 * For v3 initial implementation, all scopes are in-memory.
 * Project-scope persistence (file I/O) is a follow-on.
 */
export class KnowledgeStore {
  private readonly entries = new Map<string, KnowledgeEntry>();
  private readonly entityIndex = new Map<string, Set<string>>(); // entityId → entry IDs

  /**
   * Write a knowledge entry. If an entry with the same scope+key already
   * exists, it is updated with an incremented version number.
   */
  write<T>(
    scope: KnowledgeScope,
    key: string,
    value: T,
    author: string,
    entityId?: string,
    entityType?: string,
  ): KnowledgeEntry<T> {
    const compositeKey = `${scope}::${key}`;
    const existing = this.entries.get(compositeKey) as KnowledgeEntry<T> | undefined;

    const now = new Date().toISOString();
    const entry: KnowledgeEntry<T> = {
      id: existing?.id ?? randomUUID(),
      scope,
      key,
      value,
      author,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      entityId,
      entityType,
    };

    this.entries.set(compositeKey, entry as KnowledgeEntry);

    if (entityId) {
      if (!this.entityIndex.has(entityId)) {
        this.entityIndex.set(entityId, new Set());
      }
      this.entityIndex.get(entityId)!.add(compositeKey);
    }

    return entry;
  }

  /**
   * Read a single entry by scope and key. Returns undefined if not found.
   */
  read<T>(scope: KnowledgeScope, key: string): KnowledgeEntry<T> | undefined {
    return this.entries.get(`${scope}::${key}`) as KnowledgeEntry<T> | undefined;
  }

  /**
   * Query entries by scope, key prefix, entity, or author.
   * All specified filters are ANDed together.
   */
  query(q: KnowledgeQuery): KnowledgeEntry[] {
    let candidates: KnowledgeEntry[];

    if (q.entityId) {
      const keys = this.entityIndex.get(q.entityId) ?? new Set<string>();
      candidates = [...keys].map((k) => this.entries.get(k)!).filter(Boolean);
    } else {
      candidates = [...this.entries.values()];
    }

    return candidates.filter((e) => {
      if (q.scope && e.scope !== q.scope) return false;
      if (q.keyPrefix && !e.key.startsWith(q.keyPrefix)) return false;
      if (q.entityType && e.entityType !== q.entityType) return false;
      if (q.author && e.author !== q.author) return false;
      return true;
    });
  }

  /**
   * Returns a formatted snapshot of session-scoped entries for injection
   * into agent task context. Replaces ContextManager.getTeamContext().
   */
  summarizeForContext(scope: KnowledgeScope = "session"): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const entry of this.entries.values()) {
      if (entry.scope === scope) {
        result[entry.key] = entry.value;
      }
    }
    return result;
  }
}
```

```typescript
// src/types/decision.ts — NEW FILE (extends existing Decision in context-manager.ts)

export interface DecisionLogEntry {
  /** Unique, stable ID for this decision — can be referenced from external artifacts. */
  id: string;
  /** Agent that made the decision. */
  agent: string;
  /** Session or run ID this decision belongs to. */
  sessionId: string;
  /** What was decided. */
  decision: string;
  /** Why it was decided. */
  rationale: string;
  /** How confident the agent was (0-1). */
  confidence: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** ID of a prior decision this supersedes, if any. */
  supersedes?: string;
  /** IDs of decisions made as a consequence of this one. */
  consequences: string[];
  /** Links to external artifacts created as a result (Jira, Confluence, GitHub). */
  externalLinks: Array<{ type: string; url: string; id: string }>;
  /** Tags for filtering (e.g. "architecture", "security", "process"). */
  tags: string[];
}
```

```typescript
// src/orchestrator/decision-log.ts — NEW FILE

import { randomUUID } from "node:crypto";
import type { DecisionLogEntry } from "../types/decision.js";

/**
 * Persistent, queryable decision log for AgentForge v3.
 *
 * Replaces the decisions[] array in ContextManager.
 * Adds unique IDs, supersession links, confidence, external links, and tags.
 *
 * In v3 initial implementation, storage is in-memory with a serialization
 * method for writing to .agentforge/decisions/{sessionId}.json.
 */
export class DecisionLog {
  private readonly entries = new Map<string, DecisionLogEntry>();

  constructor(private readonly sessionId: string) {}

  /**
   * Append a new decision. Returns the created entry.
   */
  record(params: {
    agent: string;
    decision: string;
    rationale: string;
    confidence?: number;
    supersedes?: string;
    tags?: string[];
  }): DecisionLogEntry {
    const entry: DecisionLogEntry = {
      id: randomUUID(),
      agent: params.agent,
      sessionId: this.sessionId,
      decision: params.decision,
      rationale: params.rationale,
      confidence: params.confidence ?? 0.8,
      timestamp: new Date().toISOString(),
      supersedes: params.supersedes,
      consequences: [],
      externalLinks: [],
      tags: params.tags ?? [],
    };

    this.entries.set(entry.id, entry);

    // Update the superseded entry's consequences list
    if (params.supersedes) {
      const prior = this.entries.get(params.supersedes);
      if (prior) {
        prior.consequences.push(entry.id);
      }
    }

    return entry;
  }

  /**
   * Attach an external artifact link to a decision.
   * Called by IntegrationLayer after a successful MCP dispatch.
   */
  linkExternalArtifact(
    decisionId: string,
    artifact: { type: string; url: string; id: string },
  ): void {
    const entry = this.entries.get(decisionId);
    if (entry) {
      entry.externalLinks.push(artifact);
    }
  }

  /**
   * Returns all entries, sorted by timestamp ascending.
   */
  getAll(): DecisionLogEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
  }

  /**
   * Returns a formatted string for injection into agent task context.
   * Replaces the Team Decisions section in ContextManager.assembleTaskContext().
   */
  formatForContext(): string {
    const entries = this.getAll();
    if (entries.length === 0) return "";

    const lines = ["## Team Decisions\n"];
    for (const e of entries) {
      const superseded = e.supersedes ? ` (supersedes ${e.supersedes.slice(0, 8)})` : "";
      const links = e.externalLinks.length > 0
        ? ` [${e.externalLinks.map((l) => l.url).join(", ")}]`
        : "";
      lines.push(
        `- [${e.agent}] ${e.decision}${superseded} — ${e.rationale} (confidence: ${e.confidence.toFixed(2)})${links} (${e.timestamp})`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Serialize all entries to JSON for persistence.
   * Write to .agentforge/decisions/{sessionId}.json
   */
  serialize(): string {
    return JSON.stringify([...this.entries.values()], null, 2);
  }
}
```

```typescript
// Changes to src/orchestrator/context-manager.ts
// The ContextManager.assembleTaskContext() Team Decisions section should
// delegate to DecisionLog.formatForContext() instead of the inline loop.
// The teamContext Map should delegate to KnowledgeStore.summarizeForContext().
// Both are drop-in replacements; the ContextManager interface remains stable.
```

## Impact

**Direct agent-to-agent messaging via `MessageBus.sendDirect()`** eliminates the orchestrator-as-switchboard bottleneck for time-sensitive exchanges. A security scanner agent can alert a code reviewer directly without waiting for the next orchestrator scheduling cycle.

**Priority queues** mean a critical security alert always preempts a low-priority progress update, regardless of which agent emitted it first. This prevents the orchestrator from doing low-value work while a high-severity event waits in queue.

**`KnowledgeStore` with entity scope** means agents can look up "all facts about Jira ticket PROJ-123" in one query, rather than scanning a flat `Map<string, unknown>`. When the MCP integration layer creates external resources, it writes entity-scoped entries; subsequent agents can find them by entity ID rather than guessing key names.

**`DecisionLog` with external links** creates a permanent audit trail that connects in-session decisions to the Jira tickets, Confluence pages, and GitHub PRs they produced. This is the "why" record that engineering organizations actually need — not just what the agents did, but what real-world artifacts resulted from each decision, and which earlier decisions were superseded as the session evolved.

**Alignment with ACP/A2A**: the `MessageBus.sendDirect()` semantics mirror ACP's "inject message mid-run" pattern. When v3 eventually adds cross-framework federation, the `MessageBus` becomes the internal transport and an ACP adapter wraps it externally — no internal restructuring required.

**Backward compatibility**: all three new components (`MessageBus`, `KnowledgeStore`, `DecisionLog`) are additive. The existing `EventBus`, `ContextManager.teamContext`, and `ContextManager.decisions` continue to work unchanged. The orchestrator can migrate call sites incrementally.
