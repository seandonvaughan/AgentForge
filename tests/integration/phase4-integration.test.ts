/**
 * Phase 4 Integration Tests — Sprint 4.4
 *
 * Gate criteria:
 *  - Sessions persist and resume across simulated failures
 *  - REFORGE creates snapshot, applies change, verifies, and rolls back successfully
 *  - REFORGE auto-rollback triggers on timeout (>120s test)
 *  - API stability audit complete: all public APIs classified
 *  - Deprecation policy documented and enforced
 */

import { describe, it, expect } from "vitest";
import { V4SessionManager } from "../../src/session/v4-session-manager.js";
import { V4ReforgeEngine, REFORGE_TIMEOUT_MS } from "../../src/reforge/v4-reforge-engine.js";
import { APIStabilityAuditor } from "../../src/api/api-stability-auditor.js";
import type { ReforgeGuardrail } from "../../src/reforge/v4-reforge-engine.js";

// ── Gate 1: Session persist + resume across failures ─────────────────────

describe("Phase 4 gate — session persist/resume", () => {
  it("session survives serialization round-trip (simulated crash)", () => {
    const mgr = new V4SessionManager();
    const s1 = mgr.create({ taskDescription: "Build v4 bus", agentId: "cto", autonomyTier: 3 });
    mgr.addContext(s1.sessionId, "prior-session", "Bus design decisions");
    mgr.persist(s1.sessionId);

    // Simulate crash: serialize → new manager → restore
    const snapshot = mgr.toJSON();
    const restored = V4SessionManager.fromJSON(snapshot);

    const s1r = restored.get(s1.sessionId)!;
    expect(s1r.status).toBe("persisted");
    expect(s1r.contextChain).toHaveLength(1);

    // Resume after restore
    const resumed = restored.resume(s1.sessionId);
    expect(resumed.status).toBe("active");
    expect(resumed.resumeCount).toBe(1);
  });

  it("multiple persist/resume cycles preserve state", () => {
    const mgr = new V4SessionManager();
    const s = mgr.create({ taskDescription: "Multi-phase task", agentId: "arch", autonomyTier: 2 });

    for (let i = 0; i < 5; i++) {
      mgr.persist(s.sessionId);
      const snap = mgr.toJSON();
      const restored = V4SessionManager.fromJSON(snap);
      restored.resume(s.sessionId);
      // Re-serialize for next iteration
      const snap2 = restored.toJSON();
      const mgr2 = V4SessionManager.fromJSON(snap2);
      expect(mgr2.get(s.sessionId)!.resumeCount).toBe(i + 1);
      // Use restored manager for next cycle
      mgr._setForTest(s.sessionId, mgr2.get(s.sessionId)!);
    }
  });
});

// ── Gate 2: REFORGE full lifecycle ───────────────────────────────────────

