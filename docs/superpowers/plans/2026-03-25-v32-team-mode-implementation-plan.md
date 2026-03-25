# v3.2 Team Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform AgentForge from single-agent invocation to persistent team mode — agents communicate peer-to-peer, Claude Code becomes a thin conduit, autonomy adapts to team composition.

**Architecture:** Extend AgentForgeSession with persistent lifecycle (activate/deactivate/hibernate). Wrap MessageBus with agent addressing for peer-to-peer routing. Add activity feed, smart task routing, and session hibernation across 3 sprints.

**Tech Stack:** TypeScript, Vitest, Commander.js, js-yaml, @anthropic-ai/sdk. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-25-v32-team-mode-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/types/team-mode.ts` | All v3.2 types: lifecycle states, autonomy levels, agent addressing, team mode messages, feed entries, hibernation |
| `src/orchestrator/agent-address-registry.ts` | Maps agent names to bus addresses, validates routing against delegation graph |
| `src/orchestrator/session-lifecycle.ts` | State machine for team mode lifecycle (inactive->active->hibernated) |
| `src/orchestrator/team-mode-bus.ts` | Wraps MessageBus with agent addressing, delegation-validated routing, message type dispatch |
| `src/orchestrator/feed-renderer.ts` | Formats bus messages for CLI display, tiered visibility rules, feed.jsonl persistence |
| `src/orchestrator/team-mode-session.ts` | Persistent multi-task session composing AgentForgeSession + lifecycle + bus + feed |
| `src/orchestrator/autonomy-detector.ts` | Analyzes team composition to determine autonomy level |
| `src/orchestrator/smart-router.ts` | Routes tasks to correct agent, parses @agent syntax, extends TaskComplexityRouter signals |
| `src/orchestrator/cto-framer.ts` | First-task CTO framing: mission decomposition into workstreams |
| `src/orchestrator/session-serializer.ts` | Serialize/deserialize session state for hibernation and resume |
| `src/orchestrator/staleness-detector.ts` | Detect codebase changes since hibernation via git diff |
| `src/cli/commands/activate.ts` | `/agentforge:activate` command — enter team mode |
| `src/cli/commands/deactivate.ts` | `/agentforge:deactivate` command — exit team mode |
| `src/cli/commands/sessions.ts` | `/agentforge:sessions` command — list all sessions |

### Modified Files

| File | Change |
|---|---|
| `src/types/index.ts` | Add team-mode barrel exports |
| `src/cli/index.ts` | Register activate, deactivate, sessions commands |

### Test Files

| File | Covers |
|---|---|
| `tests/orchestrator/agent-address-registry.test.ts` | Address creation, routing validation |
| `tests/orchestrator/session-lifecycle.test.ts` | State transitions, invalid transitions |
| `tests/orchestrator/team-mode-bus.test.ts` | Peer-to-peer routing, delegation validation, message types |
| `tests/orchestrator/feed-renderer.test.ts` | Display formatting, tiered rules, feed.jsonl persistence |
| `tests/orchestrator/team-mode-session.test.ts` | Activation, task dispatch, multi-task, deactivation |
| `tests/orchestrator/autonomy-detector.test.ts` | Full/supervised/guided detection from team composition |
| `tests/orchestrator/smart-router.test.ts` | Task routing, @agent parsing, cost guard |
| `tests/orchestrator/cto-framer.test.ts` | Mission framing, workstream decomposition |
| `tests/orchestrator/session-serializer.test.ts` | Serialize, deserialize, round-trip |
| `tests/orchestrator/staleness-detector.test.ts` | Git diff detection, affected task matching |

---

## Sprint 1 — Activation Core

### Task 1: Team Mode Types

**Files:**
- Create: `src/types/team-mode.ts`
- Modify: `src/types/index.ts`

- [ ] **Step 1: Write the type definitions**

```typescript
// src/types/team-mode.ts
import type { MessagePriority } from "./message.js";
import type { SessionConfig } from "./session.js";
import type { TeamManifest } from "./team.js";
import type { AgentTemplate } from "./agent.js";

// --- Lifecycle ---

export type TeamModeState =
  | "inactive"
  | "activating"
  | "active"
  | "hibernating"
  | "hibernated"
  | "deactivating";

// --- Autonomy ---

export type AutonomyLevel = "full" | "supervised" | "guided";

// --- Addressing ---

export type AddressType = "agent" | "conduit";

export interface AgentAddress {
  type: AddressType;
  name: string;
}

export function createAddress(type: AddressType, name: string): AgentAddress {
  return { type, name };
}

export function formatAddress(address: AgentAddress): string {
  return `${address.type}:${address.name}`;
}

export function parseAddress(raw: string): AgentAddress | null {
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const [type, name] = parts;
  if (type !== "agent" && type !== "conduit") return null;
  if (!name) return null;
  return { type, name };
}

export const USER_CONDUIT: AgentAddress = { type: "conduit", name: "user" };

// --- Messages ---

export type TeamModeMessageType =
  | "task"
  | "result"
  | "escalation"
  | "decision"
  | "status"
  | "direct";

