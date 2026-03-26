import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusFileAdapter } from "../../src/communication/bus-file-adapter.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFilePath(dir: string): string {
  return join(dir, "bus-events.json");
}

function publishEvent(bus: V4MessageBus, topic = "agent.invoked", payload: unknown = { agentId: "cto" }) {
  return bus.publish({
    from: "invoke-command",
    to: "broadcast",
    topic,
    category: "status",
    payload,
    priority: "normal",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BusFileAdapter", () => {
  let dir: string;
  let filePath: string;
  let bus: V4MessageBus;
  let adapter: BusFileAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-bus-adapter-test-"));
    filePath = makeFilePath(dir);
    bus = new V4MessageBus();
    adapter = new BusFileAdapter(filePath);
  });

  afterEach(async () => {
    adapter.detach();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // load — empty state
  // -------------------------------------------------------------------------

  describe("load", () => {
    it("returns [] when file does not exist", async () => {
      const events = await adapter.load();
      expect(events).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // attach
  // -------------------------------------------------------------------------

  describe("attach", () => {
    it("buffers events published after attach", () => {
      adapter.attach(bus);
      publishEvent(bus);
      expect(adapter.pendingCount()).toBe(1);
    });

    it("does not buffer events published before attach", () => {
      publishEvent(bus);
      adapter.attach(bus);
      expect(adapter.pendingCount()).toBe(0);
    });

    it("buffers multiple events", () => {
      adapter.attach(bus);
      publishEvent(bus, "agent.invoked");
      publishEvent(bus, "agent.responded");
      publishEvent(bus, "agent.error");
      expect(adapter.pendingCount()).toBe(3);
    });

    it("re-attaching replaces the previous listener", () => {
      adapter.attach(bus);
      adapter.attach(bus); // second attach
      publishEvent(bus);
      // Should only count once (not doubled)
      expect(adapter.pendingCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // detach
  // -------------------------------------------------------------------------

  describe("detach", () => {
    it("stops buffering after detach", () => {
      adapter.attach(bus);
      publishEvent(bus);
      expect(adapter.pendingCount()).toBe(1);

      adapter.detach();
      publishEvent(bus);
      expect(adapter.pendingCount()).toBe(1); // unchanged
    });

    it("detach is safe to call when not attached", () => {
      expect(() => adapter.detach()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // flush
  // -------------------------------------------------------------------------

  describe("flush", () => {
    it("flush with no pending events writes nothing", async () => {
      adapter.attach(bus);
      await adapter.flush();
      const events = await adapter.load();
      expect(events).toEqual([]);
    });

    it("writes pending events to disk", async () => {
      adapter.attach(bus);
      publishEvent(bus, "agent.invoked", { agentId: "cto" });
      await adapter.flush();

      const events = await adapter.load();
      expect(events).toHaveLength(1);
      expect(events[0].topic).toBe("agent.invoked");
      expect(events[0].payload).toEqual({ agentId: "cto" });
    });

    it("clears pending queue after flush", async () => {
      adapter.attach(bus);
      publishEvent(bus);
      await adapter.flush();
      expect(adapter.pendingCount()).toBe(0);
    });

    it("merges with existing events on disk", async () => {
      adapter.attach(bus);
      publishEvent(bus, "agent.invoked");
      await adapter.flush();

      publishEvent(bus, "agent.responded");
      await adapter.flush();

      const events = await adapter.load();
      expect(events).toHaveLength(2);
      expect(events[0].topic).toBe("agent.invoked");
      expect(events[1].topic).toBe("agent.responded");
    });

    it("creates parent directories if missing", async () => {
      const deepPath = join(dir, "deep", "nested", "bus-events.json");
      const deepAdapter = new BusFileAdapter(deepPath);
      deepAdapter.attach(bus);
      publishEvent(bus);
      await deepAdapter.flush();

      const events = await deepAdapter.load();
      expect(events).toHaveLength(1);
      deepAdapter.detach();
    });

    it("preserves event fields: topic, payload, timestamp, priority, from, to, id", async () => {
      adapter.attach(bus);
      publishEvent(bus, "agent.invoked", { agentId: "architect" });
      await adapter.flush();

      const events = await adapter.load();
      const evt = events[0];
      expect(evt.topic).toBe("agent.invoked");
      expect(evt.payload).toEqual({ agentId: "architect" });
      expect(evt.timestamp).toBeTruthy();
      expect(evt.priority).toBe("normal");
      expect(evt.from).toBe("invoke-command");
      expect(evt.to).toBe("broadcast");
      expect(evt.id).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // rolling window (maxEvents)
  // -------------------------------------------------------------------------

  describe("rolling window", () => {
    it("keeps only the last maxEvents entries", async () => {
      const smallAdapter = new BusFileAdapter(filePath, 5);
      smallAdapter.attach(bus);

      for (let i = 0; i < 8; i++) {
        publishEvent(bus, `topic.${i}`);
      }
      await smallAdapter.flush();

      const events = await smallAdapter.load();
      expect(events).toHaveLength(5);
      // Should keep the last 5 (topics 3..7)
      expect(events[0].topic).toBe("topic.3");
      expect(events[4].topic).toBe("topic.7");
      smallAdapter.detach();
    });

    it("respects maxEvents across multiple flush calls", async () => {
      const smallAdapter = new BusFileAdapter(filePath, 3);
      smallAdapter.attach(bus);

      publishEvent(bus, "first");
      publishEvent(bus, "second");
      await smallAdapter.flush();

      publishEvent(bus, "third");
      publishEvent(bus, "fourth");
      await smallAdapter.flush();

      const events = await smallAdapter.load();
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.topic)).toEqual(["second", "third", "fourth"]);
      smallAdapter.detach();
    });

    it("default maxEvents is 500", async () => {
      const defaultAdapter = new BusFileAdapter(filePath);
      defaultAdapter.attach(bus);

      for (let i = 0; i < 10; i++) {
        publishEvent(bus, `t.${i}`);
      }
      await defaultAdapter.flush();

      const events = await defaultAdapter.load();
      expect(events).toHaveLength(10); // all kept, under 500 limit
      defaultAdapter.detach();
    });
  });

  // -------------------------------------------------------------------------
  // pendingCount
  // -------------------------------------------------------------------------

  describe("pendingCount", () => {
    it("starts at 0", () => {
      expect(adapter.pendingCount()).toBe(0);
    });

    it("increments per published message after attach", () => {
      adapter.attach(bus);
      publishEvent(bus);
      publishEvent(bus);
      expect(adapter.pendingCount()).toBe(2);
    });

    it("resets to 0 after flush", async () => {
      adapter.attach(bus);
      publishEvent(bus);
      await adapter.flush();
      expect(adapter.pendingCount()).toBe(0);
    });
  });
});
