import { describe, it, expect, beforeEach } from "vitest";
import {
  V4Logger, setGlobalLogLevel, setGlobalLogSink, setModuleLogLevel,
  type LogEntry,
} from "../../src/observability/v4-logger.js";
import {
  V4Error, BusError, ReforgeError, MemoryError, SessionError,
  OrgGraphError, DelegationError, RegistryError, FlywheelError, StorageError,
} from "../../src/observability/v4-errors.js";
import { V4HealthCheck, type ModuleHealth } from "../../src/observability/v4-health.js";

// ─── V4Logger ──────────────────────────────────────────────────────────────

describe("V4Logger", () => {
  let captured: LogEntry[];
  let logger: V4Logger;

  beforeEach(() => {
    captured = [];
    setGlobalLogSink((entry) => captured.push(entry));
    setGlobalLogLevel("debug");
    logger = new V4Logger("TestModule");
  });

  it("logs with module prefix", () => {
    logger.info("Hello");
    expect(captured).toHaveLength(1);
    expect(captured[0].module).toBe("TestModule");
    expect(captured[0].message).toBe("Hello");
    expect(captured[0].level).toBe("info");
  });

  it("filters by global level", () => {
    setGlobalLogLevel("warn");
    logger.debug("ignored");
    logger.info("ignored");
    logger.warn("shown");
    logger.error("shown");
    expect(captured).toHaveLength(2);
  });

  it("supports per-module level override", () => {
    setGlobalLogLevel("error");
    setModuleLogLevel("TestModule", "debug");
    logger.debug("shown because module override");
    expect(captured).toHaveLength(1);
  });

  it("includes context when provided", () => {
    logger.info("Task done", { taskId: "t1", durationMs: 500 });
    expect(captured[0].context).toEqual({ taskId: "t1", durationMs: 500 });
  });

  it("includes ISO timestamp", () => {
    logger.info("test");
    expect(captured[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("all levels work", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(captured.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
  });
});

// ─── V4Error Hierarchy ─────────────────────────────────────────────────────

describe("V4Error", () => {
  it("creates base error with module and code", () => {
    const err = new V4Error("bus", "BUS.PUBLISH.FAILED", "Failed to publish", { topic: "test" });
    expect(err.module).toBe("bus");
    expect(err.code).toBe("BUS.PUBLISH.FAILED");
    expect(err.message).toBe("Failed to publish");
    expect(err.context).toEqual({ topic: "test" });
    expect(err).toBeInstanceOf(Error);
  });

  it("serializes to JSON", () => {
    const err = new V4Error("bus", "BUS.X", "msg", { a: 1 });
    const json = err.toJSON();
    expect(json.module).toBe("bus");
    expect(json.code).toBe("BUS.X");
  });

  it("subclasses set correct module prefix", () => {
    expect(new BusError("PUBLISH.FAILED", "x").code).toBe("BUS.PUBLISH.FAILED");
    expect(new ReforgeError("APPLY.FAILED", "x").code).toBe("REFORGE.APPLY.FAILED");
    expect(new MemoryError("NOT_FOUND", "x").code).toBe("MEMORY.NOT_FOUND");
    expect(new SessionError("EXPIRED", "x").code).toBe("SESSION.EXPIRED");
    expect(new OrgGraphError("CYCLE", "x").code).toBe("ORG.CYCLE");
    expect(new DelegationError("UNAUTHORIZED", "x").code).toBe("DELEGATION.UNAUTHORIZED");
    expect(new RegistryError("DUPLICATE", "x").code).toBe("REGISTRY.DUPLICATE");
    expect(new FlywheelError("NO_DATA", "x").code).toBe("FLYWHEEL.NO_DATA");
    expect(new StorageError("LIMIT_EXCEEDED", "x").code).toBe("STORAGE.LIMIT_EXCEEDED");
  });

  it("all subclasses are instanceof Error", () => {
    const errors = [
      new BusError("X", "x"), new ReforgeError("X", "x"),
      new MemoryError("X", "x"), new SessionError("X", "x"),
      new OrgGraphError("X", "x"), new DelegationError("X", "x"),
      new RegistryError("X", "x"), new FlywheelError("X", "x"),
      new StorageError("X", "x"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(V4Error);
    }
  });

  it("can be caught as Error (backward compatible)", () => {
    let caught = false;
    try { throw new BusError("TEST", "test"); }
    catch (e) { if (e instanceof Error) caught = true; }
    expect(caught).toBe(true);
  });
});

// ─── V4HealthCheck ──────────────────────────────────────────────────────────

describe("V4HealthCheck", () => {
  let health: V4HealthCheck;
  beforeEach(() => { health = new V4HealthCheck(); });

  it("returns allHealthy true when no probes", () => {
    const result = health.check();
    expect(result.allHealthy).toBe(true);
    expect(result.modules).toHaveLength(0);
  });

  it("aggregates probe results", () => {
    health.registerProbe(() => ({ module: "bus", healthy: true, metrics: { published: 100 } }));
    health.registerProbe(() => ({ module: "memory", healthy: true, metrics: { entries: 50 } }));
    const result = health.check();
    expect(result.allHealthy).toBe(true);
    expect(result.modules).toHaveLength(2);
  });

  it("allHealthy false when any probe unhealthy", () => {
    health.registerProbe(() => ({ module: "bus", healthy: true, metrics: {} }));
    health.registerProbe(() => ({ module: "memory", healthy: false, metrics: { errors: 3 } }));
    const result = health.check();
    expect(result.allHealthy).toBe(false);
  });

  it("includes timestamp", () => {
    const result = health.check();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