export interface TeamModeMessage {
  id: string;
  from: string;       // formatted address
  to: string;         // formatted address
  type: TeamModeMessageType;
  content: string;
  priority: MessagePriority;
  timestamp: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

// --- Feed ---

export interface FeedEntry {
  timestamp: string;
  source: string;
  target?: string;
  type: TeamModeMessageType;
  summary: string;
  content: string;
  cost?: number;
}

export type FeedDisplayTier = "full" | "oneliner" | "marker" | "silent";

// --- Configuration ---

export interface TeamModeConfig {
  sessionConfig: SessionConfig;
  autonomyLevel?: AutonomyLevel;
  teamManifest: TeamManifest;
  agentTemplates: Map<string, AgentTemplate>;
}

// --- Hibernation ---

export interface HibernatedSession {
  sessionId: string;
  autonomyLevel: AutonomyLevel;
  activatedAt: string;
  hibernatedAt: string;
  inFlightTasks: TeamModeMessage[];
  pendingMessages: TeamModeMessage[];
  costSnapshot: {
    totalSpentUsd: number;
    remainingBudgetUsd: number;
  };
  gitHash: string;
  teamManifestHash: string;
}
```

- [ ] **Step 2: Add barrel exports to types index**

Add to `src/types/index.ts`:

```typescript
// Team Mode (v3.2)
export type {
  TeamModeState,
  AutonomyLevel,
  AddressType,
  AgentAddress,
  TeamModeMessageType,
  TeamModeMessage,
  FeedEntry,
  FeedDisplayTier,
  TeamModeConfig,
  HibernatedSession,
} from "./team-mode.js";
export {
  createAddress,
  formatAddress,
  parseAddress,
  USER_CONDUIT,
} from "./team-mode.js";
```

- [ ] **Step 3: Run build to verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/types/team-mode.ts src/types/index.ts
git commit -m "feat(v3.2): add team mode types — lifecycle, addressing, messages, feed, hibernation"
```

---

### Task 2: Agent Address Registry

**Files:**
- Create: `src/orchestrator/agent-address-registry.ts`
- Test: `tests/orchestrator/agent-address-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/agent-address-registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto", "lead-architect"],
      implementation: ["core-platform-lead", "type-implementer"],
      quality: ["qa-lead"],
      utility: [],
    },
    model_routing: {
      opus: ["cto", "lead-architect"],
      sonnet: ["core-platform-lead", "qa-lead"],
      haiku: ["type-implementer"],
    },
    delegation_graph: {
      cto: ["lead-architect", "core-platform-lead"],
      "lead-architect": ["core-platform-lead"],
      "core-platform-lead": ["type-implementer"],
      "qa-lead": [],
      "type-implementer": [],
    },
    ...overrides,
  };
}

describe("AgentAddressRegistry", () => {
  let registry: AgentAddressRegistry;
  let manifest: TeamManifest;

  beforeEach(() => {
    manifest = makeManifest();
    registry = new AgentAddressRegistry(manifest);
  });

  describe("registration", () => {
    it("should register all agents from manifest", () => {
      expect(registry.hasAgent("cto")).toBe(true);
      expect(registry.hasAgent("lead-architect")).toBe(true);
      expect(registry.hasAgent("core-platform-lead")).toBe(true);
      expect(registry.hasAgent("type-implementer")).toBe(true);
      expect(registry.hasAgent("qa-lead")).toBe(true);
    });

    it("should always have user conduit", () => {
      expect(registry.hasAddress("conduit:user")).toBe(true);
    });

    it("should return false for unknown agents", () => {
      expect(registry.hasAgent("unknown-agent")).toBe(false);
    });

    it("should list all registered agent names", () => {
      const names = registry.getAgentNames();
      expect(names).toHaveLength(5);
      expect(names).toContain("cto");
      expect(names).toContain("type-implementer");
    });
  });

  describe("address resolution", () => {
    it("should resolve agent name to address string", () => {
      expect(registry.resolve("cto")).toBe("agent:cto");
    });

    it("should return null for unknown agent", () => {
      expect(registry.resolve("nonexistent")).toBeNull();
    });
  });

  describe("routing validation", () => {
    it("should allow delegation from parent to child", () => {
      expect(registry.canRoute("cto", "lead-architect")).toBe(true);
      expect(registry.canRoute("cto", "core-platform-lead")).toBe(true);
    });

    it("should reject delegation not in graph", () => {
      expect(registry.canRoute("type-implementer", "cto")).toBe(false);
    });

    it("should always allow routing from user conduit to any agent", () => {
      expect(registry.canRouteFromUser("cto")).toBe(true);
      expect(registry.canRouteFromUser("type-implementer")).toBe(true);
    });

    it("should always allow routing from any agent to user conduit", () => {
      expect(registry.canRouteToUser("cto")).toBe(true);
    });

    it("should allow peer collaboration when agents share a parent", () => {
      // lead-architect and core-platform-lead both report to cto
      expect(registry.canRoute("lead-architect", "core-platform-lead")).toBe(true);
    });
  });

  describe("model tier lookup", () => {
    it("should return correct model tier for agent", () => {
      expect(registry.getModelTier("cto")).toBe("opus");
      expect(registry.getModelTier("core-platform-lead")).toBe("sonnet");
      expect(registry.getModelTier("type-implementer")).toBe("haiku");
    });

    it("should return null for unknown agent", () => {
      expect(registry.getModelTier("nonexistent")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/agent-address-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/agent-address-registry.ts
import type { TeamManifest, DelegationGraph, ModelRouting } from "../types/team.js";
import type { ModelTier } from "../types/agent.js";

export class AgentAddressRegistry {
  private agents: Set<string>;
  private delegationGraph: DelegationGraph;
  private modelRouting: ModelRouting;
  private peerGroups: Map<string, Set<string>>;

  constructor(manifest: TeamManifest) {
    this.agents = new Set<string>();
    this.delegationGraph = manifest.delegation_graph;
    this.modelRouting = manifest.model_routing;
    this.peerGroups = new Map();

    // Register all agents from all categories
    for (const agents of Object.values(manifest.agents)) {
      for (const agent of agents) {
        this.agents.add(agent);
      }
    }

    // Build peer groups — agents that share a parent can collaborate
    for (const [, children] of Object.entries(this.delegationGraph)) {
      const group = new Set(children);
      for (const child of children) {
        const existing = this.peerGroups.get(child) ?? new Set();
        for (const peer of group) {
          if (peer !== child) existing.add(peer);
        }
        this.peerGroups.set(child, existing);
      }
    }
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  hasAddress(address: string): boolean {
    if (address === "conduit:user") return true;
    const parts = address.split(":");
    if (parts.length !== 2 || parts[0] !== "agent") return false;
    return this.agents.has(parts[1]);
  }

  resolve(agentName: string): string | null {
    if (!this.agents.has(agentName)) return null;
    return `agent:${agentName}`;
  }

  getAgentNames(): string[] {
    return Array.from(this.agents);
  }

  canRoute(fromAgent: string, toAgent: string): boolean {
    // Direct delegation graph edge
    const delegates = this.delegationGraph[fromAgent];
    if (delegates?.includes(toAgent)) return true;

    // Reverse: child can send results back to parent
    const parentDelegates = this.delegationGraph[toAgent];
    if (parentDelegates?.includes(fromAgent)) return true;

    // Peer collaboration: agents sharing a parent
    const peers = this.peerGroups.get(fromAgent);
    if (peers?.has(toAgent)) return true;

    return false;
  }

  canRouteFromUser(toAgent: string): boolean {
    return this.agents.has(toAgent);
  }

  canRouteToUser(fromAgent: string): boolean {
    return this.agents.has(fromAgent);
  }

  getModelTier(agentName: string): ModelTier | null {
    if (this.modelRouting.opus.includes(agentName)) return "opus";
    if (this.modelRouting.sonnet.includes(agentName)) return "sonnet";
    if (this.modelRouting.haiku.includes(agentName)) return "haiku";
    return null;
  }

  getOpusAgents(): string[] {
    return this.modelRouting.opus.filter((a) => this.agents.has(a));
  }

  getSonnetAgents(): string[] {
    return this.modelRouting.sonnet.filter((a) => this.agents.has(a));
  }

  getHaikuAgents(): string[] {
    return this.modelRouting.haiku.filter((a) => this.agents.has(a));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/agent-address-registry.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/agent-address-registry.ts tests/orchestrator/agent-address-registry.test.ts
git commit -m "feat(v3.2): add AgentAddressRegistry — agent addressing and routing validation"
```

---

### Task 3: Session Lifecycle State Machine

**Files:**
- Create: `src/orchestrator/session-lifecycle.ts`
- Test: `tests/orchestrator/session-lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/session-lifecycle.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionLifecycle } from "../../src/orchestrator/session-lifecycle.js";
import type { TeamModeState } from "../../src/types/team-mode.js";

describe("SessionLifecycle", () => {
  let lifecycle: SessionLifecycle;

  beforeEach(() => {
    lifecycle = new SessionLifecycle();
  });

  describe("initial state", () => {
    it("should start as inactive", () => {
      expect(lifecycle.getState()).toBe("inactive");
    });
  });

  describe("valid transitions", () => {
    it("should transition inactive -> activating", () => {
      lifecycle.transition("activating");
      expect(lifecycle.getState()).toBe("activating");
    });

    it("should transition activating -> active", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      expect(lifecycle.getState()).toBe("active");
    });

    it("should transition active -> hibernating", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      expect(lifecycle.getState()).toBe("hibernating");
    });

    it("should transition hibernating -> hibernated", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      expect(lifecycle.getState()).toBe("hibernated");
    });

    it("should transition active -> deactivating", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("deactivating");
      expect(lifecycle.getState()).toBe("deactivating");
    });

    it("should transition deactivating -> inactive", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("deactivating");
      lifecycle.transition("inactive");
      expect(lifecycle.getState()).toBe("inactive");
    });

    it("should transition hibernated -> activating for resume", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      lifecycle.transition("activating");
      expect(lifecycle.getState()).toBe("activating");
    });
  });

  describe("invalid transitions", () => {
    it("should throw on inactive -> active (must go through activating)", () => {
      expect(() => lifecycle.transition("active")).toThrow();
    });

    it("should throw on active -> inactive (must go through deactivating)", () => {
      lifecycle.transition("activating");
      lifecycle.transition("active");
      expect(() => lifecycle.transition("inactive")).toThrow();
    });

    it("should throw on activating -> hibernated", () => {
      lifecycle.transition("activating");
      expect(() => lifecycle.transition("hibernated")).toThrow();
    });
  });

  describe("queries", () => {
    it("should report isActive correctly", () => {
      expect(lifecycle.isActive()).toBe(false);
      lifecycle.transition("activating");
      expect(lifecycle.isActive()).toBe(false);
      lifecycle.transition("active");
      expect(lifecycle.isActive()).toBe(true);
    });

    it("should report isHibernated correctly", () => {
      expect(lifecycle.isHibernated()).toBe(false);
      lifecycle.transition("activating");
      lifecycle.transition("active");
      lifecycle.transition("hibernating");
      lifecycle.transition("hibernated");
      expect(lifecycle.isHibernated()).toBe(true);
    });

    it("should report canAcceptTasks only when active", () => {
      expect(lifecycle.canAcceptTasks()).toBe(false);
      lifecycle.transition("activating");
      expect(lifecycle.canAcceptTasks()).toBe(false);
      lifecycle.transition("active");
      expect(lifecycle.canAcceptTasks()).toBe(true);
    });
  });

  describe("listeners", () => {
    it("should notify on transition", () => {
      const transitions: Array<{ from: TeamModeState; to: TeamModeState }> = [];
      lifecycle.onTransition((from, to) => transitions.push({ from, to }));

      lifecycle.transition("activating");
      lifecycle.transition("active");

      expect(transitions).toEqual([
        { from: "inactive", to: "activating" },
        { from: "activating", to: "active" },
      ]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/session-lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/session-lifecycle.ts
import type { TeamModeState } from "../types/team-mode.js";

type TransitionListener = (from: TeamModeState, to: TeamModeState) => void;

const VALID_TRANSITIONS: Record<TeamModeState, TeamModeState[]> = {
  inactive: ["activating"],
  activating: ["active"],
  active: ["hibernating", "deactivating"],
  hibernating: ["hibernated"],
  hibernated: ["activating"],
  deactivating: ["inactive"],
};

export class SessionLifecycle {
  private state: TeamModeState = "inactive";
  private listeners: TransitionListener[] = [];

  getState(): TeamModeState {
    return this.state;
  }

  transition(to: TeamModeState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid lifecycle transition: ${this.state} -> ${to}. Allowed: ${allowed.join(", ")}`
      );
    }
    const from = this.state;
    this.state = to;
    for (const listener of this.listeners) {
      listener(from, to);
    }
  }

  isActive(): boolean {
    return this.state === "active";
  }

  isHibernated(): boolean {
    return this.state === "hibernated";
  }

  canAcceptTasks(): boolean {
    return this.state === "active";
  }

  onTransition(listener: TransitionListener): void {
    this.listeners.push(listener);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/session-lifecycle.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/session-lifecycle.ts tests/orchestrator/session-lifecycle.test.ts
git commit -m "feat(v3.2): add SessionLifecycle state machine — valid transitions, listeners, queries"
```

---

### Task 4: Team Mode Bus

**Files:**
- Create: `src/orchestrator/team-mode-bus.ts`
- Test: `tests/orchestrator/team-mode-bus.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/team-mode-bus.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TeamModeBus } from "../../src/orchestrator/team-mode-bus.js";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { TeamModeMessage } from "../../src/types/team-mode.js";

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead", "coder-a"],
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: ["cto"],
      sonnet: ["core-lead"],
      haiku: ["coder-a"],
    },
    delegation_graph: {
      cto: ["core-lead"],
      "core-lead": ["coder-a"],
      "coder-a": [],
    },
  };
}