describe("Phase 4 gate — REFORGE lifecycle", () => {
  const standardGuardrails: ReforgeGuardrail[] = [
    {
      name: "scope-boundary",
      validate: (p) => ({
        pass: p.targetFile.startsWith(".agentforge/"),
        reason: p.targetFile.startsWith(".agentforge/") ? undefined : "Scope violation: only .agentforge/ files allowed",
      }),
    },
    {
      name: "safety-check",
      validate: (p) => ({
        pass: !p.diff.includes("rm -rf"),
        reason: p.diff.includes("rm -rf") ? "Dangerous operation detected" : undefined,
      }),
    },
    {
      name: "rationale-required",
      validate: (p) => ({
        pass: p.rationale.length > 10,
        reason: p.rationale.length <= 10 ? "Rationale too short" : undefined,
      }),
    },
  ];

  it("submit → evaluate → apply → verify (full success path)", () => {
    const engine = new V4ReforgeEngine(standardGuardrails);
    engine.submit({
      proposalId: "gate-test",
      description: "Update CTO prompt",
      targetFile: ".agentforge/agents/cto.yaml",
      changeType: "modify",
      diff: "- old\n+ new",
      proposedBy: "reforge-engine",
      rationale: "Improve decision quality based on sprint 1 learnings",
    });

    const evaluated = engine.evaluate("gate-test");
    expect(evaluated.status).toBe("approved");
    expect(evaluated.guardrailResults).toHaveLength(3);

    const applied = engine.apply("gate-test");
    expect(applied.snapshotTag).toMatch(/^reforge-/);

    const verified = engine.verify("gate-test");
    expect(verified.status).toBe("verified");

    const history = engine.getHistory("gate-test");
    expect(history.map((h) => h.status)).toEqual(["pending", "approved", "applied", "verified"]);
  });

  it("rollback restores after apply", () => {
    const engine = new V4ReforgeEngine(standardGuardrails);
    engine.submit({
      proposalId: "rollback-test",
      description: "Risky change",
      targetFile: ".agentforge/agents/arch.yaml",
      changeType: "modify",
      diff: "- safe\n+ risky",
      proposedBy: "reforge-engine",
      rationale: "Testing rollback capability for safety",
    });
    engine.evaluate("rollback-test");
    engine.apply("rollback-test");
    const rolled = engine.rollback("rollback-test");
    expect(rolled.status).toBe("rolled_back");
  });

  it("guardrail rejection blocks apply", () => {
    const engine = new V4ReforgeEngine(standardGuardrails);
    engine.submit({
      proposalId: "scope-violation",
      description: "Bad change",
      targetFile: "src/important.ts", // NOT in .agentforge/
      changeType: "modify",
      diff: "dangerous",
      proposedBy: "rogue",
      rationale: "This should be blocked by scope boundary guardrail",
    });
    const result = engine.evaluate("scope-violation");
    expect(result.status).toBe("rejected");
    expect(() => engine.apply("scope-violation")).toThrow(/approved/);
  });
});

// ── Gate 3: REFORGE auto-rollback on timeout ─────────────────────────────

describe("Phase 4 gate — REFORGE timeout auto-rollback", () => {
  it("auto-rolls back proposals exceeding 120s", () => {
    const engine = new V4ReforgeEngine([
      { name: "pass", validate: () => ({ pass: true }) },
    ]);
    engine.submit({
      proposalId: "timeout-test",
      description: "Slow change",
      targetFile: ".agentforge/agents/x.yaml",
      changeType: "modify",
      diff: "+slow",
      proposedBy: "engine",
      rationale: "Testing timeout auto-rollback behavior",
    });
    engine.evaluate("timeout-test");
    engine.apply("timeout-test");

    // Simulate passage of time beyond timeout
    engine._setAppliedAtForTest("timeout-test", Date.now() - REFORGE_TIMEOUT_MS - 1);
    const rolledBack = engine.checkTimeouts();
    expect(rolledBack).toContain("timeout-test");
    expect(engine.getProposal("timeout-test")!.status).toBe("rolled_back");
  });

  it("does not roll back within timeout window", () => {
    const engine = new V4ReforgeEngine([
      { name: "pass", validate: () => ({ pass: true }) },
    ]);
    engine.submit({
      proposalId: "fresh",
      description: "Fresh change",
      targetFile: ".agentforge/agents/x.yaml",
      changeType: "modify",
      diff: "+fresh",
      proposedBy: "engine",
      rationale: "Testing that recent applies are not rolled back",
    });
    engine.evaluate("fresh");
    engine.apply("fresh");
    expect(engine.checkTimeouts()).toHaveLength(0);
  });

  it("REFORGE_TIMEOUT_MS is 120000", () => {
    expect(REFORGE_TIMEOUT_MS).toBe(120_000);
  });
});

// ── Gate 4: API stability audit ──────────────────────────────────────────

