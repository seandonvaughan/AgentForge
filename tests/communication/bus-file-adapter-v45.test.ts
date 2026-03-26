/**
 * Tests for BusFileAdapter v4.5 enhancements — P0-5
 *
 * Tests the new v4.5 additions: auto-flush, recover, loadSince, getEventCount.
 * The original BusFileAdapter tests are in bus-file-adapter.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BusFileAdapter } from "../../src/communication/bus-file-adapter.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("BusFileAdapter v4.5 enhancements", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bus-adapter-test-"));
    filePath = path.join(tmpDir, "data", "bus-events.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("getEventCount", () => {
    it("counts pending events", () => {
      const bus = new V4MessageBus();
      const adapter = new BusFileAdapter(filePath);
      adapter.attach(bus);

      bus.publish({
        from: "test",
        to: "broadcast",
        topic: "test.event",
        category: "status",
        payload: { data: 1 },
        priority: "normal",
      });

      expect(adapter.getEventCount()).toBe(1);
      adapter.detach();
    });

    it("starts at 0", () => {
      const adapter = new BusFileAdapter(filePath);
      expect(adapter.getEventCount()).toBe(0);
    });
  });

  describe("recover", () => {
    it("recovers events from disk", async () => {
      const bus = new V4MessageBus();
      const adapter1 = new BusFileAdapter(filePath);
      adapter1.attach(bus);

      bus.publish({
        from: "agent-1",
        to: "broadcast",
        topic: "test.event.1",
        category: "status",
        payload: { value: "hello" },
        priority: "normal",
      });

      bus.publish({
        from: "agent-2",
        to: "broadcast",
        topic: "test.event.2",
        category: "task",
        payload: { value: "world" },
        priority: "high",
      });

      await adapter1.flush();
      adapter1.detach();

      // Create a new adapter and recover
      const adapter2 = new BusFileAdapter(filePath);
      const count = await adapter2.recover();
      expect(count).toBe(2);
      expect(adapter2.getEventCount()).toBe(2);
    });

    it("returns 0 when no file exists", async () => {
      const adapter = new BusFileAdapter(path.join(tmpDir, "nonexistent.json"));
      const count = await adapter.recover();
      expect(count).toBe(0);
    });
  });

  describe("loadSince", () => {
    it("filters events by timestamp", async () => {
      const bus = new V4MessageBus();
      const adapter = new BusFileAdapter(filePath);
      adapter.attach(bus);

      // Publish events
      bus.publish({
        from: "test",
        to: "broadcast",
        topic: "old.event",
        category: "status",
        payload: {},
        priority: "normal",
      });

      // We cannot easily control timestamps in the bus, but we can verify
      // the function returns events and handles the filter
      await adapter.flush();
      adapter.detach();

      // Load since epoch — should get all events
      const allEvents = await adapter.loadSince("2000-01-01T00:00:00Z");
      expect(allEvents.length).toBeGreaterThanOrEqual(1);

      // Load since far future — should get no events
      const noEvents = await adapter.loadSince("2099-01-01T00:00:00Z");
      expect(noEvents).toHaveLength(0);
    });

    it("returns empty array when no file exists", async () => {
      const adapter = new BusFileAdapter(path.join(tmpDir, "nonexistent.json"));
      const events = await adapter.loadSince("2000-01-01T00:00:00Z");
      expect(events).toHaveLength(0);
    });
  });

  describe("setAutoFlush", () => {
    it("can toggle auto-flush mode", () => {
      const adapter = new BusFileAdapter(filePath);
      // Should not throw
      adapter.setAutoFlush(true);
      adapter.setAutoFlush(false);
    });
  });

  describe("auto-flush via constructor option", () => {
    it("accepts autoFlush option", () => {
      const adapter = new BusFileAdapter(filePath, 500, { autoFlush: true });
      // Should construct without error
      expect(adapter.getEventCount()).toBe(0);
    });
  });
});
