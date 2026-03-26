import { describe, it, expect, beforeEach } from "vitest";
import { OrgGraph } from "../../src/org-graph/org-graph.js";
import { DelegationProtocol } from "../../src/org-graph/delegation-protocol.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import type { OrgNode } from "../../src/types/v4-api.js";

function makeNode(agentId: string, supervisorAgentId: string | null, canDelegateTo: string[] = []): OrgNode {
  return { agentId, roleId: agentId, supervisorAgentId, directReportIds: [], peerAgentIds: [], canDelegateTo };
}

function buildOrg(): { graph: OrgGraph; proto: DelegationProtocol } {
  const graph = new OrgGraph();
  graph.addNode(makeNode("ceo", null, ["cto", "coo"]));
  graph.addNode(makeNode("cto", "ceo", ["architect", "coder"]));
  graph.addNode(makeNode("coo", "ceo"));
  graph.addNode(makeNode("architect", "cto", ["coder"]));
  graph.addNode(makeNode("coder", "architect"));
  const proto = new DelegationProtocol(graph);
  return { graph, proto };
}

function validDelegate(proto: DelegationProtocol, from: string, to: string) {
  return proto.delegate(
    from, to,
    "Build feature X",
    "Business needs feature X for Q2",
    ["Must not exceed $50", "Use TypeScript only"],
    ["Minor UX tradeoffs acceptable"],
    "Pull request with tests"
  );
}

