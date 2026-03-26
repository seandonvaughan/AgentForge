import { describe, it, expect, beforeEach } from "vitest";
import {
  V4ReforgeEngine,
  type ReforgeProposal,
  type ReforgeGuardrail,
  REFORGE_TIMEOUT_MS,
} from "../../src/reforge/v4-reforge-engine.js";

function makeProposal(overrides?: Partial<ReforgeProposal>): ReforgeProposal {
  return {
    proposalId: "test-proposal",
    description: "Update agent prompt template",
    targetFile: ".agentforge/agents/cto.yaml",
    changeType: "modify",
    diff: "- old prompt\n+ new prompt",
    proposedBy: "reforge-engine-agent",
    rationale: "Improve decision quality based on meta-learning",
    ...overrides,
  };
}

describe("V4ReforgeEngine", () => {
  let engine: V4ReforgeEngine;
  beforeEach(() => { engine = new V4ReforgeEngine(); });

  describe("submit", () => {
    it("creates a proposal in pending state", () => {
      const p = engine.submit(makeProposal());
      expect(p.status).toBe("pending");
      expect(p.proposal.proposalId).toBe("test-proposal");
    });
    it("throws on duplicate proposal id", () => {
      engine.submit(makeProposal());
      expect(() => engine.submit(makeProposal())).toThrow(/already exists/);
    });
  });

  describe("guardrail pipeline", () => {
    it("passes all guardrails → approved", () => {
      const guardrails: ReforgeGuardrail[] = [
        { name: "scope-check", validate: () => ({ pass: true }) },
        { name: "safety-check", validate: () => ({ pass: true }) },
      ];
      engine = new V4ReforgeEngine(guardrails);
      engine.submit(makeProposal());
      const result = engine.evaluate("test-proposal");
      expect(result.status).toBe("approved");
      expect(result.guardrailResults).toHaveLength(2);
      expect(result.guardrailResults.every((r) => r.pass)).toBe(true);
    });
    it("fails any guardrail → rejected", () => {
      const guardrails: ReforgeGuardrail[] = [
        { name: "scope-check", validate: () => ({ pass: true }) },
        { name: "safety-check", validate: () => ({ pass: false, reason: "Too risky" }) },
      ];
      engine = new V4ReforgeEngine(guardrails);
      engine.submit(makeProposal());
      const result = engine.evaluate("test-proposal");
      expect(result.status).toBe("rejected");
      expect(result.guardrailResults[1].pass).toBe(false);
      expect(result.guardrailResults[1].reason).toBe("Too risky");
    });
  });

  describe("apply", () => {
    it("applies an approved proposal (creates snapshot)", () => {
      engine = new V4ReforgeEngine([
        { name: "pass-all", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      const applied = engine.apply("test-proposal");
      expect(applied.status).toBe("applied");
      expect(applied.snapshotTag).toBeTruthy();
    });
    it("throws if proposal not approved", () => {
      engine.submit(makeProposal());
      expect(() => engine.apply("test-proposal")).toThrow(/approved/);
    });
  });

  describe("rollback", () => {
    it("rolls back an applied proposal", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      engine.apply("test-proposal");
      const rolled = engine.rollback("test-proposal");
      expect(rolled.status).toBe("rolled_back");
    });
    it("throws if not applied", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      expect(() => engine.rollback("test-proposal")).toThrow(/applied/);
    });
  });

  describe("verify", () => {
    it("verifies an applied proposal → verified", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      engine.apply("test-proposal");
      const verified = engine.verify("test-proposal");
      expect(verified.status).toBe("verified");
    });
  });

  describe("full lifecycle: submit → evaluate → apply → verify", () => {
    it("completes successfully", () => {
      engine = new V4ReforgeEngine([
        { name: "scope", validate: () => ({ pass: true }) },
        { name: "safety", validate: () => ({ pass: true }) },
        { name: "budget", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal({ proposalId: "lifecycle" }));
      const evaluated = engine.evaluate("lifecycle");
      expect(evaluated.status).toBe("approved");
      const applied = engine.apply("lifecycle");
      expect(applied.snapshotTag).toMatch(/^reforge-/);
      const verified = engine.verify("lifecycle");
      expect(verified.status).toBe("verified");
    });
  });

  describe("timeout constant", () => {
    it("REFORGE_TIMEOUT_MS is 120000 (120s)", () => {
      expect(REFORGE_TIMEOUT_MS).toBe(120000);
    });
  });

  describe("query", () => {
    it("getProposal returns proposal by id", () => {
      engine.submit(makeProposal());
      expect(engine.getProposal("test-proposal")).not.toBeNull();
    });
    it("listProposals returns all proposals", () => {
      engine.submit(makeProposal({ proposalId: "a" }));
      engine.submit(makeProposal({ proposalId: "b" }));
      expect(engine.listProposals()).toHaveLength(2);
    });
    it("getHistory returns status transitions", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      engine.apply("test-proposal");
      const history = engine.getHistory("test-proposal");
      expect(history.map((h) => h.status)).toEqual(["pending", "approved", "applied"]);
    });
  });

  describe("auto-rollback on timeout", () => {
    it("checkTimeouts rolls back proposals applied more than REFORGE_TIMEOUT_MS ago", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      engine.apply("test-proposal");

      // Force the applied timestamp to be old
      engine._setAppliedAtForTest("test-proposal", Date.now() - REFORGE_TIMEOUT_MS - 1);
      const rolledBack = engine.checkTimeouts();
      expect(rolledBack).toContain("test-proposal");
      expect(engine.getProposal("test-proposal")!.status).toBe("rolled_back");
    });
    it("does not roll back recently applied proposals", () => {
      engine = new V4ReforgeEngine([
        { name: "pass", validate: () => ({ pass: true }) },
      ]);
      engine.submit(makeProposal());
      engine.evaluate("test-proposal");
      engine.apply("test-proposal");
      const rolledBack = engine.checkTimeouts();
      expect(rolledBack).toHaveLength(0);
    });
  });

  describe("immutability", () => {
    it("returned proposals are copies", () => {
      engine.submit(makeProposal());
      const p = engine.getProposal("test-proposal")!;
      p.description = "MUTATED";
      expect(engine.getProposal("test-proposal")!.description).not.toBe("MUTATED");
    });
  });
});
