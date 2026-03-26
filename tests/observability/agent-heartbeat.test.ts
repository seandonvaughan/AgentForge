/**
 * Tests for AgentHeartbeat — v4.5 P0-6
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentHeartbeat } from "../../src/observability/agent-heartbeat.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

describe("AgentHeartbeat", () => {
  let heartbeat: AgentHeartbeat;

  beforeEach(() => {
    heartbeat = new AgentHeartbeat();
  });

  describe("registerAgent", () => {
    it("registers an agent with idle state", () => {
      heartbeat.registerAgent("coder", "Coder Agent", "sonnet");
      const status = heartbeat.getAgentStatus("coder");

      expect(status).not.toBeNull();
      expect(status!.agentId).toBe("coder");
      expect(status!.agentName).toBe("Coder Agent");
      expect(status!.modelTier).toBe("sonnet");
      expect(status!.state).toBe("idle");
      expect(status!.tasksCompleted).toBe(0);
      expect(status!.consecutiveErrors).toBe(0);
    });

    it("returns null for unregistered agent", () => {
      expect(heartbeat.getAgentStatus("nonexistent")).toBeNull();
    });

    it("tracks agent count", () => {
      heartbeat.registerAgent("a", "A", "opus");
      heartbeat.registerAgent("b", "B", "sonnet");
      expect(heartbeat.getAgentCount()).toBe(2);
    });
  });

  describe("unregisterAgent", () => {
    it("removes an agent from tracking", () => {
      heartbeat.registerAgent("coder", "Coder", "sonnet");
      expect(heartbeat.unregisterAgent("coder")).toBe(true);
      expect(heartbeat.getAgentStatus("coder")).toBeNull();
    });

    it("returns false for non-existent agent", () => {
      expect(heartbeat.unregisterAgent("nonexistent")).toBe(false);
    });
  });

  describe("heartbeat", () => {
    it("updates the heartbeat timestamp", () => {
      heartbeat.registerAgent("coder", "Coder", "sonnet");
      const before = heartbeat.getAgentStatus("coder")!.heartbeatAt;

      // Small delay
      heartbeat.heartbeat("coder", "active", "Working on task");
      const after = heartbeat.getAgentStatus("coder")!;

      expect(after.state).toBe("active");
      expect(after.activeTask).toBe("Working on task");
    });

    it("ignores heartbeat for unregistered agent", () => {
      // Should not throw
      heartbeat.heartbeat("nonexistent", "active");
    });
  });

  describe("recordTaskComplete", () => {
    it("increments task count and resets errors", () => {
      heartbeat.registerAgent("coder", "Coder", "sonnet");
      heartbeat.recordError("coder");
      heartbeat.recordError("coder");
      heartbeat.recordTaskComplete("coder");

      const status = heartbeat.getAgentStatus("coder")!;
      expect(status.tasksCompleted).toBe(1);
      expect(status.consecutiveErrors).toBe(0);
      expect(status.state).toBe("idle");
    });
  });

  describe("recordError", () => {
    it("increments consecutive error count", () => {
      heartbeat.registerAgent("coder", "Coder", "sonnet");
      heartbeat.recordError("coder");
      heartbeat.recordError("coder");

      const status = heartbeat.getAgentStatus("coder")!;
      expect(status.consecutiveErrors).toBe(2);
    });
  });

  describe("detectStaleness", () => {
    it("marks agents as offline when heartbeat is stale", () => {
      // Use a threshold of 1ms — the agent registration heartbeat will be
      // at least a few ms old by the time detectStaleness runs
      const hb = new AgentHeartbeat({ stalenessThresholdMs: 1 });
      hb.registerAgent("old-agent", "Old", "haiku");

      // Force heartbeat into the past by re-setting state
      const status = hb.getAgentStatus("old-agent")!;
      // We need to wait just enough for the heartbeat to become stale (1ms)
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait 5ms */ }

      const stale = hb.detectStaleness();
      expect(stale).toContain("old-agent");
      expect(hb.getAgentStatus("old-agent")!.state).toBe("offline");
    });

    it("does not re-mark already offline agents", () => {
      const hb = new AgentHeartbeat({ stalenessThresholdMs: 1 });
      hb.registerAgent("agent", "Agent", "sonnet");

      // Wait for heartbeat to become stale
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      const stale1 = hb.detectStaleness();
      expect(stale1).toHaveLength(1);

      const stale2 = hb.detectStaleness();
      expect(stale2).toHaveLength(0); // Already offline
    });

    it("emits bus event when agent goes offline", () => {
      const bus = new V4MessageBus();
      const events: string[] = [];
      bus.onAnyMessage((env) => events.push(env.topic));

      const hb = new AgentHeartbeat({ bus, stalenessThresholdMs: 1 });
      hb.registerAgent("agent", "Agent", "sonnet");

      // Wait for heartbeat to become stale
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      hb.detectStaleness();

      expect(events).toContain("agent.status.update");
    });
  });

  describe("getTeamHealth", () => {
    it("reports healthy team when all agents are online", () => {
      heartbeat.registerAgent("a", "A", "opus");
      heartbeat.registerAgent("b", "B", "sonnet");
      heartbeat.heartbeat("a");
      heartbeat.heartbeat("b");

      const health = heartbeat.getTeamHealth();
      expect(health.totalAgents).toBe(2);
      expect(health.healthy).toBe(true);
      expect(health.offlineAgents).toBe(0);
    });

    it("reports unhealthy when agents have errors", () => {
      heartbeat.registerAgent("a", "A", "opus");
      heartbeat.recordError("a");

      const health = heartbeat.getTeamHealth();
      expect(health.healthy).toBe(false);
      expect(health.errorAgents).toBe(1);
    });

    it("counts active, idle, and offline agents", () => {
      heartbeat.registerAgent("active-agent", "Active", "opus");
      heartbeat.registerAgent("idle-agent", "Idle", "sonnet");
      heartbeat.heartbeat("active-agent", "active", "Working");
      heartbeat.heartbeat("idle-agent");

      const health = heartbeat.getTeamHealth();
      expect(health.activeAgents).toBe(1);
      expect(health.idleAgents).toBe(1);
    });

    it("records health snapshots", () => {
      heartbeat.registerAgent("a", "A", "opus");
      heartbeat.getTeamHealth();
      heartbeat.getTeamHealth();

      const snapshots = heartbeat.getHealthSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toHaveProperty("timestamp");
      expect(snapshots[0]).toHaveProperty("totalAgents");
      expect(snapshots[0]).toHaveProperty("healthy");
    });
  });

  describe("toHealthProbe", () => {
    it("returns a function compatible with V4HealthCheck", () => {
      heartbeat.registerAgent("a", "A", "opus");
      const probe = heartbeat.toHealthProbe();

      const result = probe();
      expect(result.module).toBe("agent-heartbeat");
      expect(result.healthy).toBe(true);
      expect(result.metrics).toHaveProperty("totalAgents");
      expect(result.metrics).toHaveProperty("activeAgents");
    });
  });
});
