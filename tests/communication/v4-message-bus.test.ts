import { describe, it, expect, beforeEach } from "vitest";
import { V4MessageBus, registerStandardTopics } from "../../src/communication/v4-message-bus.js";

describe("V4MessageBus", () => {
  let bus: V4MessageBus;
  beforeEach(() => { bus = new V4MessageBus(); });

  describe("topic registry", () => {
    it("registers and retrieves topics", () => {
      bus.registerTopic({ topic: "agent.task.assign", description: "test" });
      expect(bus.hasTopic("agent.task.assign")).toBe(true);
    });
    it("lists all registered topics sorted", () => {
      bus.registerTopic({ topic: "b.topic", description: "" });
      bus.registerTopic({ topic: "a.topic", description: "" });
      const topics = bus.listTopics();
      expect(topics[0]).toBe("a.topic");
    });
    it("registerStandardTopics registers all standard topics (18 base + v4.1 extensions)", () => {
      registerStandardTopics(bus);
      expect(bus.listTopics().length).toBeGreaterThanOrEqual(18);
    });
  });

  describe("publish", () => {
    it("returns envelope with correct fields", () => {
      const env = bus.publish({ from: "a1", to: "a2", topic: "agent.task.assign",
        category: "task", payload: { x: 1 } });
      expect(env.id).toBeTruthy();
      expect(env.version).toBe("4.0");
      expect(env.from).toBe("a1");
      expect(env.topic).toBe("agent.task.assign");
      expect(env.payload).toEqual({ x: 1 });
      expect(env.priority).toBe("normal");
    });
    it("adds to history", () => {
      bus.publish({ from: "a1", to: "a2", topic: "t", category: "status", payload: {} });
      expect(bus.getHistory()).toHaveLength(1);
    });
    it("validates payload when validator provided", () => {
      bus.registerTopic({ topic: "strict", description: "", validator: (p) => typeof p === "string" });
      expect(() => bus.publish({ from: "a", to: "b", topic: "strict", category: "status", payload: 42 }))
        .toThrow(/validation failed/);
    });
  });

  describe("subscribe (exact topic)", () => {
    it("receives messages on subscribed topic", () => {
      const received: unknown[] = [];
      bus.subscribe("my.topic", (e) => received.push(e.payload));
      bus.publish({ from: "a", to: "b", topic: "my.topic", category: "status",
        payload: "hello", priority: "urgent" });
      expect(received).toEqual(["hello"]);
    });
    it("does not receive messages on other topics", () => {
      const received: unknown[] = [];
      bus.subscribe("my.topic", (e) => received.push(e));
      bus.publish({ from: "a", to: "b", topic: "other.topic", category: "status",
        payload: "x", priority: "urgent" });
      expect(received).toHaveLength(0);
    });
    it("unsubscribe stops delivery", () => {
      const received: unknown[] = [];
      const unsub = bus.subscribe("t", (e) => received.push(e));
      unsub();
      bus.publish({ from: "a", to: "b", topic: "t", category: "status",
        payload: "x", priority: "urgent" });
      expect(received).toHaveLength(0);
    });
  });

  describe("subscribeWildcard", () => {
    it("receives all topics starting with prefix", () => {
      const received: string[] = [];
      bus.subscribeWildcard("review", (e) => received.push(e.topic));
      bus.publish({ from: "a", to: "b", topic: "review.lifecycle.assigned",
        category: "review", payload: {}, priority: "urgent" });
      bus.publish({ from: "a", to: "b", topic: "review.lifecycle.approved",
        category: "review", payload: {}, priority: "urgent" });
      bus.publish({ from: "a", to: "b", topic: "agent.task.assign",
        category: "task", payload: {}, priority: "urgent" });
      expect(received).toEqual(["review.lifecycle.assigned", "review.lifecycle.approved"]);
    });
  });

  describe("priority queue and drain()", () => {
    it("queues non-urgent messages", () => {
      bus.publish({ from: "a", to: "b", topic: "t", category: "status", payload: 1, priority: "normal" });
      expect(bus.pendingCount()).toBe(1);
    });
    it("urgent messages bypass queue", () => {
      const received: number[] = [];
      bus.subscribe("t", (e) => received.push(e.payload as number));
      bus.publish({ from: "a", to: "b", topic: "t", category: "status", payload: 1, priority: "urgent" });
      expect(received).toEqual([1]);
      expect(bus.pendingCount()).toBe(0);
    });
    it("drain delivers in priority order", () => {
      const received: string[] = [];
      bus.subscribe("t", (e) => received.push(e.payload as string));
      bus.publish({ from: "a", to: "b", topic: "t", category: "status", payload: "low", priority: "low" });
      bus.publish({ from: "a", to: "b", topic: "t", category: "status", payload: "high", priority: "high" });
      bus.publish({ from: "a", to: "b", topic: "t", category: "status", payload: "normal", priority: "normal" });
      bus.drain();
      expect(received).toEqual(["high", "normal", "low"]);
    });
  });

  describe("history", () => {
    it("getHistoryForTopic filters correctly", () => {
      bus.publish({ from: "a", to: "b", topic: "t1", category: "task", payload: {}, priority: "urgent" });
      bus.publish({ from: "a", to: "b", topic: "t2", category: "task", payload: {}, priority: "urgent" });
      expect(bus.getHistoryForTopic("t1")).toHaveLength(1);
    });
    it("clearHistory empties it", () => {
      bus.publish({ from: "a", to: "b", topic: "t", category: "task", payload: {}, priority: "urgent" });
      bus.clearHistory();
      expect(bus.getHistory()).toHaveLength(0);
    });
  });

  describe("onAnyMessage", () => {
    it("global listener receives all messages", () => {
      const received: string[] = [];
      bus.onAnyMessage((e) => received.push(e.topic));
      bus.publish({ from: "a", to: "b", topic: "t1", category: "status", payload: {}, priority: "urgent" });
      bus.publish({ from: "a", to: "b", topic: "t2", category: "status", payload: {}, priority: "urgent" });
      expect(received).toEqual(["t1", "t2"]);
    });
  });

  describe("TTL expiry", () => {
    it("expired messages are not delivered on drain()", () => {
      const received: unknown[] = [];
      bus.subscribe("t", (e) => received.push(e));
      const past = new Date(Date.now() - 1000).toISOString();
      bus.publish({ from: "a", to: "b", topic: "t", category: "status",
        payload: "expired", priority: "low", ttl: past });
      bus.drain();
      expect(received).toHaveLength(0);
    });
    it("non-expired messages are delivered", () => {
      const received: unknown[] = [];
      bus.subscribe("t", (e) => received.push(e));
      const future = new Date(Date.now() + 60000).toISOString();
      bus.publish({ from: "a", to: "b", topic: "t", category: "status",
        payload: "valid", priority: "low", ttl: future });
      bus.drain();
      expect(received).toHaveLength(1);
    });
  });
});