describe("TeamModeBus", () => {
  let bus: TeamModeBus;
  let registry: AgentAddressRegistry;

  beforeEach(() => {
    registry = new AgentAddressRegistry(makeManifest());
    bus = new TeamModeBus(registry);
  });

  describe("send", () => {
    it("should accept valid agent-to-agent message", () => {
      const msg = bus.send({
        from: "agent:cto",
        to: "agent:core-lead",
        type: "task",
        content: "Design the type system",
        priority: "normal",
      });

      expect(msg.id).toBeDefined();
      expect(msg.from).toBe("agent:cto");
      expect(msg.to).toBe("agent:core-lead");
      expect(msg.timestamp).toBeDefined();
    });

    it("should accept user-to-agent message", () => {
      const msg = bus.send({
        from: "conduit:user",
        to: "agent:cto",
        type: "task",
        content: "Build the auth module",
        priority: "normal",
      });

      expect(msg.from).toBe("conduit:user");
    });

    it("should accept agent-to-user message", () => {
      const msg = bus.send({
        from: "agent:cto",
        to: "conduit:user",
        type: "result",
        content: "Auth module complete",
        priority: "normal",
      });

      expect(msg.to).toBe("conduit:user");
    });

    it("should reject message with invalid from address", () => {
      expect(() =>
        bus.send({
          from: "agent:nonexistent",
          to: "agent:cto",
          type: "task",
          content: "test",
          priority: "normal",
        })
      ).toThrow("Unknown sender");
    });

    it("should reject message with invalid to address", () => {
      expect(() =>
        bus.send({
          from: "agent:cto",
          to: "agent:nonexistent",
          type: "task",
          content: "test",
          priority: "normal",
        })
      ).toThrow("Unknown recipient");
    });

    it("should reject routing not allowed by delegation graph", () => {
      expect(() =>
        bus.send({
          from: "agent:coder-a",
          to: "agent:cto",
          type: "task",
          content: "I'm giving the CTO a task",
          priority: "normal",
        })
      ).toThrow("not allowed");
    });
  });

  describe("subscribe", () => {
    it("should deliver messages to subscriber", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:core-lead", (msg) => received.push(msg));

      bus.send({
        from: "agent:cto",
        to: "agent:core-lead",
        type: "task",
        content: "Do the thing",
        priority: "normal",
      });

      // Non-urgent messages are queued, drain to deliver
      bus.drain();
      expect(received).toHaveLength(1);
      expect(received[0].content).toBe("Do the thing");
    });

    it("should not deliver messages to non-target", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:coder-a", (msg) => received.push(msg));

      bus.send({
        from: "agent:cto",
        to: "agent:core-lead",
        type: "task",
        content: "Not for coder-a",
        priority: "normal",
      });

      bus.drain();
      expect(received).toHaveLength(0);
    });
  });

  describe("onAnyMessage", () => {
    it("should fire for every message sent", () => {
      const all: TeamModeMessage[] = [];
      bus.onAnyMessage((msg) => all.push(msg));

      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "a", priority: "normal" });
      bus.send({ from: "agent:core-lead", to: "agent:coder-a", type: "task", content: "b", priority: "normal" });

      expect(all).toHaveLength(2);
    });
  });

  describe("queue and drain", () => {
    it("should queue non-urgent messages", () => {
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "queued", priority: "normal" });
      expect(bus.getPendingCount()).toBe(1);
    });

    it("should process urgent messages immediately", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:core-lead", (msg) => received.push(msg));

      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "escalation", content: "urgent", priority: "urgent" });

      expect(received).toHaveLength(1);
      expect(bus.getPendingCount()).toBe(0);
    });

    it("should drain queued messages in priority order", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:core-lead", (msg) => received.push(msg));

      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "low", priority: "low" });
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "high", priority: "high" });
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "normal", priority: "normal" });

      bus.drain();

      expect(received.map((m) => m.content)).toEqual(["high", "normal", "low"]);
    });
  });

  describe("getHistory", () => {
    it("should return all sent messages", () => {
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "a", priority: "normal" });
      bus.send({ from: "agent:core-lead", to: "agent:coder-a", type: "task", content: "b", priority: "normal" });

      const history = bus.getHistory();
      expect(history).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/team-mode-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/team-mode-bus.ts
import { randomUUID } from "node:crypto";
import type { AgentAddressRegistry } from "./agent-address-registry.js";
import type {
  TeamModeMessage,
  TeamModeMessageType,
} from "../types/team-mode.js";
import type { MessagePriority } from "../types/message.js";

interface SendOptions {
  from: string;
  to: string;
  type: TeamModeMessageType;
  content: string;
  priority: MessagePriority;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

type MessageHandler = (message: TeamModeMessage) => void;

interface QueuedMessage {
  message: TeamModeMessage;
  priority: number;
}

const PRIORITY_RANK: Record<MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class TeamModeBus {
  private registry: AgentAddressRegistry;
  private subscribers: Map<string, MessageHandler[]> = new Map();
  private globalListeners: MessageHandler[] = [];
  private queue: QueuedMessage[] = [];
  private history: TeamModeMessage[] = [];

  constructor(registry: AgentAddressRegistry) {
    this.registry = registry;
  }

  send(options: SendOptions): TeamModeMessage {
    // Validate addresses
    if (!this.registry.hasAddress(options.from)) {
      throw new Error(`Unknown sender: ${options.from}`);
    }
    if (!this.registry.hasAddress(options.to)) {
      throw new Error(`Unknown recipient: ${options.to}`);
    }

    // Validate routing
    this.validateRouting(options.from, options.to);

    const message: TeamModeMessage = {
      id: randomUUID(),
      from: options.from,
      to: options.to,
      type: options.type,
      content: options.content,
      priority: options.priority,
      timestamp: new Date().toISOString(),
      replyTo: options.replyTo,
      metadata: options.metadata,
    };

    this.history.push(message);

    // Notify global listeners
    for (const listener of this.globalListeners) {
      listener(message);
    }

    // Urgent messages are delivered immediately
    if (options.priority === "urgent") {
      this.deliver(message);
    } else {
      this.queue.push({
        message,
        priority: PRIORITY_RANK[options.priority],
      });
    }

    return message;
  }

  subscribe(address: string, handler: MessageHandler): void {
    const handlers = this.subscribers.get(address) ?? [];
    handlers.push(handler);
    this.subscribers.set(address, handlers);
  }

  onAnyMessage(handler: MessageHandler): void {
    this.globalListeners.push(handler);
  }

  drain(): void {
    // Sort by priority (lower number = higher priority), stable within same priority
    this.queue.sort((a, b) => a.priority - b.priority);

    const toProcess = [...this.queue];
    this.queue = [];

    for (const { message } of toProcess) {
      this.deliver(message);
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getHistory(): TeamModeMessage[] {
    return [...this.history];
  }

  private deliver(message: TeamModeMessage): void {
    const handlers = this.subscribers.get(message.to) ?? [];
    for (const handler of handlers) {
      handler(message);
    }
  }

  private validateRouting(from: string, to: string): void {
    // User conduit can send to any agent and vice versa
    if (from === "conduit:user" || to === "conduit:user") return;

    const fromName = from.split(":")[1];
    const toName = to.split(":")[1];

    if (!this.registry.canRoute(fromName, toName)) {
      throw new Error(
        `Routing from ${from} to ${to} not allowed by delegation graph`
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/team-mode-bus.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/team-mode-bus.ts tests/orchestrator/team-mode-bus.test.ts
git commit -m "feat(v3.2): add TeamModeBus — peer-to-peer messaging with delegation validation"
```

---

### Task 5: Basic Feed Renderer

**Files:**
- Create: `src/orchestrator/feed-renderer.ts`
- Test: `tests/orchestrator/feed-renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/feed-renderer.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { FeedRenderer } from "../../src/orchestrator/feed-renderer.js";
import type { TeamModeMessage } from "../../src/types/team-mode.js";

function makeMessage(overrides: Partial<TeamModeMessage> = {}): TeamModeMessage {
  return {
    id: "msg-001",
    from: "agent:cto",
    to: "agent:core-lead",
    type: "task",
    content: "Build the auth module",
    priority: "normal",
    timestamp: "2026-03-25T15:00:00Z",
    ...overrides,
  };
}

describe("FeedRenderer", () => {
  let renderer: FeedRenderer;

  beforeEach(() => {
    renderer = new FeedRenderer();
  });

  describe("formatMessage", () => {
    it("should format a task message", () => {
      const msg = makeMessage({ type: "task" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("cto");
      expect(line).toContain("core-lead");
      expect(line).toContain("Build the auth module");
    });

    it("should format a decision message", () => {
      const msg = makeMessage({ type: "decision", content: "Use JWT for auth" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("decision");
      expect(line).toContain("Use JWT for auth");
    });

    it("should format a result message with checkmark", () => {
      const msg = makeMessage({
        type: "result",
        from: "agent:coder-a",
        to: "agent:core-lead",
        content: "Implementation complete",
      });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("coder-a");
    });

    it("should format an escalation message", () => {
      const msg = makeMessage({
        type: "escalation",
        from: "agent:core-lead",
        to: "agent:cto",
        content: "Need architectural guidance",
      });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("escalation");
    });

    it("should format a status message", () => {
      const msg = makeMessage({
        type: "status",
        from: "agent:coder-a",
        to: "conduit:user",
        content: "50% through implementation",
      });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("coder-a");
    });
  });

  describe("toFeedEntry", () => {
    it("should convert message to feed entry", () => {
      const msg = makeMessage();
      const entry = renderer.toFeedEntry(msg);

      expect(entry.source).toBe("agent:cto");
      expect(entry.target).toBe("agent:core-lead");
      expect(entry.type).toBe("task");
      expect(entry.summary).toBeDefined();
      expect(entry.content).toBe("Build the auth module");
      expect(entry.timestamp).toBe("2026-03-25T15:00:00Z");
    });
  });

  describe("feed accumulation", () => {
    it("should accumulate entries", () => {
      renderer.addMessage(makeMessage({ id: "1" }));
      renderer.addMessage(makeMessage({ id: "2" }));

      expect(renderer.getEntries()).toHaveLength(2);
    });

    it("should return entries in order", () => {
      renderer.addMessage(makeMessage({ id: "1", timestamp: "2026-03-25T15:00:00Z" }));
      renderer.addMessage(makeMessage({ id: "2", timestamp: "2026-03-25T15:01:00Z" }));

      const entries = renderer.getEntries();
      expect(entries[0].timestamp).toBe("2026-03-25T15:00:00Z");
      expect(entries[1].timestamp).toBe("2026-03-25T15:01:00Z");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/feed-renderer.ts
import type {
  TeamModeMessage,
  FeedEntry,
  FeedDisplayTier,
} from "../types/team-mode.js";

function agentName(address: string): string {
  return address.split(":")[1] ?? address;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export class FeedRenderer {
  private entries: FeedEntry[] = [];

  formatMessage(message: TeamModeMessage): string {
    const from = agentName(message.from);
    const to = agentName(message.to);
    const summary = truncate(message.content, 80);

    switch (message.type) {
      case "task":
        return `[${from} -> ${to}]  task: ${summary}`;
      case "result":
        return `[${from}]  completed: ${summary}`;
      case "escalation":
        return `[${from} -> ${to}]  escalation: ${summary}`;
      case "decision":
        return `[${from} -> ${to}]  decision: ${summary}`;
      case "status":
        return `[${from}]  ${summary}`;
      case "direct":
        return `[${from} -> ${to}]  ${summary}`;
      default:
        return `[${from}]  ${summary}`;
    }
  }

  toFeedEntry(message: TeamModeMessage): FeedEntry {
    return {
      timestamp: message.timestamp,
      source: message.from,
      target: message.to,
      type: message.type,
      summary: truncate(message.content, 120),
      content: message.content,
    };
  }

  addMessage(message: TeamModeMessage): FeedEntry {
    const entry = this.toFeedEntry(message);
    this.entries.push(entry);
    return entry;
  }

  getEntries(): FeedEntry[] {
    return [...this.entries];
  }

  getRecentEntries(count: number): FeedEntry[] {
    return this.entries.slice(-count);
  }

  clear(): void {
    this.entries = [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/feed-renderer.ts tests/orchestrator/feed-renderer.test.ts
git commit -m "feat(v3.2): add FeedRenderer — format messages for CLI feed display"
```

---

### Task 6: Team Mode Session

**Files:**
- Create: `src/orchestrator/team-mode-session.ts`
- Test: `tests/orchestrator/team-mode-session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/team-mode-session.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { TeamModeSession } from "../../src/orchestrator/team-mode-session.js";
import type { TeamModeConfig } from "../../src/types/team-mode.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { AgentTemplate } from "../../src/types/agent.js";

vi.mock("../../src/api/client.js", () => ({
  createClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Mock response" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  }),
  MODEL_MAP: {
    opus: "claude-opus-4-20250514",
    sonnet: "claude-sonnet-4-20250514",
    haiku: "claude-haiku-4-5-20251001",
  },
  MODEL_DEFAULTS: {
    opus: { maxTokens: 4096, temperature: 0.7 },
    sonnet: { maxTokens: 4096, temperature: 0.5 },
    haiku: { maxTokens: 2048, temperature: 0.3 },
  },
  MODEL_EFFORT_DEFAULTS: { opus: "high", sonnet: "medium", haiku: "low" },
  sendMessage: vi.fn().mockResolvedValue({
    content: "Mock response",
    inputTokens: 100,
    outputTokens: 50,
  }),
}));

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead", "coder-a"],
      quality: [],
      utility: [],
    },
    model_routing: {
      opus: ["cto"],
      sonnet: ["core-lead"],
      haiku: ["coder-a"],
    },
    delegation_graph: {
      cto: ["core-lead"],
      "core-lead": ["coder-a"],
      "coder-a": [],
    },
  };
}

function makeAgent(name: string, model: "opus" | "sonnet" | "haiku" = "haiku"): AgentTemplate {
  return {
    name,
    model,
    version: "1.0.0",
    description: `${name} agent`,
    system_prompt: `You are ${name}`,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: { reports_to: null, reviews_from: [], can_delegate_to: [], parallel: false },
    context: { max_files: 10, auto_include: [], project_specific: [] },
  };
}

describe("TeamModeSession", () => {
  let tmpDir: string;
  let config: TeamModeConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "team-mode-test-"));
    const manifest = makeManifest();
    const templates = new Map<string, AgentTemplate>();
    templates.set("cto", makeAgent("cto", "opus"));
    templates.set("core-lead", makeAgent("core-lead", "sonnet"));
    templates.set("coder-a", makeAgent("coder-a", "haiku"));

    config = {
      sessionConfig: {
        projectRoot: tmpDir,
        sessionBudgetUsd: 10.0,
        enableReforge: false,
        enableCostAwareRouting: true,
        enableReviewEnforcement: false,
      },
      teamManifest: manifest,
      agentTemplates: templates,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("activation", () => {
    it("should start inactive", () => {
      const session = new TeamModeSession(config);
      expect(session.getState()).toBe("inactive");
    });

    it("should activate and transition to active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(session.getState()).toBe("active");
    });

    it("should throw if already active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      await expect(session.activate()).rejects.toThrow();
    });

    it("should have a session ID after activation", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(session.getSessionId()).toBeDefined();
    });
  });

  describe("deactivation", () => {
    it("should deactivate and transition to inactive", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      await session.deactivate();
      expect(session.getState()).toBe("inactive");
    });

    it("should throw if not active", async () => {
      const session = new TeamModeSession(config);
      await expect(session.deactivate()).rejects.toThrow();
    });
  });

  describe("task submission", () => {
    it("should accept a task when active", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const msg = session.submitTask("Build the auth module");
      expect(msg.type).toBe("task");
      expect(msg.from).toBe("conduit:user");
    });

    it("should reject task when not active", () => {
      const session = new TeamModeSession(config);
      expect(() => session.submitTask("test")).toThrow();
    });
  });

  describe("direct message", () => {
    it("should send direct message to named agent", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const msg = session.sendDirect("cto", "What's the plan?");
      expect(msg.type).toBe("direct");
      expect(msg.to).toBe("agent:cto");
    });

    it("should reject direct message to unknown agent", async () => {
      const session = new TeamModeSession(config);
      await session.activate();
      expect(() => session.sendDirect("nonexistent", "hello")).toThrow();
    });
  });

  describe("feed", () => {
    it("should accumulate feed entries from messages", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      session.submitTask("Task 1");
      session.submitTask("Task 2");

      const entries = session.getFeedEntries();
      expect(entries).toHaveLength(2);
    });
  });

  describe("agent registry", () => {
    it("should expose registered agent names", async () => {
      const session = new TeamModeSession(config);
      await session.activate();

      const names = session.getAgentNames();
      expect(names).toContain("cto");
      expect(names).toContain("core-lead");
      expect(names).toContain("coder-a");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/team-mode-session.ts
import { randomUUID } from "node:crypto";
import { AgentAddressRegistry } from "./agent-address-registry.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { TeamModeBus } from "./team-mode-bus.js";
import { FeedRenderer } from "./feed-renderer.js";
import { AgentForgeSession } from "./session.js";
import type {
  TeamModeConfig,
  TeamModeState,
  TeamModeMessage,
  FeedEntry,
  AutonomyLevel,
} from "../types/team-mode.js";

export class TeamModeSession {
  private config: TeamModeConfig;
  private lifecycle: SessionLifecycle;
  private registry: AgentAddressRegistry | null = null;
  private bus: TeamModeBus | null = null;
  private feed: FeedRenderer;
  private innerSession: AgentForgeSession | null = null;
  private sessionId: string;
  private autonomyLevel: AutonomyLevel = "guided";
  private activatedAt: string | null = null;

  constructor(config: TeamModeConfig) {
    this.config = config;
    this.lifecycle = new SessionLifecycle();
    this.feed = new FeedRenderer();
    this.sessionId = randomUUID();
  }

  async activate(overrideAutonomy?: AutonomyLevel): Promise<void> {
    if (this.lifecycle.getState() !== "inactive" && this.lifecycle.getState() !== "hibernated") {
      throw new Error(`Cannot activate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("activating");

    // Build registry from manifest
    this.registry = new AgentAddressRegistry(this.config.teamManifest);

    // Create bus with addressing
    this.bus = new TeamModeBus(this.registry);

    // Wire feed to bus
    this.bus.onAnyMessage((msg) => {
      this.feed.addMessage(msg);
    });

    // Create inner session for agent execution
    this.innerSession = await AgentForgeSession.create(this.config.sessionConfig);

    // Set autonomy level
    this.autonomyLevel = overrideAutonomy ?? this.detectAutonomy();

    this.activatedAt = new Date().toISOString();
    this.lifecycle.transition("active");
  }

  async deactivate(): Promise<void> {
    if (!this.lifecycle.isActive()) {
      throw new Error(`Cannot deactivate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("deactivating");

    // End inner session
    if (this.innerSession) {
      await this.innerSession.end();
      this.innerSession = null;
    }

    this.lifecycle.transition("inactive");
  }

  submitTask(taskContent: string): TeamModeMessage {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot accept tasks");
    }

    return this.bus!.send({
      from: "conduit:user",
      to: "agent:cto",
      type: "task",
      content: taskContent,
      priority: "normal",
    });
  }

  sendDirect(agentName: string, content: string): TeamModeMessage {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot send messages");
    }

    const address = this.registry!.resolve(agentName);
    if (!address) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    return this.bus!.send({
      from: "conduit:user",
      to: address,
      type: "direct",
      content,
      priority: "normal",
    });
  }

  getState(): TeamModeState {
    return this.lifecycle.getState();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getAutonomyLevel(): AutonomyLevel {
    return this.autonomyLevel;
  }

  getFeedEntries(): FeedEntry[] {
    return this.feed.getEntries();
  }

  getRecentFeed(count: number): FeedEntry[] {
    return this.feed.getRecentEntries(count);
  }

  formatFeedEntry(message: TeamModeMessage): string {
    return this.feed.formatMessage(message);
  }

  getAgentNames(): string[] {
    return this.registry?.getAgentNames() ?? [];
  }

  getBus(): TeamModeBus | null {
    return this.bus;
  }

  getRegistry(): AgentAddressRegistry | null {
    return this.registry;
  }

  getInnerSession(): AgentForgeSession | null {
    return this.innerSession;
  }

  getActivatedAt(): string | null {
    return this.activatedAt;
  }

  private detectAutonomy(): AutonomyLevel {
    if (!this.registry) return "guided";

    const opusAgents = this.registry.getOpusAgents();
    if (opusAgents.length > 0) return "full";

    const sonnetAgents = this.registry.getSonnetAgents();
    if (sonnetAgents.length > 0) return "supervised";

    return "guided";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/team-mode-session.ts tests/orchestrator/team-mode-session.test.ts
git commit -m "feat(v3.2): add TeamModeSession — persistent multi-task session with lifecycle and feed"
```

---

### Task 7: Activate & Deactivate CLI Commands

**Files:**
- Create: `src/cli/commands/activate.ts`
- Create: `src/cli/commands/deactivate.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write the activate command**

```typescript
// src/cli/commands/activate.ts
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { TeamModeSession } from "../../orchestrator/team-mode-session.js";
import type { TeamModeConfig, AutonomyLevel } from "../../types/team-mode.js";
import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";

// Module-level reference so deactivate can access the active session
let activeSession: TeamModeSession | null = null;

export function getActiveSession(): TeamModeSession | null {
  return activeSession;
}

async function activateAction(options: {
  mode?: string;
  budget?: string;
}): Promise<void> {
  try {
    if (activeSession?.getState() === "active") {
      console.error("Team mode is already active. Run `deactivate` first.");
      process.exitCode = 1;
      return;
    }

    const projectRoot = process.cwd();
    const teamPath = path.join(projectRoot, ".agentforge", "team.yaml");

    // Load team manifest
    let manifest: TeamManifest;
    try {
      const raw = await fs.readFile(teamPath, "utf-8");
      manifest = yaml.load(raw) as TeamManifest;
    } catch {
      console.error("No team found. Run `agentforge forge` or `agentforge genesis` first.");
      process.exitCode = 1;
      return;
    }

    // Load agent templates
    const agentsDir = path.join(projectRoot, ".agentforge", "agents");
    const templates = new Map<string, AgentTemplate>();
    const allAgents = Object.values(manifest.agents).flat();

    for (const agentName of allAgents) {
      const agentPath = path.join(agentsDir, `${agentName}.yaml`);
      try {
        const raw = await fs.readFile(agentPath, "utf-8");
        templates.set(agentName, yaml.load(raw) as AgentTemplate);
      } catch {
        console.warn(`  Warning: no template for ${agentName}`);
      }
    }

    const budget = options.budget ? parseFloat(options.budget) : 5.0;

    const config: TeamModeConfig = {
      sessionConfig: {
        projectRoot,
        sessionBudgetUsd: budget,
        enableReforge: false,
        enableCostAwareRouting: true,
        enableReviewEnforcement: false,
      },
      teamManifest: manifest,
      agentTemplates: templates,
    };

    const autonomyOverride = options.mode as AutonomyLevel | undefined;
    const session = new TeamModeSession(config);
    await session.activate(autonomyOverride);
    activeSession = session;

    console.log(`\n  Team Mode ACTIVE`);
    console.log(`  --------------------------------`);
    console.log(`  Team:      ${manifest.name}`);
    console.log(`  Session:   ${session.getSessionId().slice(0, 8)}`);
    console.log(`  Autonomy:  ${session.getAutonomyLevel()}`);
    console.log(`  Budget:    $${budget.toFixed(2)}`);
    console.log(`  Agents:    ${allAgents.length}`);
    console.log(`\n  Give tasks naturally or use @agent-name for direct messages.`);
    console.log(`  Run \`deactivate\` to exit team mode.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Activation failed: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerActivateCommand(program: Command): void {
  program
    .command("activate")
    .description("Enter team mode — persistent multi-agent session")
    .option("--mode <level>", "Autonomy level: full, supervised, or guided")
    .option("--budget <usd>", "Session budget in USD (default: 5.00)")
    .action(activateAction);
}
```

- [ ] **Step 2: Write the deactivate command**

```typescript
// src/cli/commands/deactivate.ts
import { Command } from "commander";
import { getActiveSession } from "./activate.js";

async function deactivateAction(): Promise<void> {
  try {
    const session = getActiveSession();

    if (!session || session.getState() !== "active") {
      console.error("No active team mode session. Nothing to deactivate.");
      process.exitCode = 1;
      return;
    }

    const entries = session.getFeedEntries();
    const sessionId = session.getSessionId().slice(0, 8);

    await session.deactivate();

    console.log(`\n  Team Mode DEACTIVATED`);
    console.log(`  --------------------------------`);
    console.log(`  Session:      ${sessionId}`);
    console.log(`  Feed entries: ${entries.length}`);
    console.log(`\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Deactivation failed: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerDeactivateCommand(program: Command): void {
  program
    .command("deactivate")
    .description("Exit team mode — end the active session")
    .action(deactivateAction);
}
```

- [ ] **Step 3: Register commands in CLI index**

Add imports to `src/cli/index.ts`:

```typescript
import registerActivateCommand from "./commands/activate.js";
import registerDeactivateCommand from "./commands/deactivate.js";
```

And in the registration block:

```typescript
registerActivateCommand(program);
registerDeactivateCommand(program);
```

- [ ] **Step 4: Run build to verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/activate.ts src/cli/commands/deactivate.ts src/cli/index.ts
git commit -m "feat(v3.2): add activate/deactivate CLI commands for team mode"
```

---

## Sprint 2 — Intelligence & Routing

### Task 8: Autonomy Detector

**Files:**
- Create: `src/orchestrator/autonomy-detector.ts`
- Test: `tests/orchestrator/autonomy-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/autonomy-detector.test.ts
import { describe, it, expect } from "vitest";
import { detectAutonomy, getClaudeCodeTier } from "../../src/orchestrator/autonomy-detector.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(routing: { opus: string[]; sonnet: string[]; haiku: string[] }): TeamManifest {
  const allAgents = [...routing.opus, ...routing.sonnet, ...routing.haiku];
  return {
    name: "Test",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc",
    agents: {
      strategic: routing.opus,
      implementation: routing.sonnet,
      quality: [],
      utility: routing.haiku,
    },
    model_routing: routing,
    delegation_graph: Object.fromEntries(allAgents.map((a) => [a, []])),
  };
}

describe("detectAutonomy", () => {
  it("should return full when team has Opus strategic agents", () => {
    const manifest = makeManifest({ opus: ["cto", "lead-architect"], sonnet: ["core-lead"], haiku: ["coder-a"] });
    expect(detectAutonomy(manifest)).toBe("full");
  });

  it("should return supervised when team has Sonnet leads but no Opus", () => {
    const manifest = makeManifest({ opus: [], sonnet: ["core-lead", "qa-lead"], haiku: ["coder-a", "coder-b"] });
    expect(detectAutonomy(manifest)).toBe("supervised");
  });

  it("should return guided when team is all Haiku", () => {
    const manifest = makeManifest({ opus: [], sonnet: [], haiku: ["coder-a", "coder-b"] });
    expect(detectAutonomy(manifest)).toBe("guided");
  });

  it("should return full even with just one Opus agent", () => {
    const manifest = makeManifest({ opus: ["cto"], sonnet: [], haiku: ["coder-a"] });
    expect(detectAutonomy(manifest)).toBe("full");
  });
});

describe("getClaudeCodeTier", () => {
  it("should return haiku for full autonomy", () => {
    expect(getClaudeCodeTier("full")).toBe("haiku");
  });

  it("should return sonnet for supervised autonomy", () => {
    expect(getClaudeCodeTier("supervised")).toBe("sonnet");
  });

  it("should return null for guided (no tier change)", () => {
    expect(getClaudeCodeTier("guided")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/autonomy-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/autonomy-detector.ts
import type { TeamManifest } from "../types/team.js";
import type { AutonomyLevel } from "../types/team-mode.js";
import type { ModelTier } from "../types/agent.js";

export function detectAutonomy(manifest: TeamManifest): AutonomyLevel {
  const { model_routing } = manifest;

  if (model_routing.opus.length > 0) return "full";
  if (model_routing.sonnet.length > 0) return "supervised";
  return "guided";
}

export function getClaudeCodeTier(autonomy: AutonomyLevel): ModelTier | null {
  switch (autonomy) {
    case "full":
      return "haiku";
    case "supervised":
      return "sonnet";
    case "guided":
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/autonomy-detector.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/autonomy-detector.ts tests/orchestrator/autonomy-detector.test.ts
git commit -m "feat(v3.2): add autonomy detector — full/supervised/guided from team composition"
```

---

### Task 9: Smart Router with Direct Message Parsing

**Files:**
- Create: `src/orchestrator/smart-router.ts`
- Test: `tests/orchestrator/smart-router.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/smart-router.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SmartRouter } from "../../src/orchestrator/smart-router.js";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto", "lead-architect"],
      implementation: ["core-lead", "runtime-lead", "coder-a"],
      quality: ["qa-lead"],
      utility: [],
    },
    model_routing: {
      opus: ["cto", "lead-architect"],
      sonnet: ["core-lead", "runtime-lead", "qa-lead"],
      haiku: ["coder-a"],
    },
    delegation_graph: {
      cto: ["lead-architect", "core-lead", "runtime-lead"],
      "lead-architect": ["core-lead", "runtime-lead"],
      "core-lead": ["coder-a"],
      "runtime-lead": [],
      "qa-lead": [],
      "coder-a": [],
    },
  };
}

describe("SmartRouter", () => {
  let router: SmartRouter;

  beforeEach(() => {
    const registry = new AgentAddressRegistry(makeManifest());
    router = new SmartRouter(registry);
  });

  describe("parseDirectMessage", () => {
    it("should parse @agent-name prefix", () => {
      const result = router.parseDirectMessage("@cto what's the plan?");
      expect(result).toEqual({ targetAgent: "cto", content: "what's the plan?" });
    });

    it("should parse @agent-name with hyphenated names", () => {
      const result = router.parseDirectMessage("@core-lead add a scanner");
      expect(result).toEqual({ targetAgent: "core-lead", content: "add a scanner" });
    });

    it("should return null for messages without @prefix", () => {
      expect(router.parseDirectMessage("build the auth module")).toBeNull();
    });

    it("should return null for unknown agent", () => {
      expect(router.parseDirectMessage("@nonexistent do something")).toBeNull();
    });
  });

  describe("routeTask", () => {
    it("should route strategic tasks to CTO", () => {
      expect(router.routeTask("change our approach to authentication")).toBe("cto");
    });

    it("should route architectural tasks to lead-architect", () => {
      expect(router.routeTask("refactor how the modules communicate")).toBe("lead-architect");
    });

    it("should route ambiguous tasks to CTO as safe default", () => {
      expect(router.routeTask("do the thing")).toBe("cto");
    });
  });

  describe("isFirstTask", () => {
    it("should return true before any routing", () => {
      expect(router.isFirstTask()).toBe(true);
    });

    it("should return false after first route", () => {
      router.routeTask("anything");
      expect(router.isFirstTask()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/smart-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/smart-router.ts
import type { AgentAddressRegistry } from "./agent-address-registry.js";

interface DirectMessage {
  targetAgent: string;
  content: string;
}

const STRATEGIC_KEYWORDS = [
  "strategy", "approach", "direction", "vision", "roadmap",
  "priority", "priorities", "decision", "change our", "rethink",
];

const ARCHITECTURAL_KEYWORDS = [
  "refactor", "restructure", "architecture", "redesign",
  "cross-cutting", "modules communicate", "system design",
  "decompose", "decouple",
];

const RESEARCH_KEYWORDS = [
  "research", "investigate", "explore options", "what frameworks",
  "compare", "evaluate", "benchmark", "proof of concept",
];

export class SmartRouter {
  private registry: AgentAddressRegistry;
  private taskCount = 0;

  constructor(registry: AgentAddressRegistry) {
    this.registry = registry;
  }

  parseDirectMessage(input: string): DirectMessage | null {
    const match = input.match(/^@([a-z][a-z0-9-]*)\s+(.*)/s);
    if (!match) return null;

    const [, agentName, content] = match;
    if (!this.registry.hasAgent(agentName)) return null;

    return { targetAgent: agentName, content: content.trim() };
  }

  routeTask(task: string): string {
    this.taskCount++;
    const lower = task.toLowerCase();

    if (STRATEGIC_KEYWORDS.some((kw) => lower.includes(kw))) {
      return this.findAgent("opus") ?? "cto";
    }

    if (ARCHITECTURAL_KEYWORDS.some((kw) => lower.includes(kw))) {
      return this.findArchitect();
    }

    if (RESEARCH_KEYWORDS.some((kw) => lower.includes(kw))) {
      return this.findSonnetLead();
    }

    // Try keyword matching against agent names
    const sonnetLeads = this.registry.getSonnetAgents();
    for (const lead of sonnetLeads) {
      const leadWords = lead.split("-");
      if (leadWords.some((w) => lower.includes(w) && w.length > 3)) {
        return lead;
      }
    }

    // Ambiguous — default to CTO
    return this.findAgent("opus") ?? this.findSonnetLead();
  }

  isFirstTask(): boolean {
    return this.taskCount === 0;
  }

  private findAgent(tier: "opus" | "sonnet" | "haiku"): string | null {
    const agents =
      tier === "opus"
        ? this.registry.getOpusAgents()
        : tier === "sonnet"
          ? this.registry.getSonnetAgents()
          : this.registry.getHaikuAgents();
    return agents[0] ?? null;
  }

  private findArchitect(): string {
    const opus = this.registry.getOpusAgents();
    const architect = opus.find((a) => a.includes("architect"));
    if (architect) return architect;
    return opus[0] ?? this.findSonnetLead();
  }

  private findSonnetLead(): string {
    const sonnet = this.registry.getSonnetAgents();
    return sonnet[0] ?? this.registry.getAgentNames()[0] ?? "cto";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/smart-router.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/smart-router.ts tests/orchestrator/smart-router.test.ts
git commit -m "feat(v3.2): add SmartRouter — task routing with @agent syntax and keyword signals"
```

---

### Task 10: CTO Framer

**Files:**
- Create: `src/orchestrator/cto-framer.ts`
- Test: `tests/orchestrator/cto-framer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/cto-framer.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { CtoFramer } from "../../src/orchestrator/cto-framer.js";
import { AgentAddressRegistry } from "../../src/orchestrator/agent-address-registry.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead", "runtime-lead"],
      quality: [],
      utility: [],
    },
    model_routing: { opus: ["cto"], sonnet: ["core-lead", "runtime-lead"], haiku: [] },
    delegation_graph: { cto: ["core-lead", "runtime-lead"], "core-lead": [], "runtime-lead": [] },
  };
}

describe("CtoFramer", () => {
  let framer: CtoFramer;

  beforeEach(() => {
    const registry = new AgentAddressRegistry(makeManifest());
    framer = new CtoFramer(registry);
  });

  describe("buildFramingPrompt", () => {
    it("should include the task", () => {
      const prompt = framer.buildFramingPrompt("Build the authentication system");
      expect(prompt).toContain("Build the authentication system");
    });

    it("should include available leads", () => {
      const prompt = framer.buildFramingPrompt("Build something");
      expect(prompt).toContain("core-lead");
      expect(prompt).toContain("runtime-lead");
    });

    it("should instruct CTO to decompose into workstreams", () => {
      const prompt = framer.buildFramingPrompt("Build something");
      expect(prompt).toMatch(/workstream|decompose|break/i);
    });
  });

  describe("getCtoAgent", () => {
    it("should return the first Opus agent name", () => {
      expect(framer.getCtoAgent()).toBe("cto");
    });

    it("should return null when no Opus agents exist", () => {
      const noOpusManifest = makeManifest();
      noOpusManifest.model_routing.opus = [];
      noOpusManifest.model_routing.sonnet.push("cto");
      const registry = new AgentAddressRegistry(noOpusManifest);
      const framer2 = new CtoFramer(registry);
      expect(framer2.getCtoAgent()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/cto-framer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/cto-framer.ts
import type { AgentAddressRegistry } from "./agent-address-registry.js";

export class CtoFramer {
  private registry: AgentAddressRegistry;

  constructor(registry: AgentAddressRegistry) {
    this.registry = registry;
  }

  getCtoAgent(): string | null {
    const opus = this.registry.getOpusAgents();
    return opus[0] ?? null;
  }

  buildFramingPrompt(task: string): string {
    const leads = this.registry.getSonnetAgents();
    const leadsList = leads.map((l) => `- ${l}`).join("\n");

    return [
      `## Mission Framing`,
      ``,
      `You are the CTO. A new mission has been submitted:`,
      ``,
      `> ${task}`,
      ``,
      `Your job is to:`,
      `1. Break this down into workstreams that can run in parallel where possible`,
      `2. Assign each workstream to the most appropriate team lead`,
      `3. Define success criteria for the overall mission`,
      `4. Identify risks or dependencies between workstreams`,
      ``,
      `Available team leads:`,
      leadsList,
      ``,
      `Decompose the mission and delegate to leads. Be specific about what each lead should deliver.`,
    ].join("\n");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/cto-framer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/cto-framer.ts tests/orchestrator/cto-framer.test.ts
git commit -m "feat(v3.2): add CtoFramer — first-task mission decomposition for CTO"
```

---

### Task 11: Tiered Feed Formatting with Cost Milestones

**Files:**
- Modify: `src/orchestrator/feed-renderer.ts`
- Modify: `tests/orchestrator/feed-renderer.test.ts`

- [ ] **Step 1: Add failing tests for tiered formatting**

Add to `tests/orchestrator/feed-renderer.test.ts`:

```typescript
describe("tiered formatting", () => {
  it("should show decision messages as full", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "decision" }));
    expect(tier).toBe("full");
  });

  it("should show escalation messages as full", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "escalation" }));
    expect(tier).toBe("full");
  });

  it("should show task dispatch as oneliner", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "task", from: "agent:core-lead", to: "agent:coder-a" }));
    expect(tier).toBe("oneliner");
  });

  it("should show result as marker", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "result", from: "agent:coder-a" }));
    expect(tier).toBe("marker");
  });

  it("should show direct messages involving user as full", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "direct", from: "conduit:user" }));
    expect(tier).toBe("full");
  });

  it("should show status as oneliner", () => {
    const tier = renderer.getDisplayTier(makeMessage({ type: "status" }));
    expect(tier).toBe("oneliner");
  });
});

