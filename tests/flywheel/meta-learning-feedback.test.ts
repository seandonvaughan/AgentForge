import { describe, it, expect, beforeEach } from "vitest";
import {
  MetaLearningEngine,
  InMemoryTierPersistence,
  type SessionOutcome,
  type PromotionEvent,
} from "../../src/flywheel/meta-learning-engine.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

function makeSession(overrides?: Partial<SessionOutcome>): SessionOutcome {
  return {
    agentId: "cto",
    taskType: "analysis",
    success: true,
    durationMs: 3000,
    ...overrides,
  };
}

function successSessions(agentId: string, count: number): SessionOutcome[] {
  return Array.from({ length: count }, (_, i) => makeSession({ agentId, taskType: `task-${i}` }));
}

function failureSessions(agentId: string, count: number): SessionOutcome[] {
  return Array.from({ length: count }, (_, i) =>
    makeSession({ agentId, taskType: `task-${i}`, success: false, errorType: "timeout" })
  );
}

describe("MetaLearningEngine — processSessionOutcomes", () => {
  let engine: MetaLearningEngine;
  let persistence: InMemoryTierPersistence;

  beforeEach(() => {
    persistence = new InMemoryTierPersistence();
    engine = new MetaLearningEngine(undefined, persistence);
  });

  describe("promotion", () => {
    it("5 consecutive successes triggers a promotion event", async () => {
      const events = await engine.processSessionOutcomes(successSessions("cto", 5));
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe("cto");
      expect(events[0].fromTier).toBe(1);
      expect(events[0].toTier).toBe(2);
      expect(events[0].reason).toContain("consecutive successes");
    });

    it("fewer than 5 consecutive successes does not promote", async () => {
      const events = await engine.processSessionOutcomes(successSessions("cto", 4));
      expect(events).toHaveLength(0);
    });

    it("10 consecutive successes triggers two promotions (tier 1 → 2 → 3)", async () => {
      const events = await engine.processSessionOutcomes(successSessions("cto", 10));
      expect(events).toHaveLength(2);
      expect(events[0].toTier).toBe(2);
      expect(events[1].toTier).toBe(3);
    });

    it("promotion event contains a timestamp", async () => {
      const events = await engine.processSessionOutcomes(successSessions("cto", 5));
      expect(events[0].timestamp).toBeTruthy();
      expect(() => new Date(events[0].timestamp)).not.toThrow();
    });
  });

  describe("demotion", () => {
    it("3 consecutive failures triggers a demotion event", async () => {
      // First promote so there is room to demote
      await engine.processSessionOutcomes(successSessions("cto", 5));
      const events = await engine.processSessionOutcomes(failureSessions("cto", 3));
      expect(events).toHaveLength(1);
      expect(events[0].fromTier).toBe(2);
      expect(events[0].toTier).toBe(1);
      expect(events[0].reason).toContain("consecutive failures");
    });

    it("fewer than 3 consecutive failures does not demote", async () => {
      await engine.processSessionOutcomes(successSessions("cto", 5));
      const events = await engine.processSessionOutcomes(failureSessions("cto", 2));
      expect(events).toHaveLength(0);
    });
  });

  describe("tier caps", () => {
    it("tier is capped at 4 — no promotion above director", async () => {
      // Promote from tier 1 to tier 4 requires 15 consecutive successes (3 promotions)
      const events = await engine.processSessionOutcomes(successSessions("cto", 15));
      const finalTier = engine.getAgentTier("cto");
      expect(finalTier).toBe(4);
      // A 4th promotion batch should produce no events
      const extraEvents = await engine.processSessionOutcomes(successSessions("cto", 5));
      expect(extraEvents).toHaveLength(0);
      expect(engine.getAgentTier("cto")).toBe(4);
    });

    it("tier is floored at 1 — no demotion below supervised", async () => {
      // At tier 1, 3 failures should not demote further
      const events = await engine.processSessionOutcomes(failureSessions("cto", 3));
      expect(events).toHaveLength(0);
      expect(engine.getAgentTier("cto")).toBe(1);
    });
  });

  describe("persistence", () => {
    it("promotion events are written to TierPersistence", async () => {
      await engine.processSessionOutcomes(successSessions("cto", 5));
      const stored = await persistence.load();
      expect(stored.agents).toHaveLength(1);
      expect(stored.agents[0].agentId).toBe("cto");
      expect(stored.agents[0].tier).toBe(2);
      expect(stored.agents[0].history).toHaveLength(1);
    });

    it("multiple agents are persisted independently", async () => {
      await engine.processSessionOutcomes([
        ...successSessions("cto", 5),
        ...successSessions("architect", 5),
      ]);
      const stored = await persistence.load();
      expect(stored.agents).toHaveLength(2);
      const agentIds = stored.agents.map((a) => a.agentId);
      expect(agentIds).toContain("cto");
      expect(agentIds).toContain("architect");
    });

    it("subsequent promotions append to history", async () => {
      await engine.processSessionOutcomes(successSessions("cto", 5));
      await engine.processSessionOutcomes(successSessions("cto", 5));
      const stored = await persistence.load();
      expect(stored.agents[0].history).toHaveLength(2);
      expect(stored.agents[0].tier).toBe(3);
    });
  });

  describe("bus events", () => {
    it("emits flywheel.agent.promoted bus event on promotion", async () => {
      const bus = new V4MessageBus();
      const busEngine = new MetaLearningEngine(bus, persistence);
      await busEngine.processSessionOutcomes(successSessions("cto", 5));
      const promoted = bus.getHistoryForTopic("flywheel.agent.promoted");
      expect(promoted).toHaveLength(1);
      expect((promoted[0].payload as PromotionEvent).agentId).toBe("cto");
    });

    it("emits flywheel.agent.demoted bus event on demotion", async () => {
      const bus = new V4MessageBus();
      const busEngine = new MetaLearningEngine(bus, persistence);
      // Promote first
      await busEngine.processSessionOutcomes(successSessions("cto", 5));
      // Now demote
      await busEngine.processSessionOutcomes(failureSessions("cto", 3));
      const demoted = bus.getHistoryForTopic("flywheel.agent.demoted");
      expect(demoted).toHaveLength(1);
      expect((demoted[0].payload as PromotionEvent).toTier).toBe(1);
    });

    it("no bus event emitted when no tier change occurs", async () => {
      const bus = new V4MessageBus();
      const busEngine = new MetaLearningEngine(bus, persistence);
      await busEngine.processSessionOutcomes(successSessions("cto", 4));
      expect(bus.getHistoryForTopic("flywheel.agent.promoted")).toHaveLength(0);
    });
  });

  describe("InMemoryTierPersistence", () => {
    it("load returns empty agents array initially", async () => {
      const p = new InMemoryTierPersistence();
      const data = await p.load();
      expect(data.agents).toHaveLength(0);
    });

    it("save and load round-trip", async () => {
      const p = new InMemoryTierPersistence();
      const payload = { agents: [{ agentId: "cto", tier: 3, history: [] as PromotionEvent[] }] };
      await p.save(payload);
      const data = await p.load();
      expect(data.agents[0].agentId).toBe("cto");
      expect(data.agents[0].tier).toBe(3);
    });
  });
});