describe("Phase 4 gate — API stability audit", () => {
  it("all v4 public APIs classified as stable/beta/experimental", () => {
    const auditor = new APIStabilityAuditor();
    // Register all v4 public APIs
    const apis = [
      { name: "V4MessageBus", module: "communication", stability: "stable" as const },
      { name: "ReviewRouter", module: "communication", stability: "stable" as const },
      { name: "MeetingCoordinator", module: "communication", stability: "stable" as const },
      { name: "ChannelManager", module: "communication", stability: "stable" as const },
      { name: "ExecAssistant", module: "communication", stability: "stable" as const },
      { name: "OrgGraph", module: "org-graph", stability: "stable" as const },
      { name: "RoleRegistry", module: "registry", stability: "stable" as const },
      { name: "DelegationProtocol", module: "org-graph", stability: "stable" as const },
      { name: "AccountabilityTracker", module: "registry", stability: "stable" as const },
      { name: "MemoryRegistry", module: "registry", stability: "stable" as const },
      { name: "StorageGovernor", module: "registry", stability: "stable" as const },
      { name: "MCPMemoryProvider", module: "memory", stability: "beta" as const },
      { name: "SemanticSearch", module: "memory", stability: "beta" as const },
      { name: "V4SessionManager", module: "session", stability: "beta" as const },
      { name: "V4ReforgeEngine", module: "reforge", stability: "experimental" as const },
      { name: "APIStabilityAuditor", module: "api", stability: "beta" as const },
    ];
    for (const api of apis) {
      auditor.register({ ...api, exportType: "class", version: "1.0.0" });
    }

    const report = auditor.generateReport();
    expect(report.totalAPIs).toBe(16);
    expect(report.stable.length).toBeGreaterThan(0);
    expect(report.beta.length).toBeGreaterThan(0);
    expect(report.experimental.length).toBeGreaterThan(0);
    // Every API has a classification
    const total = report.stable.length + report.beta.length + report.experimental.length;
    expect(total).toBe(report.totalAPIs);
  });

  it("deprecation policy: removed stable APIs are flagged as breaking", () => {
    const v1 = new APIStabilityAuditor();
    v1.register({ name: "OldAPI", module: "legacy", exportType: "class", stability: "stable", version: "1.0.0" });
    v1.register({ name: "NewAPI", module: "v4", exportType: "class", stability: "stable", version: "1.0.0" });

    const v2 = new APIStabilityAuditor();
    v2.register({ name: "NewAPI", module: "v4", exportType: "class", stability: "stable", version: "2.0.0" });
    // OldAPI removed

    const breaking = v1.detectBreakingChanges(v2);
    expect(breaking).toHaveLength(1);
    expect(breaking[0].name).toBe("OldAPI");
    expect(breaking[0].type).toBe("removed");
  });
});

// ── Gate 5: All Phase 4 components compose ───────────────────────────────

describe("Phase 4 gate — full composition", () => {
  it("session + REFORGE + API audit work together", () => {
    const sessionMgr = new V4SessionManager();
    const engine = new V4ReforgeEngine([
      { name: "pass-all", validate: () => ({ pass: true }) },
    ]);
    const auditor = new APIStabilityAuditor();

    // 1. Create a session for the REFORGE work
    const session = sessionMgr.create({
      taskDescription: "REFORGE CTO prompt",
      agentId: "reforge-engine-agent",
      autonomyTier: 2,
    });

    // 2. Submit and execute REFORGE
    engine.submit({
      proposalId: `reforge-${session.sessionId}`,
      description: "Update CTO agent prompt",
      targetFile: ".agentforge/agents/cto.yaml",
      changeType: "modify",
      diff: "+improved prompt",
      proposedBy: session.agentId,
      rationale: "Meta-learning identified better prompt patterns",
    });
    engine.evaluate(`reforge-${session.sessionId}`);
    engine.apply(`reforge-${session.sessionId}`);
    engine.verify(`reforge-${session.sessionId}`);

    // 3. Complete session
    sessionMgr.complete(session.sessionId, "REFORGE verified");

    // 4. Register in API audit
    auditor.register({ name: "V4ReforgeEngine", module: "reforge", exportType: "class", stability: "experimental", version: "1.0.0" });

    expect(sessionMgr.get(session.sessionId)!.status).toBe("completed");
    expect(engine.getProposal(`reforge-${session.sessionId}`)!.status).toBe("verified");
    expect(auditor.count()).toBe(1);
  });
});