describe("cost milestone", () => {
  it("should format cost milestone entry", () => {
    const line = renderer.formatCostMilestone(0.50, 1.00, 50);
    expect(line).toContain("$0.50");
    expect(line).toContain("50%");
  });
});

describe("formatByTier", () => {
  it("should render full tier with complete content", () => {
    const msg = makeMessage({ type: "decision", content: "Use JWT for auth" });
    const line = renderer.formatByTier(msg);
    expect(line).toContain("Use JWT for auth");
  });

  it("should render marker tier with checkmark", () => {
    const msg = makeMessage({ type: "result", from: "agent:coder-a", content: "Done implementing types" });
    const line = renderer.formatByTier(msg);
    expect(line).toContain("completed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: FAIL — getDisplayTier, formatCostMilestone, formatByTier not found

- [ ] **Step 3: Add tiered formatting methods to FeedRenderer**

Add these methods to `src/orchestrator/feed-renderer.ts`:

```typescript
  getDisplayTier(message: TeamModeMessage): FeedDisplayTier {
    if (message.type === "decision" || message.type === "escalation") return "full";
    if (message.type === "direct" && (message.from === "conduit:user" || message.to === "conduit:user")) return "full";
    if (message.type === "result") return "marker";
    if (message.type === "task" || message.type === "status") return "oneliner";
    return "oneliner";
  }

  formatByTier(message: TeamModeMessage): string {
    const tier = this.getDisplayTier(message);
    const from = agentName(message.from);

    switch (tier) {
      case "full":
        return this.formatMessage(message);
      case "oneliner":
        return `[${from}]  ${truncate(message.content, 60)}`;
      case "marker":
        return `[${from}]  completed: ${truncate(message.content, 50)}`;
      case "silent":
        return "";
    }
  }

  formatCostMilestone(spent: number, budget: number, percent: number): string {
    return `[budget]  $${spent.toFixed(2)} spent / $${budget.toFixed(2)} cap (${percent}%)`;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: All 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/feed-renderer.ts tests/orchestrator/feed-renderer.test.ts
git commit -m "feat(v3.2): add tiered feed formatting and cost milestones"
```

---

### Task 12: Wire Intelligence into Team Mode Session

**Files:**
- Modify: `src/orchestrator/team-mode-session.ts`
- Modify: `tests/orchestrator/team-mode-session.test.ts`

- [ ] **Step 1: Add failing tests for smart routing and autonomy**

Add to `tests/orchestrator/team-mode-session.test.ts`:

```typescript
describe("autonomy detection", () => {
  it("should detect full autonomy with Opus agents", async () => {
    const session = new TeamModeSession(config);
    await session.activate();
    expect(session.getAutonomyLevel()).toBe("full");
  });

  it("should allow autonomy override", async () => {
    const session = new TeamModeSession(config);
    await session.activate("guided");
    expect(session.getAutonomyLevel()).toBe("guided");
  });
});

describe("smart routing", () => {
  it("should route @agent direct messages", async () => {
    const session = new TeamModeSession(config);
    await session.activate();

    const msg = session.submitUserInput("@cto what's the strategy?");
    expect(msg.type).toBe("direct");
    expect(msg.to).toBe("agent:cto");
  });

  it("should route plain tasks through smart router", async () => {
    const session = new TeamModeSession(config);
    await session.activate();

    const msg = session.submitUserInput("build the auth module");
    expect(msg.type).toBe("task");
    expect(msg.to).toMatch(/^agent:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: FAIL — submitUserInput not found

- [ ] **Step 3: Add routing to TeamModeSession**

Add imports to `src/orchestrator/team-mode-session.ts`:

```typescript
import { detectAutonomy } from "./autonomy-detector.js";
import { SmartRouter } from "./smart-router.js";
import { CtoFramer } from "./cto-framer.js";
```

Add properties:

```typescript
  private router: SmartRouter | null = null;
  private framer: CtoFramer | null = null;
```

Wire in `activate()` — add after bus creation:

```typescript
    this.router = new SmartRouter(this.registry);
    this.framer = new CtoFramer(this.registry);
```

Update autonomy detection line in `activate()`:

```typescript
    this.autonomyLevel = overrideAutonomy ?? detectAutonomy(this.config.teamManifest);
```

Add `submitUserInput()` method:

```typescript
  submitUserInput(input: string): TeamModeMessage {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot accept input");
    }

    // Check for @agent direct message
    const dm = this.router!.parseDirectMessage(input);
    if (dm) {
      return this.bus!.send({
        from: "conduit:user",
        to: `agent:${dm.targetAgent}`,
        type: "direct",
        content: dm.content,
        priority: "normal",
      });
    }

    // First task goes to CTO for framing (if available)
    if (this.router!.isFirstTask() && this.framer!.getCtoAgent()) {
      const ctoAgent = this.framer!.getCtoAgent()!;
      return this.bus!.send({
        from: "conduit:user",
        to: `agent:${ctoAgent}`,
        type: "task",
        content: input,
        priority: "high",
      });
    }

    // Subsequent tasks go through smart router
    const target = this.router!.routeTask(input);
    return this.bus!.send({
      from: "conduit:user",
      to: `agent:${target}`,
      type: "task",
      content: input,
      priority: "normal",
    });
  }
```

Remove the private `detectAutonomy()` method (now imported).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/team-mode-session.ts tests/orchestrator/team-mode-session.test.ts
git commit -m "feat(v3.2): wire autonomy detection, smart routing, CTO framing into TeamModeSession"
```

---

## Sprint 3 — Persistence & Polish

### Task 13: Session Serializer

**Files:**
- Create: `src/orchestrator/session-serializer.ts`
- Test: `tests/orchestrator/session-serializer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/session-serializer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionSerializer } from "../../src/orchestrator/session-serializer.js";
import type { HibernatedSession, FeedEntry } from "../../src/types/team-mode.js";

function makeHibernated(): HibernatedSession {
  return {
    sessionId: "test-session-001",
    autonomyLevel: "full",
    activatedAt: "2026-03-25T10:00:00Z",
    hibernatedAt: "2026-03-25T12:00:00Z",
    inFlightTasks: [{
      id: "msg-1", from: "agent:core-lead", to: "agent:coder-a",
      type: "task", content: "Implement types", priority: "normal",
      timestamp: "2026-03-25T11:00:00Z",
    }],
    pendingMessages: [],
    costSnapshot: { totalSpentUsd: 0.15, remainingBudgetUsd: 4.85 },
    gitHash: "abc1234",
    teamManifestHash: "def5678",
  };
}

function makeFeedEntries(): FeedEntry[] {
  return [
    { timestamp: "2026-03-25T10:01:00Z", source: "agent:cto", target: "agent:core-lead", type: "task", summary: "Design types", content: "Design the type system" },
    { timestamp: "2026-03-25T10:05:00Z", source: "agent:core-lead", type: "status", summary: "Starting", content: "Starting work" },
  ];
}

describe("SessionSerializer", () => {
  let tmpDir: string;
  let serializer: SessionSerializer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "serializer-test-"));
    serializer = new SessionSerializer(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("serialize", () => {
    it("should write session.json", async () => {
      await serializer.serialize("test-session-001", makeHibernated(), makeFeedEntries());
      const sessionPath = path.join(tmpDir, ".agentforge", "sessions", "test-session-001", "session.json");
      const data = JSON.parse(await fs.readFile(sessionPath, "utf-8"));
      expect(data.sessionId).toBe("test-session-001");
    });

    it("should write feed.jsonl", async () => {
      await serializer.serialize("test-session-001", makeHibernated(), makeFeedEntries());
      const feedPath = path.join(tmpDir, ".agentforge", "sessions", "test-session-001", "feed.jsonl");
      const lines = (await fs.readFile(feedPath, "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });

  describe("deserialize", () => {
    it("should round-trip session data", async () => {
      await serializer.serialize("test-session-001", makeHibernated(), makeFeedEntries());
      const restored = await serializer.deserialize("test-session-001");
      expect(restored).not.toBeNull();
      expect(restored!.sessionId).toBe("test-session-001");
      expect(restored!.autonomyLevel).toBe("full");
      expect(restored!.inFlightTasks).toHaveLength(1);
    });

    it("should return null for non-existent session", async () => {
      expect(await serializer.deserialize("nonexistent")).toBeNull();
    });
  });

  describe("loadFeed", () => {
    it("should load feed entries from jsonl", async () => {
      await serializer.serialize("test-session-001", makeHibernated(), makeFeedEntries());
      const entries = await serializer.loadFeed("test-session-001");
      expect(entries).toHaveLength(2);
      expect(entries[0].source).toBe("agent:cto");
    });
  });

  describe("listSessions", () => {
    it("should list all serialized sessions", async () => {
      await serializer.serialize("session-a", makeHibernated(), []);
      await serializer.serialize("session-b", { ...makeHibernated(), sessionId: "session-b" }, []);
      const sessions = await serializer.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("should return empty when no sessions exist", async () => {
      expect(await serializer.listSessions()).toHaveLength(0);
    });
  });

  describe("deleteSession", () => {
    it("should remove a serialized session", async () => {
      await serializer.serialize("to-delete", makeHibernated(), []);
      await serializer.deleteSession("to-delete");
      expect(await serializer.deserialize("to-delete")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/session-serializer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/session-serializer.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { HibernatedSession, FeedEntry } from "../types/team-mode.js";

export class SessionSerializer {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  private sessionsDir(): string {
    return path.join(this.projectRoot, ".agentforge", "sessions");
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir(), sessionId);
  }

  async serialize(sessionId: string, state: HibernatedSession, feedEntries: FeedEntry[]): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "session.json"), JSON.stringify(state, null, 2));
    const lines = feedEntries.map((e) => JSON.stringify(e)).join("\n");
    await fs.writeFile(path.join(dir, "feed.jsonl"), lines ? lines + "\n" : "");
  }

  async deserialize(sessionId: string): Promise<HibernatedSession | null> {
    try {
      const raw = await fs.readFile(path.join(this.sessionDir(sessionId), "session.json"), "utf-8");
      return JSON.parse(raw) as HibernatedSession;
    } catch {
      return null;
    }
  }

  async loadFeed(sessionId: string): Promise<FeedEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.sessionDir(sessionId), "feed.jsonl"), "utf-8");
      return raw.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as FeedEntry);
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<HibernatedSession[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir());
      const sessions: HibernatedSession[] = [];
      for (const entry of entries) {
        const session = await this.deserialize(entry);
        if (session) sessions.push(session);
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/session-serializer.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/session-serializer.ts tests/orchestrator/session-serializer.test.ts
git commit -m "feat(v3.2): add SessionSerializer — hibernate/resume with feed.jsonl persistence"
```

---

### Task 14: Staleness Detector

**Files:**
- Create: `src/orchestrator/staleness-detector.ts`
- Test: `tests/orchestrator/staleness-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/orchestrator/staleness-detector.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { StalenessDetector } from "../../src/orchestrator/staleness-detector.js";
import type { TeamModeMessage } from "../../src/types/team-mode.js";

describe("StalenessDetector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "staleness-test-"));
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "types.ts"), "export {};");
    execFileSync("git", ["add", "."], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("getChangedFiles", () => {
    it("should detect files changed since a given commit", async () => {
      const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();
      await fs.writeFile(path.join(tmpDir, "src", "types.ts"), "export type A = string;");
      execFileSync("git", ["add", "."], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "modify"], { cwd: tmpDir });

      const detector = new StalenessDetector(tmpDir);
      const changed = await detector.getChangedFiles(hash);
      expect(changed).toContain("src/types.ts");
    });

    it("should return empty array when no changes", async () => {
      const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).trim();
      const detector = new StalenessDetector(tmpDir);
      expect(await detector.getChangedFiles(hash)).toHaveLength(0);
    });
  });

  describe("findAffectedTasks", () => {
    it("should match changed files to in-flight tasks by content mention", () => {
      const detector = new StalenessDetector(tmpDir);
      const tasks: TeamModeMessage[] = [
        { id: "t1", from: "agent:lead", to: "agent:coder", type: "task", content: "Implement types in src/types.ts", priority: "normal", timestamp: "2026-03-25T10:00:00Z" },
        { id: "t2", from: "agent:lead", to: "agent:coder", type: "task", content: "Write scanner tests", priority: "normal", timestamp: "2026-03-25T10:00:00Z" },
      ];
      const affected = detector.findAffectedTasks(tasks, ["src/types.ts"]);
      expect(affected).toHaveLength(1);
      expect(affected[0].id).toBe("t1");
    });
  });

  describe("getCurrentGitHash", () => {
    it("should return current HEAD hash", async () => {
      const detector = new StalenessDetector(tmpDir);
      const hash = await detector.getCurrentGitHash();
      expect(hash).toMatch(/^[a-f0-9]{40}$/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/staleness-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/orchestrator/staleness-detector.ts
import { execFileSync } from "node:child_process";
import type { TeamModeMessage } from "../types/team-mode.js";

export class StalenessDetector {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async getChangedFiles(sinceCommit: string): Promise<string[]> {
    try {
      const output = execFileSync("git", ["diff", "--name-only", sinceCommit, "HEAD"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
      });
      return output.trim().split("\n").filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }

  findAffectedTasks(inFlightTasks: TeamModeMessage[], changedFiles: string[]): TeamModeMessage[] {
    return inFlightTasks.filter((task) => {
      const content = task.content.toLowerCase();
      return changedFiles.some((file) => {
        const fileName = file.split("/").pop() ?? "";
        return content.includes(file.toLowerCase()) || content.includes(fileName.toLowerCase());
      });
    });
  }

  async getCurrentGitHash(): Promise<string> {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: this.projectRoot,
      encoding: "utf-8",
    }).trim();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/staleness-detector.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/staleness-detector.ts tests/orchestrator/staleness-detector.test.ts
git commit -m "feat(v3.2): add StalenessDetector — git diff detection for hibernation resume"
```

---

### Task 15: Session Hibernate & Resume Flow

**Files:**
- Modify: `src/orchestrator/team-mode-session.ts`
- Modify: `tests/orchestrator/team-mode-session.test.ts`

- [ ] **Step 1: Add failing tests for hibernate and resume**

Add to `tests/orchestrator/team-mode-session.test.ts`:

```typescript
describe("hibernation", () => {
  it("should hibernate an active session", async () => {
    const session = new TeamModeSession(config);
    await session.activate();
    session.submitTask("Build something");
    await session.hibernate();
    expect(session.getState()).toBe("hibernated");
  });

  it("should throw if not active", async () => {
    const session = new TeamModeSession(config);
    await expect(session.hibernate()).rejects.toThrow();
  });

  it("should serialize state to disk", async () => {
    const session = new TeamModeSession(config);
    await session.activate();
    session.submitTask("Build something");
    await session.hibernate();
    const sessionFile = path.join(tmpDir, ".agentforge", "sessions", session.getSessionId(), "session.json");
    const data = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
    expect(data.sessionId).toBe(session.getSessionId());
  });
});

describe("resume", () => {
  it("should resume a hibernated session", async () => {
    const session = new TeamModeSession(config);
    await session.activate();
    const sessionId = session.getSessionId();
    session.submitTask("Build something");
    await session.hibernate();

    const session2 = new TeamModeSession(config);
    const resumed = await session2.resume(sessionId);
    expect(resumed).toBe(true);
    expect(session2.getState()).toBe("active");
  });

  it("should return false for non-existent session", async () => {
    const session = new TeamModeSession(config);
    expect(await session.resume("nonexistent")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: FAIL — hibernate, resume not found

- [ ] **Step 3: Add hibernate and resume to TeamModeSession**

Add imports to `src/orchestrator/team-mode-session.ts`:

```typescript
import { SessionSerializer } from "./session-serializer.js";
import { StalenessDetector } from "./staleness-detector.js";
import type { HibernatedSession } from "../types/team-mode.js";
```

Add properties:

```typescript
  private serializer: SessionSerializer;
  private stalenessDetector: StalenessDetector;
```

Initialize in constructor:

```typescript
    this.serializer = new SessionSerializer(config.sessionConfig.projectRoot);
    this.stalenessDetector = new StalenessDetector(config.sessionConfig.projectRoot);
```

Add `hibernate()`:

```typescript
  async hibernate(): Promise<void> {
    if (!this.lifecycle.isActive()) {
      throw new Error(`Cannot hibernate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("hibernating");

    const gitHash = await this.stalenessDetector.getCurrentGitHash().catch(() => "unknown");
    const costReport = this.innerSession?.getCostReport();

    const hibernated: HibernatedSession = {
      sessionId: this.sessionId,
      autonomyLevel: this.autonomyLevel,
      activatedAt: this.activatedAt!,
      hibernatedAt: new Date().toISOString(),
      inFlightTasks: this.bus?.getHistory().filter((m) => m.type === "task") ?? [],
      pendingMessages: [],
      costSnapshot: {
        totalSpentUsd: costReport?.totalSpentUsd ?? 0,
        remainingBudgetUsd: costReport?.remainingBudgetUsd ?? this.config.sessionConfig.sessionBudgetUsd,
      },
      gitHash,
      teamManifestHash: this.config.teamManifest.project_hash,
    };

    await this.serializer.serialize(this.sessionId, hibernated, this.feed.getEntries());

    if (this.innerSession) {
      await this.innerSession.end();
      this.innerSession = null;
    }

    this.lifecycle.transition("hibernated");
  }
```

Add `resume()`:

```typescript
  async resume(sessionId: string): Promise<boolean> {
    const hibernated = await this.serializer.deserialize(sessionId);
    if (!hibernated) return false;

    this.sessionId = hibernated.sessionId;
    this.autonomyLevel = hibernated.autonomyLevel;
    this.activatedAt = hibernated.activatedAt;

    const feedEntries = await this.serializer.loadFeed(sessionId);
    this.feed.clear();
    for (const entry of feedEntries) {
      this.feed.restoreEntry(entry);
    }

    await this.activate(this.autonomyLevel);
    return true;
  }
```

Add `restoreEntry()` to FeedRenderer (`src/orchestrator/feed-renderer.ts`):

```typescript
  restoreEntry(entry: FeedEntry): void {
    this.entries.push(entry);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/team-mode-session.test.ts`
Expected: All 19 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/team-mode-session.ts src/orchestrator/feed-renderer.ts tests/orchestrator/team-mode-session.test.ts
git commit -m "feat(v3.2): add hibernate/resume to TeamModeSession with state persistence"
```

---

### Task 16: Feed Persistence to feed.jsonl

**Files:**
- Modify: `src/orchestrator/feed-renderer.ts`
- Modify: `tests/orchestrator/feed-renderer.test.ts`

- [ ] **Step 1: Add failing tests for real-time persistence**

Add to `tests/orchestrator/feed-renderer.test.ts`:

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("feed persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "feed-persist-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should append entries to feed.jsonl when path is set", async () => {
    const feedPath = path.join(tmpDir, "feed.jsonl");
    const persistentRenderer = new FeedRenderer(feedPath);
    persistentRenderer.addMessage(makeMessage({ id: "1" }));
    persistentRenderer.addMessage(makeMessage({ id: "2" }));

    const lines = (await fs.readFile(feedPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("should not throw when no path is configured", () => {
    const noPathRenderer = new FeedRenderer();
    noPathRenderer.addMessage(makeMessage());
    expect(noPathRenderer.getEntries()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: FAIL — FeedRenderer constructor doesn't accept path

- [ ] **Step 3: Add persistence to FeedRenderer**

Update constructor and `addMessage` in `src/orchestrator/feed-renderer.ts`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class FeedRenderer {
  private entries: FeedEntry[] = [];
  private persistPath: string | null;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;
    if (this.persistPath) {
      mkdirSync(dirname(this.persistPath), { recursive: true });
    }
  }

  addMessage(message: TeamModeMessage): FeedEntry {
    const entry = this.toFeedEntry(message);
    this.entries.push(entry);

    if (this.persistPath) {
      appendFileSync(this.persistPath, JSON.stringify(entry) + "\n");
    }

    return entry;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/feed-renderer.test.ts`
Expected: All 20 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/feed-renderer.ts tests/orchestrator/feed-renderer.test.ts
git commit -m "feat(v3.2): add real-time feed.jsonl persistence to FeedRenderer"
```

---

### Task 17: Sessions Listing Command

**Files:**
- Create: `src/cli/commands/sessions.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write the sessions command**

```typescript
// src/cli/commands/sessions.ts
import { Command } from "commander";
import { SessionSerializer } from "../../orchestrator/session-serializer.js";

async function sessionsAction(options: { clean?: boolean }): Promise<void> {
  try {
    const projectRoot = process.cwd();
    const serializer = new SessionSerializer(projectRoot);
    const sessions = await serializer.listSessions();

    if (sessions.length === 0) {
      console.log("\n  No sessions found.\n");
      return;
    }

    if (options.clean) {
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      let cleaned = 0;

      for (const session of sessions) {
        const age = now - new Date(session.hibernatedAt).getTime();
        if (age > sevenDays) {
          await serializer.deleteSession(session.sessionId);
          cleaned++;
        }
      }

      console.log(`\n  Cleaned ${cleaned} expired sessions (>7 days old).\n`);
      return;
    }

    console.log(`\n  Sessions (${sessions.length})`);
    console.log(`  --------------------------------`);

    for (const session of sessions) {
      const id = session.sessionId.slice(0, 8);
      const autonomy = session.autonomyLevel;
      const spent = session.costSnapshot.totalSpentUsd.toFixed(2);
      const tasks = session.inFlightTasks.length;
      const date = new Date(session.hibernatedAt).toLocaleDateString();

      console.log(`  ${id}  ${autonomy.padEnd(12)}  $${spent}  ${tasks} tasks  hibernated ${date}`);
    }

    console.log("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error listing sessions: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerSessionsCommand(program: Command): void {
  program
    .command("sessions")
    .description("List all team mode sessions (active, hibernated, completed)")
    .option("--clean", "Remove sessions older than 7 days")
    .action(sessionsAction);
}
```

- [ ] **Step 2: Register in CLI index**

Add to `src/cli/index.ts`:

```typescript
import registerSessionsCommand from "./commands/sessions.js";
```

And:

```typescript
registerSessionsCommand(program);
```

- [ ] **Step 3: Run build to verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/sessions.ts src/cli/index.ts
git commit -m "feat(v3.2): add sessions command — list, inspect, and clean team mode sessions"
```

- [ ] **Step 6: Version bump**

Update `package.json` version from `"0.3.0"` to `"0.4.0"`:

```bash
git add package.json
git commit -m "chore: bump version to 0.4.0 for v3.2 team mode"
```

---

## Post-Sprint Verification

After all 17 tasks, verify:

- [ ] `npx tsc --noEmit` — zero type errors
- [ ] `npx vitest run` — all tests pass
- [ ] All new files imported and exported through barrel exports
- [ ] CLI commands registered and accessible: `activate`, `deactivate`, `sessions`
- [ ] Types consistent across all tasks (TeamModeMessage, FeedEntry, HibernatedSession)

---

## Summary

| Sprint | Tasks | New Files | Test Files | Focus |
|--------|-------|-----------|------------|-------|
| 1 | 1-7 | 7 | 5 | Activation, lifecycle, bus, feed, commands |
| 2 | 8-12 | 3 | 3 | Autonomy, routing, CTO framing, tiered feed |
| 3 | 13-17 | 3 | 2 | Hibernation, resume, staleness, sessions |
| **Total** | **17** | **13** | **10** | |
