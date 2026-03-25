import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../src/orchestrator/event-bus.js";
import type { TeamEvent } from "../../src/types/orchestration.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("subscribe", () => {
    it("should register an agent for specified event types", () => {
      bus.subscribe("coder", ["security_alert", "architecture_decision"]);

      expect(bus.getSubscribers("security_alert")).toContain("coder");
      expect(bus.getSubscribers("architecture_decision")).toContain("coder");
    });

    it("should allow multiple agents to subscribe to the same event type", () => {
      bus.subscribe("coder", ["security_alert"]);
      bus.subscribe("architect", ["security_alert"]);

      const subscribers = bus.getSubscribers("security_alert");
      expect(subscribers).toContain("coder");
      expect(subscribers).toContain("architect");
      expect(subscribers).toHaveLength(2);
    });

    it("should not duplicate subscriptions for the same agent and event type", () => {
      bus.subscribe("coder", ["security_alert"]);
      bus.subscribe("coder", ["security_alert"]);

      expect(bus.getSubscribers("security_alert")).toHaveLength(1);
    });
  });

  describe("publish", () => {
    it("should deliver to subscribed agents matching event.type", () => {
      bus.subscribe("coder", ["security_alert"]);
      bus.subscribe("architect", ["security_alert"]);
      bus.subscribe("devops", ["dependency_change"]);

      const event: TeamEvent = {
        type: "security_alert",
        source: "auditor",
        payload: { severity: "high" },
        notify: ["coder", "architect"],
      };

      const notified = bus.publish(event);

      expect(notified).toContain("coder");
      expect(notified).toContain("architect");
      expect(notified).not.toContain("devops");
    });

    it("should deliver to all subscribers when notify is ['*']", () => {
      bus.subscribe("coder", ["architecture_decision"]);
      bus.subscribe("devops", ["architecture_decision"]);
      bus.subscribe("tester", ["architecture_decision"]);

      const event: TeamEvent = {
        type: "architecture_decision",
        source: "architect",
        payload: { decision: "use REST" },
        notify: ["*"],
      };

      const notified = bus.publish(event);

      expect(notified).toContain("coder");
      expect(notified).toContain("devops");
      expect(notified).toContain("tester");
      expect(notified).toHaveLength(3);
    });

    it("should deliver only to specified agents in notify list", () => {
      bus.subscribe("coder", ["security_alert"]);
      bus.subscribe("architect", ["security_alert"]);
      bus.subscribe("devops", ["security_alert"]);

      const event: TeamEvent = {
        type: "security_alert",
        source: "auditor",
        payload: { cve: "CVE-2026-1234" },
        notify: ["coder", "devops"],
      };

      const notified = bus.publish(event);

      expect(notified).toContain("coder");
      expect(notified).toContain("devops");
      expect(notified).not.toContain("architect");
      expect(notified).toHaveLength(2);
    });

    it("should not deliver to agents in notify list who are not subscribed to the event type", () => {
      bus.subscribe("coder", ["dependency_change"]);
      // coder is NOT subscribed to security_alert

      const event: TeamEvent = {
        type: "security_alert",
        source: "auditor",
        payload: {},
        notify: ["coder"],
      };

      const notified = bus.publish(event);

      expect(notified).not.toContain("coder");
      expect(notified).toHaveLength(0);
    });

    it("should return the list of notified agent names", () => {
      bus.subscribe("coder", ["milestone_reached"]);
      bus.subscribe("tester", ["milestone_reached"]);

      const event: TeamEvent = {
        type: "milestone_reached",
        source: "pm",
        payload: { milestone: "v1.0" },
        notify: ["*"],
      };

      const notified = bus.publish(event);

      expect(Array.isArray(notified)).toBe(true);
      expect(notified).toEqual(expect.arrayContaining(["coder", "tester"]));
      expect(notified).toHaveLength(2);
    });

    it("should return empty array when no one is subscribed", () => {
      const event: TeamEvent = {
        type: "security_alert",
        source: "auditor",
        payload: {},
        notify: ["*"],
      };

      const notified = bus.publish(event);

      expect(notified).toEqual([]);
    });
  });

  describe("getSubscribers", () => {
    it("should return subscribed agent names for a given event type", () => {
      bus.subscribe("coder", ["security_alert", "dependency_change"]);
      bus.subscribe("architect", ["security_alert"]);

      const subscribers = bus.getSubscribers("security_alert");

      expect(subscribers).toContain("coder");
      expect(subscribers).toContain("architect");
      expect(subscribers).toHaveLength(2);
    });

    it("should return empty array for event type with no subscribers", () => {
      const subscribers = bus.getSubscribers("nonexistent_event");

      expect(subscribers).toEqual([]);
    });
  });

  describe("unsubscribe", () => {
    it("should remove all subscriptions for an agent", () => {
      bus.subscribe("coder", ["security_alert", "architecture_decision", "dependency_change"]);
      bus.subscribe("architect", ["security_alert"]);

      bus.unsubscribe("coder");

      expect(bus.getSubscribers("security_alert")).not.toContain("coder");
      expect(bus.getSubscribers("architecture_decision")).not.toContain("coder");
      expect(bus.getSubscribers("dependency_change")).not.toContain("coder");
      // architect should remain
      expect(bus.getSubscribers("security_alert")).toContain("architect");
    });

    it("should be a no-op for an agent that is not subscribed", () => {
      bus.subscribe("coder", ["security_alert"]);

      // Should not throw
      bus.unsubscribe("nonexistent_agent");

      expect(bus.getSubscribers("security_alert")).toContain("coder");
    });
  });
});
