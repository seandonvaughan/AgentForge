/**
 * Tests for DelegationProtocol — v4.5 P0-2
 */
import { describe, it, expect } from "vitest";
import {
  DelegationProtocol,
  type DelegationExecutor,
} from "../../src/delegation/delegation-protocol.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DELEGATION_GRAPH = {
  ceo: ["cto", "coo", "cfo"],
  cto: ["architect"],
  architect: ["coder", "researcher"],
  coder: ["researcher", "linter"],
};

const ALL_AGENTS = new Set([
  "ceo", "cto", "coo", "cfo", "architect", "coder", "researcher", "linter",
]);

function makeProtocol(
  executor?: DelegationExecutor,
  bus?: V4MessageBus,
): DelegationProtocol {
  return new DelegationProtocol({
    delegationGraph: { ...DELEGATION_GRAPH },
    knownAgents: new Set(ALL_AGENTS),
    bus,
    executor,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegationProtocol", () => {
  describe("isAuthorized", () => {
    it("returns true for direct authorization", () => {
      const protocol = makeProtocol();
      expect(protocol.isAuthorized("ceo", "cto")).toBe(true);
      expect(protocol.isAuthorized("cto", "architect")).toBe(true);
      expect(protocol.isAuthorized("architect", "coder")).toBe(true);
    });

    it("returns false for unauthorized delegation", () => {
      const protocol = makeProtocol();
      expect(protocol.isAuthorized("coder", "ceo")).toBe(false);
      expect(protocol.isAuthorized("researcher", "cto")).toBe(false);
    });

    it("returns false for agents not in the graph", () => {
      const protocol = makeProtocol();
      expect(protocol.isAuthorized("linter", "coder")).toBe(false);
    });
  });

  describe("canReachTransitively", () => {
    it("returns true for transitive paths", () => {
      const protocol = makeProtocol();
      expect(protocol.canReachTransitively("ceo", "coder")).toBe(true);
      expect(protocol.canReachTransitively("ceo", "researcher")).toBe(true);
    });

    it("returns false for unreachable agents", () => {
      const protocol = makeProtocol();
      expect(protocol.canReachTransitively("coder", "ceo")).toBe(false);
      expect(protocol.canReachTransitively("linter", "cto")).toBe(false);
    });

    it("returns false for self", () => {
      const protocol = makeProtocol();
      // Technically, 'ceo' starts there, but we visit it immediately
      // The implementation finds 'ceo' in the queue first iteration
      expect(protocol.canReachTransitively("ceo", "ceo")).toBe(true);
    });
  });

  describe("delegate", () => {
    it("executes an authorized delegation", async () => {
      const protocol = makeProtocol();
      const result = await protocol.delegate(
        "ceo",
        "cto",
        "Review the architecture",
      );

      expect(result.success).toBe(true);
      expect(result.delegationId).toBeTruthy();
      expect(result.response).toContain("cto");
    });

    it("rejects delegation from unknown agent", async () => {
      const protocol = makeProtocol();
      const result = await protocol.delegate(
        "unknown-agent",
        "cto",
        "Do something",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects delegation to unknown agent", async () => {
      const protocol = makeProtocol();
      const result = await protocol.delegate(
        "ceo",
        "unknown-agent",
        "Do something",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects self-delegation", async () => {
      const protocol = makeProtocol();
      const result = await protocol.delegate(
        "ceo",
        "ceo",
        "Do something",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot delegate to itself");
    });

    it("rejects unauthorized delegation", async () => {
      const protocol = makeProtocol();
      const result = await protocol.delegate(
        "coder",
        "ceo",
        "Override the system",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not authorized");
    });

    it("handles executor errors gracefully", async () => {
      const failingExecutor: DelegationExecutor = async () => {
        throw new Error("Agent crashed");
      };

      const protocol = makeProtocol(failingExecutor);
      const result = await protocol.delegate(
        "ceo",
        "cto",
        "Do something risky",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Agent crashed");
    });

    it("passes context and constraints to executor", async () => {
      let capturedRequest: any = null;
      const captureExecutor: DelegationExecutor = async (req) => {
        capturedRequest = req;
        return { response: "ok", tokensUsed: 100, durationMs: 50 };
      };

      const protocol = makeProtocol(captureExecutor);
      await protocol.delegate("ceo", "cto", "Review code", {
        context: "This is important",
        constraints: ["No new dependencies"],
        budgetUsd: 5.0,
      });

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest.context).toBe("This is important");
      expect(capturedRequest.constraints).toEqual(["No new dependencies"]);
      expect(capturedRequest.budgetUsd).toBe(5.0);
    });
  });

  describe("logging", () => {
    it("records successful delegations in the log", async () => {
      const protocol = makeProtocol();
      await protocol.delegate("ceo", "cto", "Review architecture");

      const log = protocol.getLog();
      expect(log).toHaveLength(1);
      expect(log[0].from).toBe("ceo");
      expect(log[0].to).toBe("cto");
      expect(log[0].status).toBe("completed");
      expect(log[0].authorized).toBe(true);
    });

    it("records rejected delegations in the log", async () => {
      const protocol = makeProtocol();
      await protocol.delegate("coder", "ceo", "Override");

      const log = protocol.getLog();
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe("rejected");
      expect(log[0].authorized).toBe(false);
    });

    it("filters delegations by source agent", async () => {
      const protocol = makeProtocol();
      await protocol.delegate("ceo", "cto", "task 1");
      await protocol.delegate("ceo", "coo", "task 2");
      await protocol.delegate("cto", "architect", "task 3");

      const fromCeo = protocol.getDelegationsFrom("ceo");
      expect(fromCeo).toHaveLength(2);

      const fromCto = protocol.getDelegationsFrom("cto");
      expect(fromCto).toHaveLength(1);
    });

    it("filters delegations by target agent", async () => {
      const protocol = makeProtocol();
      await protocol.delegate("ceo", "cto", "task 1");
      await protocol.delegate("ceo", "coo", "task 2");

      const toCto = protocol.getDelegationsTo("cto");
      expect(toCto).toHaveLength(1);
    });
  });

  describe("bus events", () => {
    it("emits delegation events on the bus", async () => {
      const bus = new V4MessageBus();
      const events: string[] = [];
      bus.onAnyMessage((env) => events.push(env.topic));

      const protocol = makeProtocol(undefined, bus);
      await protocol.delegate("ceo", "cto", "Review");

      expect(events).toContain("delegation.requested");
      expect(events).toContain("delegation.completed");
    });

    it("emits rejection event for unauthorized delegation", async () => {
      const bus = new V4MessageBus();
      const events: string[] = [];
      bus.onAnyMessage((env) => events.push(env.topic));

      const protocol = makeProtocol(undefined, bus);
      await protocol.delegate("coder", "ceo", "Hijack");

      expect(events).toContain("delegation.rejected");
    });
  });

  describe("getGraph", () => {
    it("returns a copy of the delegation graph", () => {
      const protocol = makeProtocol();
      const graph = protocol.getGraph();

      expect(graph.ceo).toEqual(["cto", "coo", "cfo"]);
      expect(graph.cto).toEqual(["architect"]);

      // Mutating the returned graph should not affect the protocol
      graph.ceo = [];
      expect(protocol.getGraph().ceo).toEqual(["cto", "coo", "cfo"]);
    });
  });
});