describe("DelegationProtocol", () => {
  let graph: OrgGraph;
  let proto: DelegationProtocol;

  beforeEach(() => {
    ({ graph, proto } = buildOrg());
  });

  // --- delegate (authorization) ---

  describe("delegate — authorization rules", () => {
    it("allows ancestor to delegate to descendant", () => {
      const result = validDelegate(proto, "ceo", "coder");
      expect(result.allowed).toBe(true);
    });

    it("allows canDelegateTo list to authorize non-ancestor delegation", () => {
      // ceo has coo in canDelegateTo; coo is NOT an ancestor of coo
      const result = validDelegate(proto, "ceo", "coo");
      expect(result.allowed).toBe(true);
    });

    it("allows direct supervisor → report delegation", () => {
      const result = validDelegate(proto, "cto", "architect");
      expect(result.allowed).toBe(true);
    });

    it("denies lateral delegation between peers", () => {
      const result = validDelegate(proto, "cto", "coo");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not authorized/);
    });

    it("denies upward delegation (subordinate to supervisor)", () => {
      const result = validDelegate(proto, "coder", "ceo");
      expect(result.allowed).toBe(false);
    });

    it("denies delegation when delegator not in graph", () => {
      const result = validDelegate(proto, "ghost", "coder");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not found/);
    });

    it("denies delegation when delegatee not in graph", () => {
      const result = validDelegate(proto, "cto", "ghost");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not found/);
    });
  });

  // --- delegate (context) ---

  describe("delegate — context envelope", () => {
    it("returns a DelegationContext with all required fields", () => {
      const result = validDelegate(proto, "cto", "architect");
      expect(result.context).toBeDefined();
      const ctx = result.context!;
      expect(ctx.taskId).toBeTruthy();
      expect(ctx.delegatorAgentId).toBe("cto");
      expect(ctx.delegateeAgentId).toBe("architect");
      expect(ctx.businessRationale).toBe("Business needs feature X for Q2");
      expect(ctx.constraints).toHaveLength(2);
      expect(ctx.acceptableTradeoffs).toHaveLength(1);
      expect(ctx.expectedOutput).toBe("Pull request with tests");
    });

    it("includes budget and deadline when provided", () => {
      const result = proto.delegate(
        "cto", "architect",
        "Task", "Rationale", [], [], "Output",
        { budgetUsd: 5.0, deadlineIso: "2026-04-01T00:00:00Z" }
      );
      expect(result.context?.budgetUsd).toBe(5.0);
      expect(result.context?.deadlineIso).toBe("2026-04-01T00:00:00Z");
    });

    it("generates unique taskId per delegation", () => {
      const r1 = validDelegate(proto, "cto", "architect");
      const r2 = validDelegate(proto, "cto", "coder");
      expect(r1.context?.taskId).not.toBe(r2.context?.taskId);
    });

    it("records the delegation with pending status", () => {
      const result = validDelegate(proto, "cto", "architect");
      const record = proto.getRecord(result.context!.taskId);
      expect(record.status).toBe("pending");
    });
  });

  // --- accept ---

  describe("accept", () => {
    it("transitions status from pending to accepted", () => {
      const result = validDelegate(proto, "cto", "architect");
      proto.accept(result.context!.taskId);
      expect(proto.getRecord(result.context!.taskId).status).toBe("accepted");
    });

    it("throws if not in pending state", () => {
      const result = validDelegate(proto, "cto", "architect");
      proto.accept(result.context!.taskId);
      expect(() => proto.accept(result.context!.taskId)).toThrow(/pending/);
    });
  });

  // --- complete ---

  describe("complete", () => {
    it("transitions accepted → completed with summary", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      proto.accept(id);
      proto.complete(id, "PR #42 merged");
      const record = proto.getRecord(id);
      expect(record.status).toBe("completed");
      expect(record.resultSummary).toBe("PR #42 merged");
      expect(record.completedAt).toBeTruthy();
    });

    it("throws if not in accepted state", () => {
      const result = validDelegate(proto, "cto", "architect");
      expect(() => proto.complete(result.context!.taskId, "done")).toThrow(/accepted/);
    });
  });

  // --- reject ---

  describe("reject", () => {
    it("transitions pending → rejected with reason", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      proto.reject(id, "No capacity this sprint");
      expect(proto.getRecord(id).status).toBe("rejected");
      expect(proto.getRecord(id).resultSummary).toBe("No capacity this sprint");
    });
  });

  // --- escalate ---

  describe("escalate", () => {
    it("escalates a pending delegation", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      proto.escalate(id, "Need clarification from CTO");
      expect(proto.getRecord(id).status).toBe("escalated");
    });

    it("escalates an accepted delegation", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      proto.accept(id);
      proto.escalate(id, "Blocked");
      expect(proto.getRecord(id).status).toBe("escalated");
    });

    it("throws if delegation is already completed", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      proto.accept(id);
      proto.complete(id, "done");
      expect(() => proto.escalate(id, "too late")).toThrow();
    });
  });

  // --- getPendingFor / getIssuedBy ---

  describe("getPendingFor / getIssuedBy", () => {
    it("getPendingFor returns delegations pending for a delegatee", () => {
      validDelegate(proto, "cto", "architect");
      validDelegate(proto, "cto", "architect");
      validDelegate(proto, "ceo", "cto");
      const pending = proto.getPendingFor("architect");
      expect(pending).toHaveLength(2);
      expect(pending.every((r) => r.context.delegateeAgentId === "architect")).toBe(true);
    });

    it("getPendingFor excludes non-pending delegations", () => {
      const result = validDelegate(proto, "cto", "architect");
      proto.accept(result.context!.taskId);
      expect(proto.getPendingFor("architect")).toHaveLength(0);
    });

    it("getIssuedBy returns all delegations from an agent", () => {
      validDelegate(proto, "cto", "architect");
      validDelegate(proto, "cto", "coder");
      validDelegate(proto, "ceo", "cto");
      expect(proto.getIssuedBy("cto")).toHaveLength(2);
    });
  });

  // --- size ---

  describe("size", () => {
    it("tracks total recorded delegations", () => {
      validDelegate(proto, "cto", "architect");
      validDelegate(proto, "cto", "coder");
      expect(proto.size()).toBe(2);
    });
  });

  // --- getRecord ---

  describe("getRecord", () => {
    it("returns snapshot — mutations do not affect registry", () => {
      const result = validDelegate(proto, "cto", "architect");
      const id = result.context!.taskId;
      const record = proto.getRecord(id);
      record.context.businessRationale = "hacked";
      expect(proto.getRecord(id).context.businessRationale).toBe(
        "Business needs feature X for Q2"
      );
    });

    it("throws for unknown task ID", () => {
      expect(() => proto.getRecord("no-such-id")).toThrow(/not found/);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits delegation lifecycle events when bus is provided", () => {
      const bus = new V4MessageBus();
      const graph = new OrgGraph();
      graph.addNode(makeNode("ceo", null, ["cto"]));
      graph.addNode(makeNode("cto", "ceo", ["arch"]));
      graph.addNode(makeNode("arch", "cto"));
      const busProto = new DelegationProtocol(graph, bus);

      const result = busProto.delegate("cto", "arch", "Task", "Rationale", [], [], "Output");
      expect(bus.getHistoryForTopic("delegation.issued")).toHaveLength(1);

      const taskId = result.context!.taskId;
      busProto.accept(taskId);
      expect(bus.getHistoryForTopic("delegation.accepted")).toHaveLength(1);

      busProto.complete(taskId, "done");
      expect(bus.getHistoryForTopic("delegation.completed")).toHaveLength(1);

      // Test reject
      const r2 = busProto.delegate("cto", "arch", "Task2", "R", [], [], "O");
      busProto.reject(r2.context!.taskId, "no capacity");
      expect(bus.getHistoryForTopic("delegation.rejected")).toHaveLength(1);

      // Test escalate
      const r3 = busProto.delegate("cto", "arch", "Task3", "R", [], [], "O");
      busProto.escalate(r3.context!.taskId, "blocked");
      expect(bus.getHistoryForTopic("delegation.escalated")).toHaveLength(1);
    });
  });
});
