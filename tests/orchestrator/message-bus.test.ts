import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../src/orchestrator/event-bus.js";
import { MessageBus } from "../../src/orchestrator/message-bus.js";
import type { TeamEvent } from "../../src/types/orchestration.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(type: string, source = "test-agent"): TeamEvent {
  return { type, source, payload: { data: type }, notify: ["*"] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageBus", () => {
  let eventBus: EventBus;
  let bus: MessageBus;

  beforeEach(() => {
    eventBus = new EventBus();
    bus = new MessageBus(eventBus);
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  it("wraps an EventBus without modifying it", () => {
    expect(bus.getEventBus()).toBe(eventBus);
  });

  // ── Handler Registration ────────────────────────────────────────────────

  it("registers handlers and invokes them on publish", async () => {
    const received: TeamEvent[] = [];
    bus.register("h1", ["alert"], async (e) => { received.push(e); });

    await bus.publish(makeEvent("alert"), "urgent");
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("alert");
  });

  it("does not invoke handlers for non-matching event types", async () => {
    const received: TeamEvent[] = [];
    bus.register("h1", ["alert"], async (e) => { received.push(e); });

    await bus.publish(makeEvent("info"), "urgent");
    expect(received).toHaveLength(0);
  });

  it("supports wildcard handler registration", async () => {
    const received: TeamEvent[] = [];
    bus.register("h1", ["*"], async (e) => { received.push(e); });

    await bus.publish(makeEvent("any-event"), "urgent");
    expect(received).toHaveLength(1);
  });

  it("unregisters handlers", async () => {
    const received: TeamEvent[] = [];
    bus.register("h1", ["alert"], async (e) => { received.push(e); });
    bus.unregister("h1");

    await bus.publish(makeEvent("alert"), "urgent");
    expect(received).toHaveLength(0);
  });

  // ── Priority Queuing ────────────────────────────────────────────────────

  it("processes urgent events immediately (not queued)", async () => {
    const received: string[] = [];
    bus.register("h1", ["alert"], async () => { received.push("handled"); });

    await bus.publish(makeEvent("alert"), "urgent");
    expect(received).toHaveLength(1);
    expect(bus.getPendingCount()).toBe(0);
  });

  it("queues non-urgent events for drain()", async () => {
    const received: string[] = [];
    bus.register("h1", ["alert"], async () => { received.push("handled"); });

    await bus.publish(makeEvent("alert"), "normal");
    expect(received).toHaveLength(0); // Not yet processed
    expect(bus.getPendingCount()).toBe(1);

    await bus.drain();
    expect(received).toHaveLength(1);
    expect(bus.getPendingCount()).toBe(0);
  });

  it("drain processes events in priority order (high before low)", async () => {
    const order: string[] = [];
    bus.register("h1", ["*"], async (e) => { order.push(e.source); });

    await bus.publish(makeEvent("x", "low-agent"), "low");
    await bus.publish(makeEvent("x", "high-agent"), "high");
    await bus.publish(makeEvent("x", "normal-agent"), "normal");

    await bus.drain();
    expect(order).toEqual(["high-agent", "normal-agent", "low-agent"]);
  });

  // ── Auto-Rules ──────────────────────────────────────────────────────────

  it("fires auto-rules when matching events are published", async () => {
    const fired: string[] = [];
    bus.addAutoRule({
      id: "rule-1",
      onEvent: "security_alert",
      handler: async () => { fired.push("security_alert"); },
    });

    await bus.publish(makeEvent("security_alert"), "urgent");
    expect(fired).toHaveLength(1);
  });

  it("does not fire auto-rules for non-matching events", async () => {
    const fired: string[] = [];
    bus.addAutoRule({
      id: "rule-1",
      onEvent: "security_alert",
      handler: async () => { fired.push("fired"); },
    });

    await bus.publish(makeEvent("info"), "urgent");
    expect(fired).toHaveLength(0);
  });

  it("removes auto-rules by ID", async () => {
    const fired: string[] = [];
    bus.addAutoRule({
      id: "rule-1",
      onEvent: "alert",
      handler: async () => { fired.push("fired"); },
    });
    bus.removeAutoRule("rule-1");

    await bus.publish(makeEvent("alert"), "urgent");
    expect(fired).toHaveLength(0);
  });

  it("addAutoRuleFromDefinition wires an AutoRule with a handler", async () => {
    const fired: string[] = [];
    bus.addAutoRuleFromDefinition(
      { id: "r1", onEvent: "deploy", condition: undefined, dispatchAction: "notify", attributedTo: "system" },
      async () => { fired.push("deploy-rule"); },
    );

    await bus.publish(makeEvent("deploy"), "urgent");
    expect(fired).toHaveLength(1);
  });

  // ── EventBus Backward Compatibility ─────────────────────────────────────

  it("forwards publish to underlying EventBus", async () => {
    eventBus.subscribe("agent-a", ["alert"]);
    const notified = await bus.publish(makeEvent("alert"), "urgent");
    expect(notified).toContain("agent-a");
  });

  it("getSubscribers delegates to EventBus", () => {
    eventBus.subscribe("agent-a", ["info"]);
    expect(bus.getSubscribers("info")).toContain("agent-a");
  });

  // ── Metrics ─────────────────────────────────────────────────────────────

  it("tracks total events processed", async () => {
    expect(bus.getEventsProcessedCount()).toBe(0);
    await bus.publish(makeEvent("a"), "urgent");
    await bus.publish(makeEvent("b"), "normal");
    expect(bus.getEventsProcessedCount()).toBe(2);
  });
});
