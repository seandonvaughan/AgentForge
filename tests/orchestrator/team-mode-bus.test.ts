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
    model_routing: { opus: ["cto"], sonnet: ["core-lead"], haiku: ["coder-a"] },
    delegation_graph: { cto: ["core-lead"], "core-lead": ["coder-a"], "coder-a": [] },
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
      const msg = bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "Design the type system", priority: "normal" });
      expect(msg.id).toBeDefined();
      expect(msg.from).toBe("agent:cto");
      expect(msg.to).toBe("agent:core-lead");
      expect(msg.timestamp).toBeDefined();
    });

    it("should accept user-to-agent message", () => {
      const msg = bus.send({ from: "conduit:user", to: "agent:cto", type: "task", content: "Build the auth module", priority: "normal" });
      expect(msg.from).toBe("conduit:user");
    });

    it("should accept agent-to-user message", () => {
      const msg = bus.send({ from: "agent:cto", to: "conduit:user", type: "result", content: "Auth module complete", priority: "normal" });
      expect(msg.to).toBe("conduit:user");
    });

    it("should reject message with invalid from address", () => {
      expect(() => bus.send({ from: "agent:nonexistent", to: "agent:cto", type: "task", content: "test", priority: "normal" })).toThrow("Unknown sender");
    });

    it("should reject message with invalid to address", () => {
      expect(() => bus.send({ from: "agent:cto", to: "agent:nonexistent", type: "task", content: "test", priority: "normal" })).toThrow("Unknown recipient");
    });

    it("should reject routing not allowed by delegation graph", () => {
      expect(() => bus.send({ from: "agent:coder-a", to: "agent:cto", type: "task", content: "I'm giving the CTO a task", priority: "normal" })).toThrow("not allowed");
    });
  });

  describe("subscribe", () => {
    it("should deliver messages to subscriber", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:core-lead", (msg) => received.push(msg));
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "Do the thing", priority: "normal" });
      bus.drain();
      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe("Do the thing");
    });

    it("should not deliver messages to non-target", () => {
      const received: TeamModeMessage[] = [];
      bus.subscribe("agent:coder-a", (msg) => received.push(msg));
      bus.send({ from: "agent:cto", to: "agent:core-lead", type: "task", content: "Not for coder-a", priority: "normal" });
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